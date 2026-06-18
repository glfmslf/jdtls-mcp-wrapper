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
