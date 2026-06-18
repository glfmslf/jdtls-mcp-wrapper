---
name: jdtls-mcp-wrapper
description: Use when navigating Java code in Codex with MCP tools backed by Eclipse JDT.LS, including workspace symbols, document symbols, definitions, implementations, and references.
---

# JDTLS MCP Wrapper

## When to Use

在 Java 项目中需要语义级定位时使用：

- 查类、方法、字段等 workspace symbol
- 从调用点跳转到定义
- 查接口/抽象方法的实现
- 查方法、字段、类的引用
- 查看单个 Java 文件的 document symbols

## Tools

- `jdtls_workspace_symbol`
- `jdtls_document_symbol`
- `jdtls_definition`
- `jdtls_implementation`
- `jdtls_references`
- `jdtls_shutdown`

## Coordinates

`line` 和 `character` 参数均使用 1-based 坐标，方便直接从编辑器或 `nl -ba` 输出复制。

## Requirements

- `node`
- `jdtls`
- JDK 17+，建议 JDK 21

如果 `jdtls` 默认写入 `~/.eclipse` 失败，本插件会自动传入可写的 `-configuration` 和 `-data` 目录，默认在系统临时目录下。
