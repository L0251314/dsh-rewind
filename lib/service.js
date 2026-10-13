// dsh-rewind —— 服务编排层
// 面向模型工具与 Web 路由的统一入口：list / restore。
import { rewindConversation, restoreCode, buildRestoreDiffs } from './restore.js'
import { summarizePrompt } from './util.js'

export class RewindService {
  /**
   * @param {object} opts
   * @param {import('./capture.js').SessionTracker} tracker
   * @param {import('./store.js').CheckpointStore} store
   * @param {object} [ctx] cordis ctx（可选服务经 getter 惰性获取）
   */
  constructor({ tracker, store, ctx, defer } = {}) {
    this.tracker = tracker
    this.store = store
    this.ctx = ctx || null
    this.defer = defer || ((fn) => setImmediate(fn))
    this.pending = new Map() // sessionId -> { cutSeq, minTurn }
    this.lastRestore = null // { sessionId, turn, diffs } 供最近一次恢复的 diff 卡使用
  }

  /**
   * agent/request waterfall（唯一合法且当轮生效的折叠窗口）：
   * 位于 step/start 之后（system/message 的 {turn, step} 校验通过）、
   * user/message append 与 deriveMessages() 之前（折叠对当轮请求立即生效）；
   * waterfall 由 loop await，不在任何 append 发布栈内（无重入冲突）。
   * @param {{agent?: {session?: object}, turn: number, step: number}} payload
   */
  onRequest(payload) {
    const session = payload?.agent?.session
    if (!session?.id || !Number.isSafeInteger(payload.turn) || !Number.isSafeInteger(payload.step)) return
    const pend = this.pending.get(session.id)
    if (!pend) return
    this.pending.delete(session.id)
    try {
      const r = rewindConversation(session, pend.cutSeq, { turn: payload.turn, step: payload.step })
      this.diag(`request flush 完成：session=${session.id} turn=${payload.turn} step=${payload.step} shadowed=${r.shadowed} range=[${r.startSeq}..${r.endSeq}]`)
      try { const sessions = this.ctx?.get?.('sessions'); void sessions?.flush?.(session) } catch { /* 尽力 */ }
    } catch (err) {
      // 写入失败重新挂回，等下一个请求窗口重试
      this.pending.set(session.id, pend)
      this.diag(`request flush 失败（保留 pending）：${String(err?.stack || err).slice(0, 300)}`)
    }
  }

  /** 诊断日志（最近 20 条，debug 路由可查） */
  diag(msg) {
    const line = `${new Date().toISOString()} ${msg}`
    if (!Array.isArray(this.diagnostics)) this.diagnostics = []
    this.diagnostics.push(line)
    if (this.diagnostics.length > 20) this.diagnostics.shift()
    try { console.error(`[dsh-rewind] ${line}`) } catch { }
  }

  /** 解析目标会话状态；缺省依次取：最近活动 → 最近落盘的会话（重启后仍可回滚） */
  resolveState(sessionId) {
    if (sessionId) {
      return this.tracker.sessions.get(sessionId) || this.adoptFromDisk(sessionId)
    }
    const id = this.tracker.lastActiveSessionId
    if (id) {
      const st = this.tracker.sessions.get(id)
      if (st) return st
    }
    return this.adoptFromDisk(null)
  }

  /** 从磁盘落盘文件装载会话状态；sessionId 为空时取最近更新的一个 */
  adoptFromDisk(sessionId) {
    try {
      const latest = this.store.latestSessionFile()
      if (!latest) return null
      if (sessionId && latest.sessionId !== sessionId) return null
      return this.tracker.adopt(latest.sessionId, latest.cwd)
    } catch {
      return null
    }
  }

  /** 从宿主取活动 Session 实例（append/surface 需要） */
  liveSession(sessionId) {
    if (!this.ctx) return null
    try {
      const store = this.ctx.get?.('sessions')
      const live = store?.get?.(sessionId)
      if (live) return live
    } catch { /* 忽略 */ }
    try {
      const agents = this.ctx.get?.('agents')
      const agent = agents?.get?.(sessionId)
      if (agent?.session) return agent.session
    } catch { /* 忽略 */ }
    return null
  }

  /** 列出检查点（含存储中的历史会话）；messages 供消息级回退 UI 回填使用 */
  listCheckpoints(sessionId) {
    const st = this.resolveState(sessionId)
    if (!st) return { sessionId: sessionId || null, cwd: null, checkpoints: [], messages: [] }
    return {
      sessionId: st.id,
      cwd: st.cwd,
      checkpoints: st.checkpoints.map(cp => ({
        turn: cp.turn,
        time: cp.time,
        prompt: cp.prompt || '',
        files: (cp.files || []).map(f => ({ path: f.path, kind: f.kind })),
      })),
      messages: st.checkpoints
        .filter(cp => cp.promptFull)
        .map(cp => ({ turn: cp.turn, promptFull: cp.promptFull, truncated: !!cp.promptTruncated })),
    }
  }

  /**
   * 执行回滚。
   * @param {{sessionId?: string, turn: number, scope: 'code'|'conversation'|'both'}} req
   * @returns {Promise<object>} 规范化结果（供工具输出 / REST 响应）
   */
  async restore(req) {
    const turn = Number(req?.turn)
    const scope = req?.scope || 'both'
    if (!Number.isSafeInteger(turn) || turn < 1) {
      return { ok: false, error: 'turn 必须为正整数（会话中的轮次号）' }
    }
    if (!['code', 'conversation', 'both'].includes(scope)) {
      return { ok: false, error: 'scope 必须为 code | conversation | both' }
    }
    const st = this.resolveState(req.sessionId)
    if (!st) return { ok: false, error: '未找到可回滚的会话（当前插件未跟踪任何活动会话）' }
    const cp = st.checkpoints.find(c => c.turn === turn)
    if (!cp) {
      const turns = st.checkpoints.map(c => c.turn).join(', ') || '无'
      return { ok: false, error: `会话中不存在轮次 ${turn}（可用轮次：${turns}）` }
    }

    const out = { ok: true, sessionId: st.id, turn, scope }
    if (scope === 'code' || scope === 'both') {
      // diff 数据先于裁剪计算（裁剪后被回退轮次的快照不再保留）
      const diffs = buildRestoreDiffs(st.checkpoints, st.cwd, turn)
      out.code = restoreCode(st.checkpoints, st.cwd, turn)
      if (out.code.failed?.length) {
        out.ok = false
        out.error = `部分文件恢复失败：${out.code.failed.map(f => `${f.path} (${f.error})`).join('；')}（可重试）`
      }
      // 硬裁剪被回退轮次的检查点：其改动已不存在，保留会破坏消息↔轮次配对
      st.checkpoints = st.checkpoints.filter(c => c.turn < turn)
      st.dirty = true
      this.lastRestore = { sessionId: st.id, turn, diffs }
      try { this.store.save(st.cwd, st.id, st.checkpoints) } catch { /* 落盘失败不影响恢复结果 */ }
    }
    if (scope === 'conversation' || scope === 'both') {
      // 会话折叠必须落在打开的 turn/step 内（v4 重放校验），唯一合法且当轮生效的
      // 窗口是 agent/request waterfall（step/start 后、user/message 前）——统一挂
      // pending，由下一次请求的 waterfall 执行（用户重发消息时立即生效）。
      this.pending.set(st.id, { cutSeq: cp.turnStartSeq })
      out.conversation = { deferred: true, shadowed: 0 }
      this.diag(`restore(turn=${turn}, scope=${scope}) → pending cutSeq=${cp.turnStartSeq}（等下一次请求的 agent/request 窗口）`)
    }
    return out
  }

  /** 面板/工具摘要文本 */
  summarize(result) {
    if (!result.ok) return `回滚失败：${result.error}`
    const parts = []
    if (result.code) {
      const c = result.code
      parts.push(`恢复 ${c.restored.length} 个文件，删除 ${c.deleted.length} 个新建文件` +
        (c.skipped.length ? `，跳过 ${c.skipped.length} 个（快照超限）` : '') +
        (c.failed.length ? `，失败 ${c.failed.length} 个` : ''))
    }
    if (result.conversation) {
      if (result.conversation.deferred) {
        parts.push('对话将在下一次消息发送时自动回退')
      } else {
        parts.push(result.conversation.shadowed > 0
          ? `已回退 ${result.conversation.shadowed} 条界面记录`
          : '对话无需要回退的记录')
      }
    }
    return `已回滚到第 ${result.turn} 轮之前（${result.scope}）：${parts.join('；')}`
  }

  /** diff 卡数据（用于 presentResult） */
  diffsFor(sessionId, turn) {
    // 优先取最近一次恢复时（裁剪前）计算的 diff；裁剪后快照不再保留
    const last = this.lastRestore
    if (last && last.sessionId === (sessionId || this.lastActiveOrLatest()) && last.turn === turn) {
      return last.diffs
    }
    const st = this.resolveState(sessionId)
    if (!st) return null
    return buildRestoreDiffs(st.checkpoints, st.cwd, turn)
  }

  lastActiveOrLatest() {
    const st = this.resolveState(null)
    return st?.id || null
  }
}

export { summarizePrompt }
