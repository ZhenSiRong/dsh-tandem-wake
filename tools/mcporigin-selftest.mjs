#!/usr/bin/env node
/**
 * mcporigin-selftest.mjs —— 为什么"让 Agent 自己写一条批注、看会不会回推"这种自测不成立。
 *
 *   node tools/mcporigin-selftest.mjs [documentId] [url]
 *
 * 它做两件事：先连上 wake socket，再经 MCP 调 `tandem_comment` 写一条批注，
 * 然后看会不会有帧回来。预期 **0 帧** —— 因为 Tandem 的 `CHANNEL_SKIP` 里有
 * `MCP_ORIGIN`，机器写入不产生事件。
 *
 * 这条自测失败不代表通道坏，只代表"机器写的不算数"。要验通道，得用人真的在
 * 界面上操作（见 tools/wake-probe.mjs 的注释）。
 */

const documentId = process.argv[2] ?? 'scratchpad'
const mcpUrl = process.argv[3] ?? 'http://127.0.0.1:3479/mcp'

const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }
let rpc = 0

async function connect() {
  const init = await fetch(mcpUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: ++rpc,
      method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'mcporigin-selftest', version: '0' } },
    }),
  })
  const sessionId = init.headers.get('mcp-session-id')
  if (sessionId === null) throw new Error('initialize 没有返回 mcp-session-id')
  await fetch(mcpUrl, {
    method: 'POST',
    headers: { ...headers, 'mcp-session-id': sessionId },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
  })
  return sessionId
}

const sessionId = await connect()

async function call(name, args) {
  const response = await fetch(mcpUrl, {
    method: 'POST',
    headers: { ...headers, 'mcp-session-id': sessionId },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpc, method: 'tools/call', params: { name, arguments: args } }),
  })
  const text = await response.text()
  const line = text.split('\n').filter(candidate => candidate.startsWith('data: ')).pop() ?? text
  const json = JSON.parse(line.slice(line.indexOf('{')))
  const inner = json.result?.content?.[0]?.text
  return inner === undefined ? json : JSON.parse(inner)
}

let frames = 0
const ws = new WebSocket('ws://127.0.0.1:3479/api/wake')
ws.addEventListener('message', () => { frames += 1 })

await new Promise(resolve => ws.addEventListener('open', resolve, { once: true }))
console.log('wake socket OPEN')

const text = await call('tandem_getTextContent', { documentId })
const body = text?.data?.text ?? ''
const from = 0
const to = Math.min(12, body.length)

const created = await call('tandem_comment', {
  documentId,
  from,
  to,
  textSnapshot: body.slice(from, to),
  text: '[自测] 这条批注由 Agent 经 MCP 写入，预期不会触发 wake 帧。',
})
console.log('comment ->', JSON.stringify(created?.data ?? created))

await new Promise(resolve => setTimeout(resolve, 8000))
console.log(`\n8 秒内收到 ${frames} 帧`)
console.log(frames === 0
  ? '符合预期：MCP 来源的写入被 CHANNEL_SKIP 跳过，不产事件。这条自测不能用来判断通道死活。'
  : '意外：机器写入也产生帧了，说明 CHANNEL_SKIP 行为变了，需要重新审 wake 方案。')

try { ws.close() } catch { /* ignore */ }
process.exit(0)
