# JDT.LS Readiness And Observability Design

## Goal

Improve the MCP wrapper for large Java projects without making semantic
navigation block indefinitely. The first semantic query waits for JDT.LS
readiness for at most 30 seconds. If readiness is not reached, the query still
runs and returns its current result with explicit indexing metadata.

The same release adds diagnostics, status inspection, timed-out request
cancellation, and idle session cleanup.

## Scope

This change covers:

- readiness and indexing state tracking
- bounded first-query waiting
- result metadata
- status and diagnostics MCP tools
- LSP request cancellation after timeout
- idle session shutdown

It does not add filesystem watchers, editing tools, rename operations, or
configuration mutation.

## Readiness Model

Each `LspClient` tracks these states:

- `starting`: the `initialize` exchange has not completed
- `indexing`: initialization completed, but JDT.LS has not reported
  `ServiceReady`, or active progress tasks remain
- `ready`: JDT.LS reported `language/status` with type `ServiceReady` and no
  progress task is active
- `closing`: graceful shutdown has started
- `stopped`: the JDT.LS process exited
- `error`: startup or process failure occurred

The wrapper listens to:

- `language/status`
- `language/progressReport`
- `window/workDoneProgress/create`
- `$/progress`
- `textDocument/publishDiagnostics`

`ServiceReady` is the authoritative signal that initial project import reached
the JDT.LS readiness point. Progress reports refine whether background work is
still active. Unknown progress messages are retained for status reporting but
do not crash the process.

## Query Waiting

Only the first semantic query in a session performs the readiness wait.
Semantic queries are workspace symbols, document symbols, definition,
implementation, and references.

The wait timeout defaults to 30,000 milliseconds and is configurable through
`JDTLS_MCP_READY_TIMEOUT_MS`.

The wait ends when:

- state becomes `ready`
- JDT.LS exits or enters `error`
- 30 seconds elapse

On timeout, the wrapper immediately sends the requested LSP operation. A
readiness timeout is not returned as an MCP error.

Subsequent queries do not repeat the 30-second wait. Their metadata reflects
the current state at the time of the response.

## Result Compatibility

Tool results remain JSON text inside the existing MCP text content block.
Navigation data moves under `data`, and all semantic query tools include a
`meta` object:

```json
{
  "data": [],
  "meta": {
    "state": "indexing",
    "indexing": true,
    "ready": false,
    "waitTimedOut": true,
    "waitedMs": 30000,
    "activeTasks": []
  }
}
```

`waitTimedOut` is true only for the query that exhausted its readiness wait.
`indexing` is true for `starting` and `indexing`.

This is a versioned response-shape change and requires a plugin minor-version
increment.

## Status Tool

Add `jdtls_status`.

Input:

```json
{
  "workspaceRoot": "/absolute/project/path"
}
```

The tool does not create a session. It reports either:

- `{ "running": false, "workspaceRoot": "..." }`
- current process and language-server state

Running status includes:

- wrapper state
- `ready` and `indexing`
- process ID
- uptime in milliseconds
- last JDT.LS status
- active progress tasks
- pending request count
- open document count
- diagnostics file count and issue count
- last activity timestamp
- configured readiness and idle timeouts

## Diagnostics Tool

Add `jdtls_diagnostics`.

Input:

```json
{
  "workspaceRoot": "/absolute/project/path",
  "filePath": "/absolute/project/path/src/Foo.java"
}
```

`filePath` is optional. When supplied, it must resolve inside `workspaceRoot`.

The client caches the latest full diagnostics array from every
`textDocument/publishDiagnostics` notification. An empty diagnostics array
clears the file's cached issues. The tool returns normalized paths, 1-based
ranges, severity, code, source, and message.

The diagnostics tool creates a session when none exists, waits under the same
first-query readiness policy, and includes the same metadata shape.

## Request Cancellation

When an LSP request exceeds its request timeout:

1. remove it from the pending map
2. send `$/cancelRequest` with the original numeric request ID
3. reject the local request with the existing timeout error

Late responses are ignored because their request ID is no longer pending.
Shutdown timeout handling remains separate and may terminate the process.

## Idle Session Cleanup

Each session records activity when:

- an MCP tool obtains the session
- a query starts or completes
- a document is synchronized

An interval checks sessions for inactivity. The default idle timeout is
600,000 milliseconds and is configurable through
`JDTLS_MCP_IDLE_TIMEOUT_MS`.

If a session has no pending requests and has been idle past the timeout, the
wrapper performs the existing graceful shutdown. A session with active
requests is never reaped.

The cleanup timer must use `unref()` so it does not keep the MCP process alive.
The timer is cleared during server shutdown.

## Server Requests

In addition to existing handling, the wrapper responds to:

- `window/workDoneProgress/create` with `null`
- `workspace/workspaceFolders` with the current workspace folder

Existing read-only handling for `workspace/applyEdit` remains unchanged.

## Error Handling

- Unknown notifications are ignored.
- Unknown JDT.LS requests receive a JSON-RPC error response.
- Malformed status, progress, or diagnostic payloads are logged and ignored.
- A JDT.LS process error transitions the session to `error` and rejects
  pending operations.
- `jdtls_status` remains available for stopped sessions only while the session
  object is still registered; process exit removes it from the session map.

## Testing

Unit tests cover:

- `ServiceReady` and progress state transitions
- first-query wait success and 30-second timeout behavior using short injected
  timeouts
- metadata for ready and indexing responses
- status tool without creating a session
- diagnostic cache update and clear behavior
- diagnostics path validation
- `$/cancelRequest` after timeout
- idle cleanup eligibility and active-request protection
- new JDT.LS server request responses

The real JDT.LS smoke test covers:

- startup and readiness observation
- semantic query response metadata
- diagnostics tool response shape
- graceful shutdown

## Version And Documentation

Release version becomes `0.3.0`.

Update:

- `.codex-plugin/plugin.json`
- MCP `serverInfo.version`
- `README.md`
- `skills/jdtls-mcp-wrapper/SKILL.md`

The marketplace source remains the Git repository. Codex installation cache is
refreshed only after tests pass.
