"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const serverPath = path.resolve(__dirname, "../mcp/jdtls-mcp-server.cjs");
const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "jdtls-mcp-smoke-"));
const sourceDir = path.join(workspaceRoot, "src");
const filePath = path.join(sourceDir, "HelloService.java");
fs.mkdirSync(sourceDir);
fs.writeFileSync(filePath, "public class HelloService { public String hello() { return \"hi\"; } }\n");

const child = spawn(process.execPath, [serverPath], {
  stdio: ["pipe", "pipe", "inherit"],
  env: process.env,
});
let nextId = 1;
let buffer = Buffer.alloc(0);
const pending = new Map();

function send(method, params) {
  const id = nextId++;
  const payload = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
  child.stdin.write(`Content-Length: ${payload.length}\r\n\r\n`);
  child.stdin.write(payload);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`MCP request timed out: ${method}`));
    }, 90000);
    pending.set(id, { resolve, reject, timer });
  });
}

child.stdout.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  while (true) {
    const headerEnd = buffer.indexOf("\r\n\r\n");
    if (headerEnd < 0) return;
    const match = buffer.slice(0, headerEnd).toString("utf8").match(/Content-Length:\s*(\d+)/i);
    if (!match) throw new Error("invalid MCP response header");
    const start = headerEnd + 4;
    const end = start + Number(match[1]);
    if (buffer.length < end) return;
    const message = JSON.parse(buffer.slice(start, end).toString("utf8"));
    buffer = buffer.slice(end);
    const request = pending.get(message.id);
    if (!request) continue;
    clearTimeout(request.timer);
    pending.delete(message.id);
    if (message.error) request.reject(new Error(message.error.message));
    else request.resolve(message.result);
  }
});

(async () => {
  const initialized = await send("initialize", {});
  if (initialized.serverInfo.version !== "0.2.0") throw new Error("unexpected server version");

  const first = await send("tools/call", {
    name: "jdtls_document_symbol",
    arguments: { workspaceRoot, filePath },
  });
  if (!first.content[0].text.includes("hello")) throw new Error("initial symbol lookup failed");

  fs.writeFileSync(
    filePath,
    "public class HelloService { public String hello() { return \"hi\"; } public int count() { return 1; } }\n",
  );
  const second = await send("tools/call", {
    name: "jdtls_document_symbol",
    arguments: { workspaceRoot, filePath },
  });
  if (!second.content[0].text.includes("count")) throw new Error("didChange synchronization failed");

  await send("tools/call", {
    name: "jdtls_shutdown",
    arguments: { workspaceRoot },
  });
  child.stdin.end();
  console.log("real JDT.LS smoke test passed");
})().catch((error) => {
  console.error(error.stack || error.message);
  child.kill("SIGTERM");
  process.exitCode = 1;
});
