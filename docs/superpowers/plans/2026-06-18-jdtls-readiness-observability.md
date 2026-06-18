# JDT.LS Readiness And Observability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add bounded readiness waiting, status and diagnostics tools, request cancellation, and idle session cleanup to the JDT.LS MCP wrapper.

**Architecture:** Extend `LspClient` with an event-driven state machine fed by JDT.LS status, progress, and diagnostics notifications. Keep the existing single-process MCP server and session map, but route semantic calls through a shared query wrapper that performs the one-time readiness wait and attaches metadata.

**Tech Stack:** Node.js CommonJS, Node built-in test runner, JSON-RPC/LSP over stdio, Eclipse JDT.LS.

---

### Task 1: Readiness State And Query Metadata

**Files:**
- Modify: `mcp/jdtls-mcp-server.cjs`
- Test: `test/jdtls-mcp-server.test.cjs`

- [ ] Add failing tests that construct an `LspClient` test double and verify:
  - `language/status` with `ServiceReady` changes state from `indexing` to `ready`
  - active progress keeps state at `indexing`
  - the first query waits until readiness
  - a short readiness timeout returns `{ indexing: true, waitTimedOut: true }`
  - a second query does not repeat the wait
- [ ] Run `node --test test/jdtls-mcp-server.test.cjs` and confirm the new tests fail because readiness methods do not exist.
- [ ] Add `state`, `serviceReady`, `activeProgress`, `firstQueryWaited`, `readyTimeoutMs`, status tracking, `waitForReadiness()`, `queryMeta()`, and `runSemanticQuery()`.
- [ ] Handle `language/status`, `language/progressReport`, and `$/progress` notifications in `handleMessage()`.
- [ ] Wrap all semantic tools so JSON output is `{ data, meta }`.
- [ ] Run the unit suite and confirm all readiness tests pass.
- [ ] Commit with `git commit -m "feat: add bounded JDTLS readiness waiting"`.

### Task 2: Cancellation And Additional Client Requests

**Files:**
- Modify: `mcp/jdtls-mcp-server.cjs`
- Test: `test/jdtls-mcp-server.test.cjs`

- [ ] Add failing tests proving request timeout emits `$/cancelRequest` with the timed-out request ID.
- [ ] Add failing tests for `window/workDoneProgress/create` and `workspace/workspaceFolders`.
- [ ] Run the unit suite and verify the tests fail for the intended missing behavior.
- [ ] Send cancellation before rejecting timed-out requests.
- [ ] Return `null` for progress creation and the current folder for workspace-folder requests.
- [ ] Run the full unit suite.
- [ ] Commit with `git commit -m "feat: cancel timed out LSP requests"`.

### Task 3: Status And Diagnostics Tools

**Files:**
- Modify: `mcp/jdtls-mcp-server.cjs`
- Test: `test/jdtls-mcp-server.test.cjs`

- [ ] Add failing tests for diagnostics cache update, empty-array clearing, normalized output, and path validation.
- [ ] Add a failing test proving `jdtls_status` does not create a session when none exists.
- [ ] Add diagnostics storage fed by `textDocument/publishDiagnostics`.
- [ ] Add `statusSnapshot()` and normalized diagnostic conversion.
- [ ] Register `jdtls_status` and `jdtls_diagnostics` schemas and call routing.
- [ ] Run the full unit suite.
- [ ] Commit with `git commit -m "feat: expose JDTLS status and diagnostics"`.

### Task 4: Idle Session Cleanup

**Files:**
- Modify: `mcp/jdtls-mcp-server.cjs`
- Test: `test/jdtls-mcp-server.test.cjs`

- [ ] Add failing tests for idle eligibility, pending-request protection, and activity refresh.
- [ ] Add `lastActivityAt`, `idleTimeoutMs`, `touch()`, and `isIdleExpired()`.
- [ ] Add an unreferenced cleanup interval that gracefully shuts down expired sessions.
- [ ] Clear the cleanup interval during MCP shutdown.
- [ ] Run the full unit suite.
- [ ] Commit with `git commit -m "feat: reap idle JDTLS sessions"`.

### Task 5: Version, Documentation, And Real Verification

**Files:**
- Modify: `.codex-plugin/plugin.json`
- Modify: `mcp/jdtls-mcp-server.cjs`
- Modify: `README.md`
- Modify: `skills/jdtls-mcp-wrapper/SKILL.md`
- Modify: `test/real-jdtls-smoke.cjs`

- [ ] Update the real smoke test to assert version `0.3.0`, `{ data, meta }`, `jdtls_status`, and `jdtls_diagnostics`.
- [ ] Update plugin and MCP server versions to `0.3.0`.
- [ ] Document the two new tools and `JDTLS_MCP_READY_TIMEOUT_MS` / `JDTLS_MCP_IDLE_TIMEOUT_MS`.
- [ ] Run `node --check mcp/jdtls-mcp-server.cjs`.
- [ ] Run `node --test test/jdtls-mcp-server.test.cjs`.
- [ ] Run `node test/real-jdtls-smoke.cjs`.
- [ ] Run `git diff --check` and inspect `git status --short`.
- [ ] Commit with `git commit -m "release: prepare jdtls MCP wrapper 0.3.0"`.
- [ ] Push the feature branch, merge to `main`, push `main`, refresh the Codex plugin installation, and verify installed version `0.3.0`.
