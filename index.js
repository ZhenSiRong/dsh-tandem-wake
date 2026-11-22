/**
 * tandem-wake —— 把「Tandem 文档里 @ 了本会话的评论」变成一条用户消息，让会话自己开一轮。
 *
 * 三个关键设计（都是踩过坑才定下来的）：
 *
 * 1. **带 cursor 轮询**。Tandem 的 checkInbox 不带 cursor 时是"一次性、所有无 cursor 的
 *    调用者共享"——谁先读谁独占（实测吃掉了本该给 Qoder 的评论）。带 cursor 则每个会话
 *    有独立账本，条目重复到 ack 为止，别的会话读不会把它藏掉。
 * 2. **@ 决定谁动手，不决定谁能看**。本插件只对带 `@DSH` 的条目动作；没 @ 或 @ 的是别人，
 *    就静默只读（写日志、不注入、不回复），并且照样 ack，免得条目重复到天荒地老。
 * 3. **cursor 落盘**，重启不重放旧评论，也不跳过暂停期间攒下的。
 *
 * 暂停开关：/tmp/tandem-wake.pause 存在时完全不轮询 —— 不 poll 就不消费，一条都不丢。
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'

export const name = 'tandem-wake'

/** 只用得到这两个服务：拿会话的 agent、在它空闲时把注入落盘。 */
export const inject = ['agents', 'sessions']

const TRACE_PATH = '/tmp/tandem-wake.log'
const PAUSE_PATH = '/tmp/tandem-wake.pause'

const trace = (line) => {
  try {
    mkdirSync(dirname(TRACE_PATH), { recursive: true })
    appendFileSync(TRACE_PATH, `${new Date().toISOString()} ${line}\n`)
  } catch { /* 日志失败不能影响功能 */ }
}

/** 条目里是否 @ 了本会话。 */
const ADDRESS_PATTERN = /@\s*dsh\b/i
/** 条目里是否 @ 了别的 agent（用来区分"给别人的"与"没人被@"）。 */
const OTHER_ADDRESS_PATTERN = /@\s*(qoder|claude|codex)\b/i

export function apply(ctx, config) {
  const cfg = config ?? {}
  const mcpUrl = cfg.mcpUrl ?? 'http://127.0.0.1:3479/mcp'
  const sessionId = cfg.sessionId ?? ''
  const pollMs = Number(cfg.pollMs ?? 4000)
  const minIntervalMs = Number(cfg.minIntervalMs ?? 10000)
  const maxChars = Number(cfg.maxChars ?? 400)
  const cursorPath = cfg.cursorPath ?? '/home/zhensirong/.dsh/local/tandem-wake/cursor.json'

  let disposed = false
  let timer
  let lastInjectAt = 0
  let session = null
  let rpcId = 0

  const info = (...args) => { try { ctx.logger?.info?.(...args) } catch { /* ignore */ } trace(args.join(' ')) }

  // ---------- cursor 落盘 ----------

  function readCursor() {
    try {
      const raw = JSON.parse(readFileSync(cursorPath, 'utf8'))
      if (typeof raw?.cursor === 'string' && raw.cursor.length > 0) return raw.cursor
    } catch { /* 首次或文件损坏：从头开始 */ }
    return 'start'
  }

  function writeCursor(cursor) {
    if (typeof cursor !== 'string' || cursor.length === 0) return
    try {
      mkdirSync(dirname(cursorPath), { recursive: true })
      writeFileSync(cursorPath, JSON.stringify({ cursor, updatedAt: new Date().toISOString() }))
    } catch (error) { info('cursor 落盘失败：' + String(error)) }
  }

  // ---------- MCP ----------

  async function openSession() {
    const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }
    const initResponse = await fetch(mcpUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: ++rpcId,
        method: 'initialize',
        params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'dsh-tandem-wake', version: '3' } },
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
    info(`mcp session ${id}`)
    return session
  }

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

  // ---------- 分拣 ----------

  /** 把一批条目压成 [{ kind, text, id }]，只保留人写的。 */
  function userItems(inbox) {
    const items = []
    for (const item of inbox.userActions ?? []) {
      if (item.author !== 'user') continue
      items.push({ kind: '评论', text: String(item.content ?? '').trim(), id: item.id })
    }
    for (const reply of inbox.userReplies ?? []) {
      if (reply.author !== 'user') continue
      items.push({ kind: '回复', text: String(reply.text ?? '').trim(), id: reply.id })
    }
    for (const chat of inbox.chatMessages ?? []) {
      if (chat.author === 'claude') continue
      items.push({ kind: '聊天', text: String(chat.text ?? '').trim(), id: chat.id })
    }
    return items
  }

  function digest(items) {
    const text = items.map(item => `· ${item.kind}「${item.text}」`).join('\n')
    return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text
  }

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

  function wake(items) {
    const agent = targetAgent()
    if (agent === undefined) { info('找不到会话对应的 agent：' + String(sessionId)); return }
    const text = [
      '[Tandem] 用户在共享文档里 @ 了你：',
      digest(items),
      '请按这条直接处理；需要原文/区间再调 mcp__tandem__tandem_checkInbox 或 tandem_getContext。',
    ].join('\n')

    const message = { id: randomUUID(), role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } }
    // followup = next-turn + wakeup:true；inject 只入队不唤醒。
    const deliver = typeof agent.followup === 'function' ? agent.followup.bind(agent) : agent.inject.bind(agent)
    deliver(message)
    lastInjectAt = Date.now()
    info('已注入唤醒（@DSH）：' + digest(items).slice(0, 80))
    if (agent.status === 'idle') {
      Promise.resolve(ctx.sessions.flush(agent.session))
        .catch(error => info('flush 失败：' + String(error)))
    }
  }

  async function tick() {
    if (disposed) return
    // 暂停时不发起 checkInbox：不 poll 就不消费。
    if (existsSync(PAUSE_PATH)) return
    try {
      const cursor = readCursor()
      const result = await callTool('tandem_checkInbox', { cursor })
      if (result?.error) { info('checkInbox 报错：' + JSON.stringify(result.error).slice(0, 200)); return }
      const inbox = result?.data ?? {}

      // 读到就 ack：把这一轮返回的 cursor 存下来，下一轮带上，条目才不会永远重复。
      if (inbox.cursor !== undefined) writeCursor(inbox.cursor)
      if (inbox.hasNew !== true) return

      const items = userItems(inbox)
      const mine = items.filter(item => ADDRESS_PATTERN.test(item.text))
      const others = items.filter(item => !ADDRESS_PATTERN.test(item.text) && OTHER_ADDRESS_PATTERN.test(item.text))
      const unaddressed = items.filter(item => !ADDRESS_PATTERN.test(item.text) && !OTHER_ADDRESS_PATTERN.test(item.text))

      if (mine.length === 0) {
        const why = others.length > 0 ? `@ 的是别人（${others.length} 条）` : `没人被 @（${unaddressed.length} 条）`
        info('旁观：' + why + '，按约定不动手；内容：' + digest(items).replace(/\n/g, ' ').slice(0, 200))
        return
      }
      if (Date.now() - lastInjectAt < minIntervalMs) { info('冷却中，跳过：' + digest(mine).slice(0, 120)); return }
      wake(mine)
    } catch (error) {
      info('轮询失败：' + String(error))
      session = null // 下一轮重新握手
    }
  }

  ctx.effect(() => {
    const resolved = ctx.agents.get(sessionId) !== undefined
    info('插件已加载（cursor 模式），轮询 ' + mcpUrl + ' 每 ' + pollMs + 'ms；cursor ' + cursorPath
      + '；目标会话 ' + sessionId + '：' + (resolved ? '已解析到（followup 开轮）' : '找不到！'))
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
