# JDTLS MCP Wrapper

Codex 插件原型：通过 MCP stdio server 启动 Eclipse JDT.LS，并把 Java LSP 导航能力暴露为工具。

## 功能

- `jdtls_workspace_symbol`：按名称搜索 workspace 符号
- `jdtls_document_symbol`：列出单个 Java 文件里的符号
- `jdtls_definition`：从指定位置跳到定义
- `jdtls_implementation`：查实现
- `jdtls_references`：查引用
- `jdtls_status`：查看会话、索引、进度、请求和诊断状态，不会启动新会话
- `jdtls_diagnostics`：读取工作区或单文件的 Java 诊断
- `jdtls_shutdown`：关闭某个 workspace 的 jdtls session

语义查询返回：

```json
{
  "data": [],
  "meta": {
    "state": "ready",
    "indexing": false,
    "ready": true,
    "waitTimedOut": false,
    "waitedMs": 1200,
    "activeTasks": []
  }
}
```

首次语义查询最多等待 JDT.LS 就绪 30 秒。超时后仍返回当前查询结果，并通过
`meta.indexing` 和 `meta.waitTimedOut` 标明状态。

## 依赖

- Node.js
- `jdtls`
- JDK 17+，建议 JDK 21

当前机器上如果已有 `/Users/yuyou/bin/jdtls` wrapper，并且它会切到 JDK 21，可以直接使用。

## Codex 插件结构

```text
jdtls-mcp-wrapper/
  .codex-plugin/plugin.json
  .mcp.json
  mcp/jdtls-mcp-server.cjs
  skills/jdtls-mcp-wrapper/SKILL.md
```

## 手动运行自检

```bash
node mcp/jdtls-mcp-server.cjs
```

该命令会等待 MCP JSON-RPC 输入，不会主动打印普通日志。真正自检建议通过 MCP client 或安装到 Codex 后调用工具。

回归测试：

```bash
node --test test/jdtls-mcp-server.test.cjs
```

## 稳健性

- Java 文件修改后自动发送 `textDocument/didChange`
- 响应 JDT.LS 发起的 `workspace/configuration` 等客户端请求
- JSON-RPC 异常帧只记录并丢弃，不会让 MCP 进程崩溃
- `filePath` 必须真实解析在 `workspaceRoot` 内，包含符号链接校验
- 每个工作区使用带哈希的独立 JDT.LS 状态目录
- 关闭时等待 `shutdown` 响应，再发送 `exit`，超时后才强制终止
- `JDTLS_ARGS` 支持单双引号、反斜杠转义和空参数
- LSP 请求超时后发送 `$/cancelRequest`
- 空闲会话默认 10 分钟后自动优雅关闭

## 环境变量

- `JDTLS_CMD`：覆盖 jdtls 命令，默认 `jdtls`
- `JDTLS_ARGS`：追加传给 jdtls 的参数
- `JDTLS_MCP_STATE_DIR`：jdtls 状态目录，默认系统临时目录下的 `jdtls-mcp`
- `JDTLS_CONFIG_DIR`：覆盖 `-configuration`
- `JDTLS_WORKSPACE_DIR`：覆盖 `-data`
- `JDTLS_MCP_TIMEOUT_MS`：普通 LSP 请求超时，默认 20000ms
- `JDTLS_MCP_INIT_TIMEOUT_MS`：初始化超时，默认 60000ms
- `JDTLS_MCP_READY_TIMEOUT_MS`：首次语义查询等待就绪的上限，默认 30000ms
- `JDTLS_MCP_IDLE_TIMEOUT_MS`：会话空闲回收时间，默认 600000ms；设为 0 可禁用

## 坐标约定

工具入参里的 `line` 和 `character` 都是 1-based。server 内部会转为 LSP 需要的 0-based 坐标。
