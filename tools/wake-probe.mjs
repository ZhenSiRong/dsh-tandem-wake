#!/usr/bin/env node
/**
 * wake-probe.mjs —— 证明 Tandem 的 `/api/wake` 推送通道是不是真的在发事件。
 *
 *   node tools/wake-probe.mjs [seconds] [url]
 *
 * 默认连 ws://127.0.0.1:3479/api/wake，监听 120 秒，把收到的每一帧打出来，
 * 最后给一行结论。用来回答"插件没被唤醒，到底是通道不通还是我的代码不对"。
 *
 * 实测（Tandem 0.28.0，tandem 模式，订阅者 1）：
 *   - 连接立即 OPEN；
 *   - 用户正常在文档里写评论、甚至 Agent 自己经 MCP 写批注，都是 **0 帧**；
 *   - 对应地 `/api/diagnostics` 里 `eventCount` 恒为 0、`lastEventAt` 为 null。
 *
 * 原因看它源码：`CHANNEL_SKIP` 含 `MCP_ORIGIN`，Agent 写入整类不产事件；批注事件
 * 对外转发还叠了 mode / licence / local-period 三道门。所以本仓库的插件走轮询。
 */

const seconds = Number(process.argv[2] ?? 120)
const url = process.argv[3] ?? 'ws://127.0.0.1:3479/api/wake'

let frames = 0
const started = Date.now()
const stamp = () => `+${((Date.now() - started) / 1000).toFixed(1)}s`

const ws = new WebSocket(url)

ws.addEventListener('open', () => console.log(`${stamp()} OPEN ${url}`))
ws.addEventListener('message', (event) => {
  frames += 1
  const body = typeof event.data === 'string' ? event.data : '[binary]'
  console.log(`${stamp()} FRAME ${body.slice(0, 300)}`)
})
ws.addEventListener('error', () => console.log(`${stamp()} ERROR（连接问题，不是"没事件"）`))
ws.addEventListener('close', (event) => console.log(`${stamp()} CLOSE ${event.code} ${event.reason ?? ''}`))

setTimeout(() => {
  console.log(`\n${seconds}s 内收到 ${frames} 帧`)
  console.log(frames === 0
    ? '结论：通道是通的（能 OPEN），但服务端没有往外发 —— 不要在这条路上继续花时间，改用轮询 tandem_checkInbox。'
    : '结论：有事件往来，可以按帧里的 type 收紧过滤。')
  try { ws.close() } catch { /* ignore */ }
  process.exit(0)
}, seconds * 1000)
