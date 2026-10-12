// ============================================================================
// dsh-rewind —— Host 半插件入口
// ============================================================================
// - 影子 git 引擎（shadow-git.js）+ 检查点编排（checkpoints.js）接入 DSH：
//   · session/event 观测 → 自动快照（turn 边界 / 写类工具）
//   · ctx.tools 注册 checkpoint_* agent 工具
//   · ctx.commands 注册 /rewind、/checkpoints
//   · webServer 注册 /dsh-rewind/api/*（Client 半 UI 的通道，回环+同源栅栏）
// - git 不可用时进入降级模式（仅提示，不崩溃）。
// ============================================================================

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { resolveGit, workspaceHash } from './shadow-git.js'
import { CheckpointService } from './checkpoints.js'
import { registerRewindTools } from './tools.js'
import { registerRewindCommands } from './commands.js'

const PLUGIN_HOME = () => path.join(os.homedir(), '.dsh', 'storages', 'rewind')
const SHADOW_ROOT = () => path.join(PLUGIN_HOME(), 'shadow')
const INDEX_PATH = (wsPath) => path.join(PLUGIN_HOME(), 'index', `${workspaceHash(wsPath)}.json`)
const CONFIG_PATH = () => path.join(PLUGIN_HOME(), 'config.json')

const DEFAULT_CONFIG = {
  autoSnapshot: 'all', // 'all' | 'turn-only' | 'off'
  confirmBeforeRestore: true,
  excludes: [],
  writeTools: ['write', 'edit', 'bash'],
}

function loadConfig() {
  const cfg = { ...DEFAULT_CONFIG }
  try {
    const parsed = JSON.parse(fs.readFileSync(CONFIG_PATH(), 'utf8'))
    Object.assign(cfg, parsed && typeof parsed === 'object' ? parsed : {})
  } catch { /* 首次运行无配置 */ }
  return cfg
}

// ---------------------------------------------------------------------------
// 事件字段防御式读取（SessionEvent 具体字段名在运行时探测）
// ---------------------------------------------------------------------------
function readType(event) {
  return String(event?.type ?? event?.kind ?? '').toLowerCase()
}

function readSeq(event) {
  const v = event?.seq ?? event?.eventSeq ?? event?.sequence
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : null
}

function readTurn(event) {
  const v = event?.turn ?? event?.payload?.turn
  return typeof v === 'number' && v >= 1 ? v : null
}

function readToolName(event) {
  return String(event?.toolName ?? event?.tool ?? event?.name ?? event?.call?.name ?? '').toLowerCase()
}

function readSessionCwd(session) {
  return session?.cwd ?? session?.header?.cwd ?? session?.meta?.cwd ?? session?.workspace?.path ?? null
}

export default {
  name: 'dsh-rewind',
  apply(root) {
    root.inject(['webServer', 'tools', 'commands', 'sessions'], (ctx) => {
      const config = loadConfig()
      const log = (level, msg) => {
        const line = `[dsh-rewind] ${msg}`
        if (level === 'error') console.error(line)
        else if (level === 'warn') console.warn(line)
        else console.log(line)
      }
      const disposers = []
      root.effect(() => () => { for (const d of disposers) { try { d() } catch { /* noop */ } } })

      // ---- 引擎可用性 ------------------------------------------------------
      let gitBin = null
      resolveGit().then((git) => {
        gitBin = git
        if (!git) log('warn', '系统未找到 git：进入降级模式（仅命令可用，快照/恢复不可用）。安装 git 后重启 DSH。')
        else log('info', `就绪（git=${git}）。影子仓库：${SHADOW_ROOT()}`)
      }).catch(() => {})

      // ---- 每工作区 CheckpointService 缓存 ---------------------------------
      const serviceCache = new Map() // workspacePath -> CheckpointService
      const sessionMeta = new Map() // sessionId -> { workspacePath, turn, queued }

      function serviceForWorkspace(workspacePath) {
        let svc = serviceCache.get(workspacePath)
        if (!svc) {
          svc = new CheckpointService({
            workspacePath,
            shadowRoot: SHADOW_ROOT(),
            indexPath: INDEX_PATH(workspacePath),
            git: gitBin ?? 'git',
            excludes: config.excludes,
            log,
            fork: (sessionId, boundarySeq) => dshFork(ctx, sessionId, boundarySeq),
            rename: (parentSessionId, childSessionId, turn) => dshRename(ctx, parentSessionId, childSessionId, turn),
          })
          serviceCache.set(workspacePath, svc)
        }
        return svc
      }

      // ---- 每会话服务门面（tools/commands/api 共用） ------------------------
      function serviceForSession(sessionId) {
        const meta = sessionMeta.get(sessionId)
        if (!meta?.workspacePath) return null
        const base = serviceForWorkspace(meta.workspacePath)
        return {
          sessionId,
          workspacePath: meta.workspacePath,
          list: (sid) => base.list(sid ?? sessionId),
          latest: (sid) => base.latest(sid ?? sessionId),
          findByTurn: (sid, turn) => base.findByTurn(sid ?? sessionId, turn),
          get: (id) => base.get(id),
          plan: (id) => base.plan(id),
          restore: (id) => base.restore(id),
          verify: (id) => base.verify(id),
          confirmRestore: (exec, id) => confirmRestore(ctx, config, log, exec, id),
        }
      }

      async function resolveServiceForAgent(agent) {
        const sessionId = agent?.id
        if (!sessionId) return null
        let svc = serviceForSession(sessionId)
        if (svc) return svc
        // 尚无事件元数据时，主动探测会话 cwd
        const cwd = readSessionCwd(agent) ?? probeSessionCwd(ctx, sessionId)
        if (!cwd) return null
        sessionMeta.set(sessionId, { workspacePath: cwd, turn: 0 })
        return serviceForSession(sessionId)
      }

      // ---- 自动快照：session/event 观测（emit 模式，安全） ------------------
      const snapshotQueues = new Map() // sessionId -> Promise（串行化 git 操作）
      function enqueueSnapshot(sessionId, task) {
        const prev = snapshotQueues.get(sessionId) ?? Promise.resolve()
        const next = prev.then(task, task)
        snapshotQueues.set(sessionId, next)
        next.finally(() => {
          if (snapshotQueues.get(sessionId) === next) snapshotQueues.delete(sessionId)
        }).catch(() => {})
      }

      async function handleEvent(session, event) {
        if (!gitBin) return
        if (config.autoSnapshot === 'off') return
        const sessionId = session?.id
        if (!sessionId) return
        const type = readType(event)
        const isTurnStart = type === 'turn/start'
        const isToolEvent = type.includes('tool') && config.writeTools.includes(readToolName(event))
        if (!isTurnStart && !isToolEvent) return
        if (!isTurnStart && config.autoSnapshot === 'turn-only') return

        let meta = sessionMeta.get(sessionId)
        if (!meta) meta = sessionMeta.set(sessionId, { workspacePath: null, turn: 0 }).get(sessionId)
        const cwd = readSessionCwd(session)
        if (cwd && cwd !== meta.workspacePath) meta.workspacePath = cwd
        if (!meta.workspacePath) {
          meta.workspacePath = probeSessionCwd(ctx, sessionId)
        }
        if (!meta.workspacePath) {
          logOnce(`会话 ${sessionId} 无法确定工作区，跳过快照（配置 dsh-rewind 的 storages 目录或在会话中运行 /checkpoints 触发探测）`)
          return
        }

        const seq = readSeq(event)
        let turn = meta.turn
        if (isTurnStart) {
          const t = readTurn(event)
          turn = t ?? meta.turn + 1
          meta.turn = turn
        } else {
          turn = meta.turn || null
        }
        const boundarySeq = seq === null ? null : Math.max(0, isTurnStart ? seq - 1 : seq)
        const workspacePath = meta.workspacePath
        enqueueSnapshot(sessionId, async () => {
          try {
            const svc = serviceForWorkspace(workspacePath)
            const entry = await svc.snapshot({ sessionId, turn, trigger: isTurnStart ? 'turn' : 'pre-write', boundarySeq })
            log('info', `快照 ${entry.id}（T${turn ?? '?'} ${entry.trigger}${entry.committed ? '' : '，树未变化'}）`)
          } catch (err) {
            log('error', `快照失败：${err.message}`)
          }
        })
      }

      const onceLog = new Set()
      function logOnce(msg) {
        if (onceLog.has(msg)) return
        onceLog.add(msg)
        log('warn', msg)
      }

      disposers.push(root.on('session/event', (session, event) => {
        try { void handleEvent(session, event) } catch { /* 观测者绝不影响主流程 */ }
      }))

      // ---- agent 工具与命令 ------------------------------------------------
      disposers.push(registerRewindTools(ctx, async (exec) => {
        const agent = exec?.agent
        const sessionId = agent?.id
        if (sessionId) {
          const svc = await resolveServiceForAgent(agent)
          if (svc) return svc
          const cwd = readSessionCwd(exec ?? {}) ?? readSessionCwd(agent)
          if (cwd) {
            sessionMeta.set(sessionId, { workspacePath: cwd, turn: sessionMeta.get(sessionId)?.turn ?? 0 })
            return serviceForSession(sessionId)
          }
        }
        return null
      }))
      disposers.push(registerRewindCommands(ctx, resolveServiceForAgent))

      // ---- Web API（Client 半 UI 通道） ------------------------------------
      const json = (res, code, body) => {
        const buf = Buffer.from(JSON.stringify(body), 'utf8')
        res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': String(buf.length) })
        res.end(buf)
      }
      const readBody = (req) => new Promise((resolve) => {
        const chunks = []
        req.on('data', (c) => chunks.push(c))
        req.on('end', () => {
          try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')) } catch { resolve({}) }
        })
        req.on('error', () => resolve({}))
      })

      function fence(req) {
        // 回环 + 同源 + 跨站标记；宿主栅栏可用则委托（参照 whale-widget 三层防线）
        try {
          const headers = req?.headers ?? {}
          let hostUrl = null
          try { hostUrl = new URL(`http://${String(headers.host ?? '')}`) } catch { return 403 }
          const hn = hostUrl.hostname.toLowerCase()
          const loopback = hn === 'localhost' || hn.endsWith('.localhost') || hn === '::1' || /^127\.\d+\.\d+\.\d+$/.test(hn)
          if (!loopback) {
            const conn = ctx.get('connection')
            if (typeof conn?.requestRejection === 'function') return null // 交宿主判定
            return 403
          }
          if (String(headers['sec-fetch-site'] ?? '').toLowerCase() === 'cross-site') return 403
          const origin = headers.origin
          if (typeof origin === 'string' && origin && origin !== 'null') {
            let o = null
            try { o = new URL(origin) } catch { return 403 }
            if (o.host.toLowerCase() !== hostUrl.host.toLowerCase()) return 403
          }
          return null
        } catch { return 403 }
      }

      function route(pathName, handler) {
        disposers.push(ctx.webServer.register({
          kind: 'exact',
          path: pathName,
          handler: async (req, res) => {
            const deny = fence(req)
            if (deny) { json(res, deny, { ok: false, error: 'forbidden' }); return }
            try { await handler(req, res) } catch (err) {
              json(res, 500, { ok: false, error: String(err?.message ?? err) })
            }
          },
        }))
      }

      route('/dsh-rewind/api/health', (_req, res) => {
        json(res, 200, { ok: true, git: gitBin, degraded: !gitBin, config })
      })

      route('/dsh-rewind/api/checkpoints', (req, res) => {
        const u = new URL(req.url ?? '/', 'http://x')
        const sessionId = u.searchParams.get('sessionId') ?? ''
        const svc = serviceForSession(sessionId)
        if (!svc) { json(res, 200, { ok: true, checkpoints: [], degraded: !gitBin, note: '尚无该会话的工作区元数据' }); return }
        const items = svc.list(sessionId).map((c) => ({
          id: c.id, turn: c.turn, trigger: c.trigger, committed: c.committed,
          boundarySeq: c.boundarySeq, time: c.createdAt, restored: c.restored,
        }))
        json(res, 200, { ok: true, checkpoints: items, degraded: !gitBin })
      })

      route('/dsh-rewind/api/plan', async (req, res) => {
        const body = req.method === 'POST' ? await readBody(req) : Object.fromEntries(new URL(req.url ?? '/', 'http://x').searchParams)
        const target = await findTarget(body)
        if (!target.svc || !target.cp) { json(res, 404, { ok: false, error: target.error ?? '检查点不存在' }); return }
        json(res, 200, { ok: true, ...(await target.svc.plan(target.cp.id)) })
      })

      route('/dsh-rewind/api/restore', async (req, res) => {
        const body = await readBody(req)
        const target = await findTarget(body)
        if (!target.svc || !target.cp) { json(res, 404, { ok: false, error: target.error ?? '检查点不存在' }); return }
        const result = await target.svc.restore(target.cp.id)
        json(res, result.ok ? 200 : 409, result)
      })

      route('/dsh-rewind/api/verify', async (req, res) => {
        const body = req.method === 'POST' ? await readBody(req) : Object.fromEntries(new URL(req.url ?? '/', 'http://x').searchParams)
        const target = await findTarget(body)
        if (!target.svc || !target.cp) { json(res, 404, { ok: false, error: '检查点不存在' }); return }
        json(res, 200, { ok: true, ...(await target.svc.verify(target.cp.id)) })
      })

      async function findTarget({ sessionId, turn, checkpointId }) {
        const svc = serviceForSession(sessionId)
        if (!svc) return { error: 'dsh-rewind 未就绪：无法确定该会话的工作区（先进行一轮对话或运行 /checkpoints）' }
        let cp = null
        if (checkpointId) cp = svc.get(checkpointId)
        else if (turn !== undefined && turn !== null && turn !== '') cp = svc.findByTurn(sessionId, Number(turn))
        else cp = svc.latest(sessionId)
        if (!cp) return { svc, error: '没有匹配的检查点' }
        return { svc, cp }
      }

      log('info', 'Host 半已启动（工具/命令/API 就绪）')
    })
  },
}

// ---------------------------------------------------------------------------
// DSH 会话操作（fork / rename / 探测）
// ---------------------------------------------------------------------------
function dshFork(ctx, sessionId, boundarySeq) {
  const sessions = ctx.sessions
  if (!sessions || typeof sessions.fork !== 'function') throw new Error('sessions.fork 不可用')
  const src = (typeof sessions.get === 'function' ? sessions.get(sessionId) : undefined) ?? sessionId
  const child = sessions.fork(src, boundarySeq)
  const childId = child?.id ?? child?.sessionId ?? null
  if (!childId) throw new Error('fork 未返回子会话 id')
  return childId
}

async function dshRename(ctx, parentSessionId, childSessionId, turn) {
  try {
    const st = ctx.get?.('sessionTitle')
    const parent = ctx.sessions.get(parentSessionId)
    const child = ctx.sessions.get(childSessionId)
    if (!st || !parent || !child) return
    const snap = st.get(parent)
    const base = snap?.title ?? snap?.name ?? '会话'
    st.rename(child, `${base} · ↩${turn ?? ''}`.trim())
  } catch { /* 命名失败不影响回退 */ }
}

function probeSessionCwd(ctx, sessionId) {
  try {
    const session = ctx.sessions?.get?.(sessionId)
    const cwd = readSessionCwd(session)
    if (cwd) return cwd
  } catch { /* noop */ }
  try {
    const reg = ctx.get?.('workspaceRegistry')
    const list = typeof reg?.list === 'function' ? reg.list() : []
    if (list.length === 1) return list[0]?.path ?? null
  } catch { /* noop */ }
  return null
}

async function confirmRestore(ctx, config, log, exec, checkpointId) {
  if (!config.confirmBeforeRestore) return true
  try {
    const uq = ctx.get?.('userQuestions')
    if (!uq || typeof uq.ask !== 'function') return true
    const CONFIRM = '确认回退'
    const answer = await uq.ask({
      questions: [{
        id: 'dsh-rewind-confirm',
        question: `dsh-rewind：确认回退到检查点 ${checkpointId}？工作区将精确恢复到该时刻（当前状态已留安全点），对话从该轮之前分叉继续。`,
        options: [
          { label: CONFIRM },
          { label: '取消' },
        ],
        multiSelect: false,
      }],
      signal: exec?.signal,
    })
    const s = JSON.stringify(answer ?? '')
    if (s.includes('取消')) return false
    return s.includes(CONFIRM) || s.toLowerCase().includes('true')
  } catch (err) {
    log('warn', `回退确认询问失败（默认放行，已有安全点兜底）：${err.message}`)
    return true
  }
}
