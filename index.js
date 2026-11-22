/**
 * tandem-wake —— 把「用户在 Tandem 文档里留了评论」变成当前会话的一条用户消息。
 *
 * v1 走 Tandem 的 `/api/wake` WebSocket，实测**一发帧都收不到**（服务器侧
 * eventCount 恒为 0，订阅者却是连着的）。翻它的源码得到两个结论：
 *   - `CHANNEL_SKIP` 里含 `MCP_ORIGIN`，所以 Agent 自己经 MCP 写入永远不产生事件；
 *   - 批注类事件的对外转发还叠了 mode / licence / local-period 三道门。
 * 与其继续猜哪道门关着，v2 改成**轮询 `tandem_checkInbox`**：那是 Tandem 自己
 * 文档里说明的权威通道（"the authoritative delivery path"），代价只是一次本地
 * HTTP 请求，不产生模型 token。
 *
 * 关键取舍：轮询会消耗 checkInbox 的「未读」游标，所以注入的消息里必须带上
 * 这次取到的内容摘要，否则唤醒之后那一轮再查会是空的。
 *
 * 观测：所有关键动作都追加到 TRACE_PATH，出问题直接读文件，不用猜。
 */

import { appendFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'

export const name = 'tandem-wake'

/** 只用得到这两个服务：拿会话的 agent、在它空闲时把注入落盘。 */
export const inject = ['agents', 'sessions']

const TRACE_PATH = '/tmp/tandem-wake.log'
/** 存在这个文件就完全不轮询 —— 不轮询才不会消费掉别人要看的批注。 */
const PAUSE_PATH = '/tmp/tandem-wake.pause'

const trace = (line) => {
  try {
    mkdirSync(dirname(TRACE_PATH), { recursive: true })
    appendFileSync(TRACE_PATH, `${new Date().toISOString()} ${line}\n`)
  } catch { /* 日志失败不能影响功能 */ }
}

export function apply(ctx, config) {
  const cfg = config ?? {}
  const mcpUrl = cfg.mcpUrl ?? 'http://127.0.0.1:3479/mcp'
  const sessionId = cfg.sessionId ?? ''
  const pollMs = Number(cfg.pollMs ?? 4000)
  const minIntervalMs = Number(cfg.minIntervalMs ?? 10000)
  const maxChars = Number(cfg.maxChars ?? 400)

  let disposed = false
  let timer
  let lastInjectAt = 0
  let session = null
  let rpcId = 0

  const info = (...args) => { try { ctx.logger?.info?.(...args) } catch { /* ignore */ } trace(args.join(' ')) }

  /** 打开一次 MCP 会话；Tandem 每进程允许并发会话，但复用一条更省。 */
  async function openSession() {
    const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }
    const initResponse = await fetch(mcpUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: ++rpcId,
        method: 'initialize',
        params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'dsh-tandem-wake', version: '2' } },
      }),
    })
    const id = initResponse.headers.get('mcp-session-id')
    if (id === null) throw new Error('initialize 没有返回 mcp-session-id')
    await fetch(mcpUrl, {
      method: 'POST',
      headers: { ...headers, 'mcp-session-id': id },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    })
    session = { id, headers }
    trace(`mcp session ${id}`)
    return session
  }

  /** 调一个 MCP 工具，SSE 或 JSON 两种响应都吃。 */
  async function callTool(tool, args = {}) {
    if (session === null) await openSession()
    const body = { jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name: tool, arguments: args } }
    const response = await fetch(mcpUrl, {
      method: 'POST',
      headers: { ...session.headers, 'mcp-session-id': session.id },
      body: JSON.stringify(body),
    })
    const text = await response.text()
    const payload = text.split('\n').filter(line => line.startsWith('data: ')).pop() ?? text
    const json = JSON.parse(payload.slice(payload.indexOf('{')))
    const inner = json.result?.content?.[0]?.text
    return inner === undefined ? json : JSON.parse(inner)
  }

  /** 把这次取到的新内容压成一行，附在注入消息里——轮询已经消费了游标。 */
  function digest(inbox) {
    const parts = []
    for (const item of inbox.userActions ?? []) {
      if (item.author !== 'user') continue
      parts.push(`· 评论「${String(item.content ?? '').trim()}」`)
    }
    for (const reply of inbox.userReplies ?? []) {
      if (reply.author !== 'user') continue
      parts.push(`· 回复「${String(reply.text ?? '').trim()}」`)
    }
    for (const chat of inbox.chatMessages ?? []) {
      if (chat.author === 'claude') continue
      parts.push(`· 聊天「${String(chat.text ?? '').trim()}」`)
    }
    const text = parts.join('\n')
    return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text
  }

  /** 目标 agent：配置的 id 优先；配 'auto' 时，只有一个存活 agent 才认领。 */
  function targetAgent() {
    if (sessionId && sessionId !== 'auto') {
      const found = ctx.agents.get(sessionId)
      if (found !== undefined) return found
    }
    const live = ctx.agents.list?.() ?? []
    if (live.length === 1) return live[0]
    info('存活 agent ' + live.length + ' 个：' + live.map(agent => String(agent.id)).join(', '))
    return undefined
  }

  function wake(inbox, content) {
    const agent = targetAgent()
    if (agent === undefined) { info('找不到会话对应的 agent：' + String(sessionId)); return }
    const text = [
      '[Tandem] 用户在你正共享的文档里留了话（已从 tandem_checkInbox 取到）：',
      content || '（内容为空，可能是删除或解决动作）',
      inbox.summary ? `摘要：${inbox.summary}` : '',
      '请直接按这条评论处理；需要原文/区间再调用 mcp__tandem__tandem_checkInbox 或 tandem_getContext。',
    ].filter(Boolean).join('\n')

    // followup = next-turn + wakeup:true；inject 只入队不唤醒（会一直躺着等人说话）。
    const message = { id: randomUUID(), role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } }
    const deliver = typeof agent.followup === 'function' ? agent.followup.bind(agent) : agent.inject.bind(agent)
    deliver(message)
    lastInjectAt = Date.now()
    info('已注入唤醒：' + (content || '(空)').slice(0, 80))
    if (agent.status === 'idle') {
      Promise.resolve(ctx.sessions.flush(agent.session))
        .catch(error => info('flush 失败：' + String(error)))
    }
  }

  async function tick() {
    if (disposed) return
    // 暂停时不发起 checkInbox：Tandem 的未读游标是"轮询即消费"，只要不 poll 就一条都不丢。
    if (existsSync(PAUSE_PATH)) return
    try {
      const result = await callTool('tandem_checkInbox')
      if (result?.error) { info('checkInbox 报错：' + JSON.stringify(result.error).slice(0, 200)); return }
      const inbox = result?.data ?? {}
      if (inbox.hasNew !== true) return
      info('取到新批注（已被本插件消费）：' + (inbox.summary ?? ''))
      if (Date.now() - lastInjectAt < minIntervalMs) { info('冷却中，跳过：' + (inbox.summary ?? '')); return }
      wake(inbox, digest(inbox))
    } catch (error) {
      info('轮询失败：' + String(error))
      session = null // 下一轮重新握手
    }
  }

  ctx.effect(() => {
    const ids = (ctx.agents.list?.() ?? []).map(agent => String(agent.id))
    const resolved = ctx.agents.get(sessionId) !== undefined
    info('插件已加载，轮询 ' + mcpUrl + ' 每 ' + pollMs + 'ms（暂停开关 ' + PAUSE_PATH + '）；目标会话 ' + sessionId + '：'
      + (resolved ? '已解析到（投递用 followup，会主动开轮）' : '找不到！存活 agent：' + (ids.join(', ') || '（无）')))
    const loop = () => { void tick().finally(() => { if (!disposed) { timer = setTimeout(loop, pollMs); timer.unref?.() } }) }
    timer = setTimeout(loop, 1500)
    timer.unref?.()
    return () => {
      disposed = true
      clearTimeout(timer)
      info('插件已卸载')
    }
  })
}
