"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const server = require("../mcp/jdtls-mcp-server.cjs");

test("splitArgs supports POSIX-style quotes and escapes", () => {
  assert.deepEqual(
    server.splitArgs(String.raw`-Dname="hello world" 'single quoted' escaped\ value ""`),
    ["-Dname=hello world", "single quoted", "escaped value", ""],
  );
});

test("splitArgs rejects unterminated quotes", () => {
  assert.throws(() => server.splitArgs(`"unfinished`), /unterminated quote/i);
});

test("workspaceStateName avoids collisions for sanitized paths", () => {
  assert.notEqual(
    server.workspaceStateName("/tmp/project:a"),
    server.workspaceStateName("/tmp/project?a"),
  );
});

test("resolveWorkspaceFile rejects paths outside workspace", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "jdtls-root-"));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "jdtls-outside-"));
  const outsideFile = path.join(outside, "Outside.java");
  fs.writeFileSync(outsideFile, "class Outside {}\n");

  assert.throws(
    () => server.resolveWorkspaceFile(root, outsideFile),
    /must be inside workspaceRoot/,
  );
});

test("resolveWorkspaceFile rejects symlink escapes", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "jdtls-root-"));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "jdtls-outside-"));
  const outsideFile = path.join(outside, "Outside.java");
  const linkedFile = path.join(root, "Linked.java");
  fs.writeFileSync(outsideFile, "class Outside {}\n");
  fs.symlinkSync(outsideFile, linkedFile);

  assert.throws(
    () => server.resolveWorkspaceFile(root, linkedFile),
    /must be inside workspaceRoot/,
  );
});

test("JSON-RPC parser reports malformed input without throwing", () => {
  const errors = [];
  const parser = server.createJsonRpcParser(() => {}, (error) => errors.push(error));

  assert.doesNotThrow(() => {
    parser(Buffer.from("Broken: yes\r\n\r\n{}"));
  });
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /invalid json-rpc header/i);
});

test("JSON-RPC parser reports async handler failures", async () => {
  const errors = [];
  const parser = server.createJsonRpcParser(
    async () => {
      throw new Error("handler failed");
    },
    (error) => errors.push(error),
  );
  const payload = Buffer.from("{}");

  parser(Buffer.from(`Content-Length: ${payload.length}\r\n\r\n${payload}`));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /handler failed/);
});

test("server request handler answers workspace/configuration", async () => {
  const sent = [];
  const client = Object.create(server.LspClient.prototype);
  client.proc = { stdin: { write: (chunk) => sent.push(Buffer.from(chunk)) } };
  client.workspaceRoot = "/tmp/workspace";
  client.pending = new Map();

  client.handleMessage({
    jsonrpc: "2.0",
    id: 7,
    method: "workspace/configuration",
    params: { items: [{ section: "java" }, { section: "other" }] },
  });

  await new Promise((resolve) => setImmediate(resolve));
  const payload = Buffer.concat(sent).toString("utf8");
  assert.match(payload, /"id":7/);
  assert.match(payload, /"result":\[\{\},\{\}\]/);
});

test("syncDocument sends didChange when disk content changes", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "jdtls-root-"));
  const file = path.join(root, "Example.java");
  fs.writeFileSync(file, "class Example {}\n");

  const notifications = [];
  const client = Object.create(server.LspClient.prototype);
  client.workspaceRoot = root;
  client.ready = Promise.resolve();
  client.openDocs = new Map();
  client.notify = (method, params) => notifications.push({ method, params });

  await client.syncDocument(file);
  fs.writeFileSync(file, "class Example { int value; }\n");
  await client.syncDocument(file);

  assert.deepEqual(
    notifications.map(({ method }) => method),
    ["textDocument/didOpen", "textDocument/didChange"],
  );
  assert.equal(notifications[1].params.textDocument.version, 2);
});

function createClientDouble(overrides = {}) {
  const client = Object.create(server.LspClient.prototype);
  Object.assign(client, {
    workspaceRoot: "/tmp/workspace",
    state: "indexing",
    serviceReady: false,
    activeProgress: new Map(),
    firstQueryWaited: false,
    readyTimeoutMs: 20,
    lastStatus: null,
    readyWaiters: new Set(),
    ...overrides,
  });
  return client;
}

test("ServiceReady status moves client to ready when no progress is active", () => {
  const client = createClientDouble();

  client.handleNotification("language/status", {
    type: "ServiceReady",
    message: "ServiceReady",
  });

  assert.equal(client.state, "ready");
  assert.equal(client.serviceReady, true);
});

test("active progress keeps a ServiceReady client indexing until completion", () => {
  const client = createClientDouble();

  client.handleNotification("language/progressReport", {
    id: "import",
    task: "Importing Maven project(s)",
    complete: false,
  });
  client.handleNotification("language/status", {
    type: "ServiceReady",
    message: "ServiceReady",
  });
  assert.equal(client.state, "indexing");

  client.handleNotification("language/progressReport", {
    id: "import",
    task: "Importing Maven project(s)",
    complete: true,
  });
  assert.equal(client.state, "ready");
});

test("first semantic query waits for readiness and returns ready metadata", async () => {
  const client = createClientDouble({ readyTimeoutMs: 100 });
  const query = client.runSemanticQuery(async () => ["result"]);
  setImmediate(() => {
    client.handleNotification("language/status", {
      type: "ServiceReady",
      message: "ServiceReady",
    });
  });

  const result = await query;

  assert.deepEqual(result.data, ["result"]);
  assert.equal(result.meta.ready, true);
  assert.equal(result.meta.indexing, false);
  assert.equal(result.meta.waitTimedOut, false);
});

test("readiness timeout still runs query and only first query waits", async () => {
  const client = createClientDouble({ readyTimeoutMs: 10 });
  let calls = 0;

  const first = await client.runSemanticQuery(async () => {
    calls += 1;
    return ["first"];
  });
  const secondStarted = Date.now();
  const second = await client.runSemanticQuery(async () => {
    calls += 1;
    return ["second"];
  });

  assert.equal(calls, 2);
  assert.equal(first.meta.indexing, true);
  assert.equal(first.meta.waitTimedOut, true);
  assert.equal(second.meta.waitTimedOut, false);
  assert.ok(Date.now() - secondStarted < 10);
});

test("timed out LSP request sends cancel notification", async () => {
  const writes = [];
  const client = createClientDouble({
    nextId: 1,
    pending: new Map(),
    proc: { stdin: { write: (chunk) => writes.push(Buffer.from(chunk)) } },
  });

  await assert.rejects(
    client.request("workspace/symbol", { query: "Missing" }, 5),
    /timed out/,
  );

  const output = Buffer.concat(writes).toString("utf8");
  assert.match(output, /"\$\/cancelRequest"/);
  assert.match(output, /"params":\{"id":1\}/);
});

test("server request handler accepts work done progress creation", () => {
  const client = createClientDouble();

  assert.equal(
    client.handleServerRequest("window/workDoneProgress/create", { token: "import" }),
    null,
  );
});

test("server request handler returns current workspace folders", () => {
  const client = createClientDouble({ workspaceRoot: "/tmp/my-project" });

  assert.deepEqual(
    client.handleServerRequest("workspace/workspaceFolders", {}),
    [{
      uri: "file:///tmp/my-project",
      name: "my-project",
    }],
  );
});

test("publishDiagnostics updates and clears normalized diagnostics", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "jdtls-root-"));
  const file = path.join(root, "Example.java");
  fs.writeFileSync(file, "class Example {}\n");
  const client = createClientDouble({
    workspaceRoot: root,
    diagnostics: new Map(),
  });

  client.handleNotification("textDocument/publishDiagnostics", {
    uri: new URL(`file://${file}`).toString(),
    diagnostics: [{
      range: {
        start: { line: 0, character: 6 },
        end: { line: 0, character: 13 },
      },
      severity: 1,
      code: "123",
      source: "Java",
      message: "Example error",
    }],
  });

  assert.deepEqual(client.diagnosticsSnapshot(file), [{
    path: fs.realpathSync(file),
    range: "1:7-1:14",
    severity: 1,
    code: "123",
    source: "Java",
    message: "Example error",
  }]);

  client.handleNotification("textDocument/publishDiagnostics", {
    uri: new URL(`file://${file}`).toString(),
    diagnostics: [],
  });
  assert.deepEqual(client.diagnosticsSnapshot(file), []);
  assert.equal(client.diagnostics.size, 0);
});

test("diagnostics path must stay inside workspace", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "jdtls-root-"));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "jdtls-outside-"));
  const outsideFile = path.join(outside, "Outside.java");
  fs.writeFileSync(outsideFile, "class Outside {}\n");
  const client = createClientDouble({
    workspaceRoot: root,
    diagnostics: new Map(),
  });

  assert.throws(
    () => client.diagnosticsSnapshot(outsideFile),
    /must be inside workspaceRoot/,
  );
});

test("jdtls_status reports stopped workspace without creating session", async () => {
  server.sessions.clear();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "jdtls-root-"));

  const response = await server.callTool("jdtls_status", { workspaceRoot: root });
  const status = JSON.parse(response.content[0].text);

  assert.deepEqual(status, { running: false, workspaceRoot: root });
  assert.equal(server.sessions.size, 0);
});

test("idle expiration requires no pending requests", () => {
  const client = createClientDouble({
    lastActivityAt: 100,
    idleTimeoutMs: 50,
    pending: new Map(),
    closing: false,
  });

  assert.equal(client.isIdleExpired(151), true);
  client.pending.set(1, {});
  assert.equal(client.isIdleExpired(1000), false);
});

test("touch refreshes session activity", () => {
  const client = createClientDouble({ lastActivityAt: 100 });

  client.touch(250);

  assert.equal(client.lastActivityAt, 250);
});

test("idle reaper gracefully shuts down expired sessions", async () => {
  let shutdowns = 0;
  const sessionMap = new Map([
    ["/expired", {
      isIdleExpired: () => true,
      shutdown: async () => {
        shutdowns += 1;
      },
    }],
    ["/active", {
      isIdleExpired: () => false,
      shutdown: async () => {
        throw new Error("active session must not be shut down");
      },
    }],
  ]);

  await server.reapIdleSessions(sessionMap, 1000);

  assert.equal(shutdowns, 1);
  assert.equal(sessionMap.has("/expired"), false);
  assert.equal(sessionMap.has("/active"), true);
});
