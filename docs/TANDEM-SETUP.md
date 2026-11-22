# Tandem 部署与运行指南

> 这份文档对应实测环境：Ubuntu 24.04 / Node v24.21.0 / Tandem 0.28.0（桌面版进程，端口 3479）。
> 目的：把「Tandem 跑起来」和「让 AI 接上去」两件事拆开讲清，避免踩同一批坑。

## 1. 它是什么，为什么要单独部署

Tandem 是一个「人和 AI 共享同一份 Markdown」的编辑器：

- **人**在浏览器或桌面窗口里写；
- **AI** 通过 MCP 读写同一份文档，改动以批注 + diff 的形式落在右边 margin，人点 Accept 才生效；
- 它把「编辑器服务」和「MCP 服务」放在**同一个进程**里，所以部署只要起一个进程，但端口要认清（见 §3）。

## 2. 安装

三种方式，选一种。

### 2.1 npm 全局（最省事，也自带 CLI）

```bash
node -v                      # 需要 >= 22.12
npm install -g tandem-editor
tandem --version             # 0.32.0（发版号，和运行时版本可不同，见 §7.3）
```

### 2.2 桌面版

从 <https://tandem.ink> 下载。**桌面版内部跑的就是同一个服务**：装完后用 `ss -tlnp | grep 3479` 能看到一个进程占着 3479，`tandem doctor` 也会识别到「already running」。所以**桌面版和 npm 版不要同时起**——第二个会拒绝启动并提示 `Tandem is already running`。

### 2.3 从源码

仓库 `bloknayrb/tandem`，`pnpm`/`vite` 那套，命令行子命令都在 `src/cli`。只有要改界面或调试协议时才需要。

## 3. 启动与端口

```bash
tandem                 # 前台起服务，会打印编辑器地址
# [Tandem] When it's ready, open the editor in your browser at http://127.0.0.1:3479
```

| 端口 | 用途 |
|---|---|
| **3479** | 编辑器静态页（`/`）+ **MCP Streamable HTTP（`/mcp`）** + REST（`/api/*`） |
| **3478** | Yjs 协同 WebSocket（浏览器和文档同步用） |

两个端口都只绑 `127.0.0.1`（`/api/info` 里 `bindHost` 可核对），局域网默认不可达。

常用探测：

```bash
curl -s http://127.0.0.1:3479/health
curl -s http://127.0.0.1:3479/api/info      # 版本、工具数、绑定地址、数据目录
curl -s http://127.0.0.1:3479/api/mode      # {"mode":"tandem"} 或 {"mode":"solo"}
```

## 4. 把 AI 接上去（MCP）

端点：`http://127.0.0.1:3479/mcp`，Streamable HTTP。

### 4.1 本仓库的宿主（DeepSeek Harness）

在 profile 的 `cordis.patch.yml` 里加一条 `dsh-mcp-client` row：

```yaml
- insert:
    - id: tandem-mcp
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: tandem
        transport: streamable-http
        url: http://127.0.0.1:3479/mcp
        startupTimeoutMs: 20000
        toolCallTimeoutMs: 60000
        failOnStartupError: false
```

改完配置热生效，工具以 `mcp__tandem__tandem_*` 出现（0.28 是 31 个）。

### 4.2 其他客户端

```bash
# Claude Code
claude mcp add --transport http tandem http://127.0.0.1:3479/mcp

# Codex（~/.codex/config.toml）
[mcp_servers.tandem]
url = "http://127.0.0.1:3479/mcp"
```

## 5. 验证清单（按顺序做，任一步不过就别往下走）

```bash
# 1 服务在跑
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3479/          # 期望 200

# 2 MCP 握手成功（会返回 mcp-session-id 头和 serverInfo）
curl -s -D - -o /dev/null -X POST http://127.0.0.1:3479/mcp \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"probe","version":"0"}}}'

# 3 编辑器能开，且切到 Tandem 模式（右上角）；Solo 模式下批注不会外发
```

在客户端里调一次 `tandem_listDocuments`，能列出打开的文档就算接通。

## 6. 数据、保存与备份（**这一节最容易吃亏**）

- 数据目录：`~/.local/share/tandem/`
  - `annotations/` 批注存储（按文档路径哈希）
  - `sessions/` 会话
  - `doc-backups/` 每次首次覆盖前的快照
- **保存是自动的**：人点 Accept 之后，改动会写回磁盘上的 `.md`。实测过一次：直播演示时接受了一条建议，`~/Documents/resume/…md` 当场被改写。
- 恢复：

```bash
# MCP 里列出备份 / 恢复（比手写路径安全）
tandem_restoreBackup(documentId)                        # 只列
tandem_restoreBackup(documentId, backup="foo-20261122-192811-xxxx.md")   # 恢复
```

> 演示、录制、试效果时**一律用文件副本**，别拿真文件当片场。

## 7. 常见问题

### 7.1 端口被占

```bash
ss -tlnp | grep -E ':(3478|3479) '
```

要么停掉占用者，要么整体换端口——**注意 3478/3479/`TANDEM_URL` 三者必须一致**，只改一个会出现「服务起了但 MCP 连不上」。

### 7.2 `tandem` 报 "already running"

说明已有一个实例（常见于桌面版在跑）。`tandem doctor --json` 里的 `ports` 检查会给出结论；需要重启时先退出桌面版再起 CLI。

### 7.3 `doctor` 报 "Global tandem-editor@0.32.0 differs from this build (0.28.0)"

全局包版本和正在跑的进程版本不一致。它会提示「stale global can break `npx tandem-editor`」。修法二选一：

```bash
npm uninstall -g tandem-editor          # 如果只用桌面版
npm install -g tandem-editor@latest     # 如果只用 CLI
```

### 7.4 唤醒不生效（本仓库插件相关）

`/api/wake` 这条 WebSocket 在 0.28 上**实测一帧不发**（订阅者连着，服务器 `eventCount` 恒 0）。原因见本仓库 README「为什么不是监听 push」。结论：**不要靠 wake，用 `tandem_checkInbox` 轮询**，也就是本仓库插件做的事。

### 7.5 Solo 模式下 AI 看不到批注

按设计：`isUserPrivacyHeld` 会让批注类事件在非 `tandem` 模式下直接丢弃。用之前先确认右上角是 **Tandem**。

## 8. 卸载

```bash
npm uninstall -g tandem-editor
rm -rf ~/.local/share/tandem          # 连数据一起删（含批注与备份）
```

从 DSH profile 里去掉 `tandem-mcp` 那条 row 即可断开 MCP。

---

**参考**：`tandem --help`、`tandem doctor --json`、`/api/info`、`/api/diagnostics`，以及本仓库 README 里关于 wake 通道的实测记录。
