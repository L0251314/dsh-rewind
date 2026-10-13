// dsh-rewind —— 检查点捕获器
// 会话事件跟踪（turn 锚定 + 用户提示词）与文件变更工具执行前快照。
import fs from 'node:fs'
import { ensureCheckpoint, recordFileSnap } from './store.js'
import { resolveInsideWorkspace, toWorkspaceRel, summarizePrompt } from './util.js'

/** 默认追踪的文件变更工具：工具名 → 路径参数字段 */
export const DEFAULT_TRACKED_TOOLS = {
  write: 'file_path',
  edit: 'file_path',
  str_replace_editor: 'path',
}

/** bash 命令中的删除类关键词（用于删除文件的可恢复快照） */
const DELETE_CMD_RE = /(?:^|[\s;&|(])(?:sudo\s+)?(?:rm|del|erase|Remove-Item|ri)\b/i
/** 从 bash 命令中提取疑似被删除的路径（剥离旗标，忽略选项） */
function extractDeleteTargets(command) {
  if (!DELETE_CMD_RE.test(command)) return []
  const out = []
  const re = /"([^"]+)"|'([^']+)'|(\S+)/g
  let m
  while ((m = re.exec(command))) {
    const tok = m[1] || m[2] || m[3]
    if (!tok || tok.startsWith('-')) continue
    if (/^[a-zA-Z]:\\/.test(tok) || tok.includes('/') || tok.includes('\\') || tok.includes('.')) out.push(tok)
  }
  return out
}

/** 每个文件快照的最大字节数（超过则记 skip，恢复时跳过该文件） */
const MAX_SNAPSHOT_BYTES = 5 * 1024 * 1024
/** 全量提示词存档上限（字符数）：超长截断并标记，用于消息级回填 */
const PROMPT_FULL_LIMIT = 32 * 1024

function truncatePromptFull(text) {
  return text.length > PROMPT_FULL_LIMIT ? text.slice(0, PROMPT_FULL_LIMIT) + '…[已截断]' : text
}

/**
 * 单会话跟踪器：维护当前轮次、该轮 turn/start 事件 seq 与提示词。
 * 通过 onSessionEvent(session, event) 喂事件；通过 currentTurn(sessionId) 查询。
 */
export class SessionTracker {
  constructor(store, opts = {}) {
    this.store = store          // CheckpointStore
    this.trackedTools = { ...DEFAULT_TRACKED_TOOLS, ...(opts.trackedTools || {}) }
    this.trackBashDelete = opts.trackBashDelete !== false
    this.sessions = new Map()   // sessionId -> { cwd, checkpoints, turn, turnStartSeq, dirty }
    this.lastActiveSessionId = null
  }

  /** 取或建会话状态（含从磁盘恢复历史检查点，重启后回滚仍可用） */
  stateFor(session) {
    const id = session.id
    let st = this.sessions.get(id)
    if (!st) {
      const cwd = session.header?.cwd || process.cwd()
      st = {
        id, cwd,
        checkpoints: this.store.load(cwd, id) || [],
        turn: 0, turnStartSeq: -1, dirty: false,
      }
      this.sessions.set(id, st)
    }
    return st
  }

  /** 无活动事件时从磁盘装载会话状态（重启后立即恢复回滚能力的桥接） */
  adopt(sessionId, cwd) {
    let st = this.sessions.get(sessionId)
    if (st) return st
    const checkpoints = this.store.load(cwd, sessionId) || []
    const last = checkpoints[checkpoints.length - 1]
    st = {
      id: sessionId,
      cwd,
      checkpoints,
      turn: last?.turn ?? 0,
      turnStartSeq: last?.turnStartSeq ?? -1,
      dirty: false,
    }
    this.sessions.set(sessionId, st)
    return st
  }

  /** session/event 监听入口 */
  onSessionEvent(session, event) {
    const st = this.stateFor(session)
    this.lastActiveSessionId = session.id
    switch (event.type) {
      case 'turn/start': {
        st.turn = event.data.turn
        st.turnStartSeq = event.seq
        st.openTurn = event.data.turn
        st.openStep = null
        ensureCheckpoint(st.checkpoints, {
          turn: st.turn,
          turnStartSeq: event.seq,
          time: event.time || Date.now(),
        })
        st.dirty = true
        break
      }
      case 'step/start': {
        st.openTurn = event.data.turn
        st.openStep = event.data.step
        break
      }
      case 'step/end': {
        st.openStep = null
        break
      }
      case 'turn/end': {
        st.openTurn = null
        st.openStep = null
        break
      }
      case 'user/message': {
        const src = event.data?.source
        if (src?.kind !== 'user') break
        const text = (event.data.content || [])
          .map(b => (b?.type === 'text' ? b.text : ''))
          .join(' ')
        const cp = st.checkpoints.find(c => c.turn === st.turn)
        if (cp) {
          const label = summarizePrompt(text)
          // 全量提示词（回填输入框用）；32KB 上限，超长截断并标记
          const PROMPT_FULL_MAX = 32 * 1024
          const full = text.length > PROMPT_FULL_MAX ? text.slice(0, PROMPT_FULL_MAX) : text
          if (label && cp.prompt !== label) { cp.prompt = label; st.dirty = true }
          if (text && (cp.promptFull !== full || cp.promptTruncated !== (text.length > PROMPT_FULL_MAX))) {
            cp.promptFull = full
            cp.promptTruncated = text.length > PROMPT_FULL_MAX ? true : undefined
            st.dirty = true
          }
        }
        break
      }
      default:
        break
    }
  }

  /**
   * tools/pre-execute 钩子：在工具执行前同步快照目标文件（随后必须调用 next()）。
   * 文件写入类工具按路径字段快照；bash 删除类命令按命令解析快照（删除可恢复）。
   * @param {object} exec  { name, arguments, agent? }
   * @param {() => Promise<any>} next
   */
  async preExecute(exec, next) {
    try {
      const session = exec.agent?.session
      if (session) {
        const st = this.stateFor(session)
        // shell 工具有两个注册名：bash（POSIX）与 pwsh（Windows），删除命令都要追踪
        if (exec.name === 'bash' || exec.name === 'pwsh') {
          this.trackBashDeletes(st, String(exec.arguments?.command || ''))
        } else {
          const field = this.trackedTools[exec.name]
          if (field) {
            const raw = exec.arguments?.[field]
            const abs = resolveInsideWorkspace(st.cwd, raw)
            if (abs) {
              const cp = ensureCheckpoint(st.checkpoints, {
                turn: st.turn, turnStartSeq: st.turnStartSeq, time: Date.now(),
              })
              const rel = toWorkspaceRel(st.cwd, abs)
              // str_replace_editor 的 view 命令只读，不追踪
              const isView = exec.name === 'str_replace_editor' && exec.arguments?.command === 'view'
              if (!isView) {
                let content = null
                let kind = 'create'
                try {
                  const stat = fs.statSync(abs)
                  if (stat.isFile()) {
                    if (stat.size <= MAX_SNAPSHOT_BYTES) {
                      content = fs.readFileSync(abs, 'utf8')
                      kind = 'modify'
                    } else {
                      kind = 'skip'
                    }
                  }
                } catch { /* 不存在 → create */ }
                if (recordFileSnap(cp, rel, kind, content)) st.dirty = true
              }
            }
          }
        }
      }
    } catch { /* 快照失败绝不阻断工具执行 */ }
    return next()
  }

  /** bash 删除类命令：执行前快照将被删除的文件（kind='delete'，恢复时原样写回） */
  trackBashDeletes(st, command) {
    if (!this.trackBashDelete) return
    const targets = extractDeleteTargets(command)
    if (targets.length === 0) return
    const cp = ensureCheckpoint(st.checkpoints, {
      turn: st.turn, turnStartSeq: st.turnStartSeq, time: Date.now(),
    })
    for (const raw of targets) {
      const abs = resolveInsideWorkspace(st.cwd, raw)
      if (!abs) continue
      let content = null
      try {
        const stat = fs.statSync(abs)
        if (!stat.isFile()) continue
        if (stat.size > MAX_SNAPSHOT_BYTES) continue
        content = fs.readFileSync(abs, 'utf8')
      } catch { continue /* 文件不存在，无需快照 */ }
      if (recordFileSnap(cp, toWorkspaceRel(st.cwd, abs), 'delete', content)) st.dirty = true
    }
  }

  /** 会话结束：落盘并移除内存态。返回是否写入。 */
  async disposeSession(sessionId, cwd) {
    const st = this.sessions.get(sessionId)
    if (!st) return false
    this.sessions.delete(sessionId)
    if (st.dirty) {
      this.store.save(cwd || st.cwd, sessionId, st.checkpoints)
      return true
    }
    return false
  }

  /** 定期/按需落盘所有脏会话 */
  flushAll() {
    const saved = []
    for (const st of this.sessions.values()) {
      if (st.dirty) {
        this.store.save(st.cwd, st.id, st.checkpoints)
        st.dirty = false
        saved.push(st.id)
      }
    }
    return saved
  }
}
