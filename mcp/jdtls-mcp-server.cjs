#!/usr/bin/env node
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");
const { pathToFileURL, fileURLToPath } = require("url");

const DEFAULT_TIMEOUT_MS = Number(process.env.JDTLS_MCP_TIMEOUT_MS || 20000);
const sessions = new Map();

function log(message) {
  process.stderr.write(`[jdtls-mcp] ${message}\n`);
}

function normalizePath(inputPath) {
  if (!inputPath || typeof inputPath !== "string") {
    throw new Error("path is required");
  }
  return path.resolve(inputPath);
}

function uriFromPath(filePath) {
  return pathToFileURL(normalizePath(filePath)).toString();
}

function pathFromUri(uri) {
  if (!uri) return "";
  if (uri.startsWith("file://")) return fileURLToPath(uri);
  return uri;
}

function createJsonRpcParser(onMessage, onError = (error) => log(error.stack || error.message)) {
  let buffer = Buffer.alloc(0);
  return (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (true) {
      const headerEnd = buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) return;

      const header = buffer.slice(0, headerEnd).toString("utf8");
      const lengthMatch = header.match(/Content-Length:\s*(\d+)/i);
      if (!lengthMatch) {
        buffer = buffer.slice(headerEnd + 4);
        onError(new Error(`Invalid JSON-RPC header: ${header}`));
        continue;
      }

      const contentLength = Number(lengthMatch[1]);
      if (!Number.isSafeInteger(contentLength) || contentLength < 0) {
        buffer = buffer.slice(headerEnd + 4);
        onError(new Error(`Invalid JSON-RPC Content-Length: ${lengthMatch[1]}`));
        continue;
      }
      const messageStart = headerEnd + 4;
      const messageEnd = messageStart + contentLength;
      if (buffer.length < messageEnd) return;

      const payload = buffer.slice(messageStart, messageEnd).toString("utf8");
      buffer = buffer.slice(messageEnd);
      try {
        Promise.resolve(onMessage(JSON.parse(payload))).catch(onError);
      } catch (error) {
        onError(new Error(`Invalid JSON-RPC payload: ${error.message}`));
      }
    }
  };
}

function readJsonRpcMessages(stream, onMessage, onError) {
  stream.on("data", createJsonRpcParser(onMessage, onError));
}

function writeJsonRpc(stream, message) {
  const payload = Buffer.from(JSON.stringify(message), "utf8");
  stream.write(`Content-Length: ${payload.length}\r\n\r\n`);
  stream.write(payload);
}

class LspClient {
  constructor(workspaceRoot) {
    this.workspaceRoot = normalizePath(workspaceRoot);
    this.nextId = 1;
    this.pending = new Map();
    this.openDocs = new Map();
    this.closing = false;

    const safeName = workspaceStateName(this.workspaceRoot);
    const baseDir = process.env.JDTLS_MCP_STATE_DIR || path.join(os.tmpdir(), "jdtls-mcp");
    const configDir = process.env.JDTLS_CONFIG_DIR || path.join(baseDir, "config", safeName);
    const dataDir = process.env.JDTLS_WORKSPACE_DIR || path.join(baseDir, safeName);
    fs.mkdirSync(configDir, { recursive: true });
    fs.mkdirSync(dataDir, { recursive: true });

    const command = process.env.JDTLS_CMD || "jdtls";
    const extraArgs = process.env.JDTLS_ARGS ? splitArgs(process.env.JDTLS_ARGS) : [];
    const args = [...extraArgs, "-configuration", configDir, "-data", dataDir];

    this.proc = spawn(command, args, {
      cwd: this.workspaceRoot,
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });

    this.proc.stderr.on("data", (chunk) => log(chunk.toString("utf8").trimEnd()));
    this.proc.on("error", (error) => {
      this.rejectPending(new Error(`failed to start jdtls: ${error.message}`));
    });
    this.proc.on("exit", (code, signal) => {
      const reason = signal ? `signal ${signal}` : `code ${code}`;
      this.rejectPending(new Error(`jdtls exited with ${reason}`));
      sessions.delete(this.workspaceRoot);
      log(`jdtls exited for ${this.workspaceRoot}: ${reason}`);
    });

    readJsonRpcMessages(
      this.proc.stdout,
      (message) => this.handleMessage(message),
      (error) => log(`discarding malformed JDT.LS message: ${error.message}`),
    );
    this.ready = this.initialize();
  }

  rejectPending(error) {
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(error);
    }
    this.pending.clear();
  }

  handleMessage(message) {
    if (Object.prototype.hasOwnProperty.call(message, "id") && this.pending.has(message.id)) {
      const { resolve, reject, timer } = this.pending.get(message.id);
      this.pending.delete(message.id);
      clearTimeout(timer);
      if (message.error) {
        reject(new Error(message.error.message || JSON.stringify(message.error)));
      } else {
        resolve(message.result);
      }
      return;
    }

    if (Object.prototype.hasOwnProperty.call(message, "id") && message.method) {
      Promise.resolve(this.handleServerRequest(message.method, message.params))
        .then((result) => {
          writeJsonRpc(this.proc.stdin, { jsonrpc: "2.0", id: message.id, result });
        })
        .catch((error) => {
          writeJsonRpc(this.proc.stdin, {
            jsonrpc: "2.0",
            id: message.id,
            error: { code: -32603, message: error.message },
          });
        });
    }
  }

  handleServerRequest(method, params) {
    if (method === "workspace/configuration") {
      return (params?.items || []).map(() => ({}));
    }
    if (method === "client/registerCapability" || method === "client/unregisterCapability") {
      return null;
    }
    if (method === "workspace/applyEdit") {
      return { applied: false, failureReason: "jdtls-mcp-wrapper is read-only" };
    }
    throw new Error(`Unsupported JDT.LS request: ${method}`);
  }

  request(method, params, timeoutMs = DEFAULT_TIMEOUT_MS) {
    const id = this.nextId++;
    const message = { jsonrpc: "2.0", id, method, params };
    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`LSP request timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
    });
    writeJsonRpc(this.proc.stdin, message);
    return promise;
  }

  notify(method, params) {
    writeJsonRpc(this.proc.stdin, { jsonrpc: "2.0", method, params });
  }

  async initialize() {
    const rootUri = uriFromPath(this.workspaceRoot);
    await this.request("initialize", {
      processId: process.pid,
      rootPath: this.workspaceRoot,
      rootUri,
      workspaceFolders: [{ uri: rootUri, name: path.basename(this.workspaceRoot) }],
      capabilities: {
        workspace: {
          workspaceFolders: true,
          symbol: { dynamicRegistration: false },
        },
        textDocument: {
          definition: { dynamicRegistration: false, linkSupport: true },
          implementation: { dynamicRegistration: false, linkSupport: true },
          references: { dynamicRegistration: false },
          documentSymbol: {
            dynamicRegistration: false,
            hierarchicalDocumentSymbolSupport: true,
          },
        },
      },
      initializationOptions: {},
      trace: "off",
    }, Number(process.env.JDTLS_MCP_INIT_TIMEOUT_MS || 60000));
    this.notify("initialized", {});
  }

  async syncDocument(filePath) {
    await this.ready;
    const absolutePath = resolveWorkspaceFile(this.workspaceRoot, filePath);
    const uri = uriFromPath(absolutePath);
    const text = fs.readFileSync(absolutePath, "utf8");
    const document = this.openDocs.get(uri);
    if (document) {
      if (document.text !== text) {
        const version = document.version + 1;
        this.notify("textDocument/didChange", {
          textDocument: { uri, version },
          contentChanges: [{ text }],
        });
        this.openDocs.set(uri, { version, text });
      }
      return uri;
    }
    this.notify("textDocument/didOpen", {
      textDocument: {
        uri,
        languageId: "java",
        version: 1,
        text,
      },
    });
    this.openDocs.set(uri, { version: 1, text });
    return uri;
  }

  async workspaceSymbol(query) {
    await this.ready;
    return this.request("workspace/symbol", { query: query || "" });
  }

  async documentSymbol(filePath) {
    const uri = await this.syncDocument(filePath);
    return this.request("textDocument/documentSymbol", { textDocument: { uri } });
  }

  async positionRequest(method, filePath, line, character, extraParams = {}) {
    const uri = await this.syncDocument(filePath);
    return this.request(method, {
      textDocument: { uri },
      position: {
        line: toZeroBased(line, "line"),
        character: toZeroBased(character, "character"),
      },
      ...extraParams,
    });
  }

  async shutdown() {
    if (this.closing) return;
    this.closing = true;
    try {
      await this.ready;
      await this.request("shutdown", {}, 3000);
      this.notify("exit", {});
      await waitForExit(this.proc, 3000);
    } catch (error) {
      log(`graceful shutdown failed for ${this.workspaceRoot}: ${error.message}`);
      if (this.proc.exitCode === null && this.proc.signalCode === null) {
        this.proc.kill("SIGTERM");
        try {
          await waitForExit(this.proc, 1000);
        } catch {
          this.proc.kill("SIGKILL");
        }
      }
    }
  }
}

function splitArgs(value) {
  const args = [];
  let current = "";
  let quote = null;
  let escaping = false;
  let started = false;

  for (const char of value) {
    if (escaping) {
      current += char;
      escaping = false;
      started = true;
    } else if (char === "\\" && quote !== "'") {
      escaping = true;
      started = true;
    } else if (quote) {
      if (char === quote) quote = null;
      else current += char;
      started = true;
    } else if (char === "'" || char === "\"") {
      quote = char;
      started = true;
    } else if (/\s/.test(char)) {
      if (started) {
        args.push(current);
        current = "";
        started = false;
      }
    } else {
      current += char;
      started = true;
    }
  }

  if (escaping) throw new Error("JDTLS_ARGS ends with an incomplete escape");
  if (quote) throw new Error("JDTLS_ARGS contains an unterminated quote");
  if (started) args.push(current);
  return args;
}

function workspaceStateName(workspaceRoot) {
  const base = path.basename(workspaceRoot).replace(/[^a-zA-Z0-9_.-]/g, "_") || "workspace";
  const hash = crypto.createHash("sha256").update(workspaceRoot).digest("hex").slice(0, 16);
  return `${base}-${hash}`;
}

function resolveWorkspaceFile(workspaceRoot, filePath) {
  const root = fs.realpathSync(normalizePath(workspaceRoot));
  const file = fs.realpathSync(normalizePath(filePath));
  const relative = path.relative(root, file);
  if (relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))) {
    return file;
  }
  throw new Error(`filePath must be inside workspaceRoot: ${file}`);
}

function waitForExit(proc, timeoutMs) {
  if (proc.exitCode !== null || proc.signalCode !== null) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      proc.off("exit", onExit);
      reject(new Error("timed out waiting for jdtls to exit"));
    }, timeoutMs);
    const onExit = () => {
      clearTimeout(timer);
      resolve();
    };
    proc.once("exit", onExit);
  });
}

function toZeroBased(value, fieldName) {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${fieldName} must be a 1-based positive integer`);
  }
  return value - 1;
}

function getSession(workspaceRoot) {
  const root = normalizePath(workspaceRoot);
  if (!sessions.has(root)) {
    sessions.set(root, new LspClient(root));
  }
  return sessions.get(root);
}

function rangeToText(range) {
  if (!range) return "";
  const startLine = range.start.line + 1;
  const startChar = range.start.character + 1;
  const endLine = range.end.line + 1;
  const endChar = range.end.character + 1;
  return `${startLine}:${startChar}-${endLine}:${endChar}`;
}

function simplifyLocation(item) {
  if (!item) return item;
  if (item.targetUri) {
    return {
      path: pathFromUri(item.targetUri),
      range: rangeToText(item.targetRange),
      selectionRange: rangeToText(item.targetSelectionRange),
    };
  }
  if (item.uri) {
    return {
      path: pathFromUri(item.uri),
      range: rangeToText(item.range),
    };
  }
  if (item.location) {
    return {
      name: item.name,
      kind: item.kind,
      path: pathFromUri(item.location.uri),
      range: rangeToText(item.location.range),
      containerName: item.containerName,
    };
  }
  return item;
}

function simplifyDocumentSymbol(symbol) {
  if (!symbol) return symbol;
  const base = {
    name: symbol.name,
    detail: symbol.detail,
    kind: symbol.kind,
    range: rangeToText(symbol.range),
    selectionRange: rangeToText(symbol.selectionRange),
  };
  if (Array.isArray(symbol.children) && symbol.children.length > 0) {
    base.children = symbol.children.map(simplifyDocumentSymbol);
  }
  return base;
}

function formatResult(value) {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(value, null, 2),
      },
    ],
  };
}

function toolSchema(properties, required) {
  return {
    type: "object",
    properties,
    required,
    additionalProperties: false,
  };
}

const tools = [
  {
    name: "jdtls_workspace_symbol",
    description: "Search Java symbols in a workspace using Eclipse JDT.LS.",
    inputSchema: toolSchema({
      workspaceRoot: { type: "string", description: "Absolute project root path." },
      query: { type: "string", description: "Symbol query, such as a class or method name." },
    }, ["workspaceRoot", "query"]),
  },
  {
    name: "jdtls_document_symbol",
    description: "List symbols declared in one Java file.",
    inputSchema: toolSchema({
      workspaceRoot: { type: "string", description: "Absolute project root path." },
      filePath: { type: "string", description: "Absolute Java file path." },
    }, ["workspaceRoot", "filePath"]),
  },
  {
    name: "jdtls_definition",
    description: "Jump from a Java source position to its definition.",
    inputSchema: toolSchema({
      workspaceRoot: { type: "string", description: "Absolute project root path." },
      filePath: { type: "string", description: "Absolute Java file path." },
      line: { type: "integer", description: "1-based line number." },
      character: { type: "integer", description: "1-based character/column number." },
    }, ["workspaceRoot", "filePath", "line", "character"]),
  },
  {
    name: "jdtls_implementation",
    description: "Find implementations for the symbol at a Java source position.",
    inputSchema: toolSchema({
      workspaceRoot: { type: "string", description: "Absolute project root path." },
      filePath: { type: "string", description: "Absolute Java file path." },
      line: { type: "integer", description: "1-based line number." },
      character: { type: "integer", description: "1-based character/column number." },
    }, ["workspaceRoot", "filePath", "line", "character"]),
  },
  {
    name: "jdtls_references",
    description: "Find references for the symbol at a Java source position.",
    inputSchema: toolSchema({
      workspaceRoot: { type: "string", description: "Absolute project root path." },
      filePath: { type: "string", description: "Absolute Java file path." },
      line: { type: "integer", description: "1-based line number." },
      character: { type: "integer", description: "1-based character/column number." },
      includeDeclaration: { type: "boolean", description: "Whether to include the declaration.", default: false },
    }, ["workspaceRoot", "filePath", "line", "character"]),
  },
  {
    name: "jdtls_shutdown",
    description: "Shutdown a cached JDT.LS session for a workspace.",
    inputSchema: toolSchema({
      workspaceRoot: { type: "string", description: "Absolute project root path." },
    }, ["workspaceRoot"]),
  },
];

async function callTool(name, args) {
  if (name === "jdtls_workspace_symbol") {
    const result = await getSession(args.workspaceRoot).workspaceSymbol(args.query);
    return formatResult((result || []).map(simplifyLocation));
  }
  if (name === "jdtls_document_symbol") {
    const result = await getSession(args.workspaceRoot).documentSymbol(args.filePath);
    return formatResult((result || []).map(simplifyDocumentSymbol));
  }
  if (name === "jdtls_definition") {
    const result = await getSession(args.workspaceRoot).positionRequest(
      "textDocument/definition",
      args.filePath,
      args.line,
      args.character,
    );
    return formatResult((Array.isArray(result) ? result : [result]).filter(Boolean).map(simplifyLocation));
  }
  if (name === "jdtls_implementation") {
    const result = await getSession(args.workspaceRoot).positionRequest(
      "textDocument/implementation",
      args.filePath,
      args.line,
      args.character,
    );
    return formatResult((Array.isArray(result) ? result : [result]).filter(Boolean).map(simplifyLocation));
  }
  if (name === "jdtls_references") {
    const result = await getSession(args.workspaceRoot).positionRequest(
      "textDocument/references",
      args.filePath,
      args.line,
      args.character,
      { context: { includeDeclaration: Boolean(args.includeDeclaration) } },
    );
    return formatResult((result || []).map(simplifyLocation));
  }
  if (name === "jdtls_shutdown") {
    const root = normalizePath(args.workspaceRoot);
    if (sessions.has(root)) {
      await sessions.get(root).shutdown();
      sessions.delete(root);
    }
    return formatResult({ shutdown: root });
  }
  throw new Error(`Unknown tool: ${name}`);
}

async function handleMcp(message) {
  if (!Object.prototype.hasOwnProperty.call(message, "id")) return;
  try {
    if (message.method === "initialize") {
      return {
        jsonrpc: "2.0",
        id: message.id,
        result: {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "jdtls-mcp-wrapper", version: "0.2.0" },
        },
      };
    }
    if (message.method === "tools/list") {
      return { jsonrpc: "2.0", id: message.id, result: { tools } };
    }
    if (message.method === "tools/call") {
      const params = message.params || {};
      const result = await callTool(params.name, params.arguments || {});
      return { jsonrpc: "2.0", id: message.id, result };
    }
    return {
      jsonrpc: "2.0",
      id: message.id,
      error: { code: -32601, message: `Method not found: ${message.method}` },
    };
  } catch (error) {
    return {
      jsonrpc: "2.0",
      id: message.id,
      error: { code: -32000, message: error.message, data: error.stack },
    };
  }
}

async function shutdownAll(exitCode) {
  await Promise.allSettled([...sessions.values()].map((session) => session.shutdown()));
  process.exit(exitCode);
}

function main() {
  readJsonRpcMessages(
    process.stdin,
    async (message) => {
      const response = await handleMcp(message);
      if (response) writeJsonRpc(process.stdout, response);
    },
    (error) => log(`discarding malformed MCP message: ${error.message}`),
  );

  process.once("SIGINT", () => {
    shutdownAll(130);
  });
  process.once("SIGTERM", () => {
    shutdownAll(143);
  });
  process.once("beforeExit", async () => {
    await Promise.allSettled([...sessions.values()].map((session) => session.shutdown()));
  });
}

module.exports = {
  LspClient,
  createJsonRpcParser,
  resolveWorkspaceFile,
  splitArgs,
  workspaceStateName,
};

if (require.main === module) {
  main();
}
