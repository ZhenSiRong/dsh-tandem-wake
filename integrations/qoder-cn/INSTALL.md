# 装上 Qoder CN（/tandem-wake）

两件事：把 Tandem 注册成 MCP 服务，再放一个 `/tandem-wake` 命令。

## 1. 注册 MCP

**推荐用 CLI**（会写进 `~/.qoder-cn/settings.json`，并立刻验证连通性）：

```bash
qoderclicn mcp add tandem http://127.0.0.1:3479/mcp -t http -s user
qoderclicn mcp list          # 期望：✓ tandem: http://127.0.0.1:3479/mcp (http) - Connected
```

不想用 CLI 就在 IDE 里：右上角用户图标（或 `Ctrl+Shift+,`）→ **MCP** → **My Servers** → **+ Add**，粘：

```json
{
  "mcpServers": {
    "tandem": { "type": "sse", "url": "http://127.0.0.1:3479/mcp" }
  }
}
```

> 官方文档对 Streamable HTTP 的说法是「按 SSE 的方式配端点，IDE 会自动识别」，所以 `type` 写 `sse` 也能连；CLI 里直接 `-t http` 更明确。

## 2. 放命令

```bash
mkdir -p ~/.qoder-cn/commands
cp commands/tandem-wake.md ~/.qoder-cn/commands/
# 国际版放 ~/.qoder/commands/
```

也可以在 IDE 里 Settings → **Skills & Commands** → Commands → New 新建同名命令，把文件正文粘进 body。

## 3. 用

在 Agent 对话框里敲 `/tandem-wake`。

**注意**：Qoder 没有推送通道，所以这里没有"自动唤醒"——这个命令就是手动取件。要真自动醒，用 DSH 那套宿主插件（见仓库根 README）。

## 验证

```bash
qoderclicn mcp get tandem     # Status: ✓ Connected
curl -s http://127.0.0.1:3479/health
```

Tandem 没跑时 MCP 会连不上，先 `tandem` 起服务。
