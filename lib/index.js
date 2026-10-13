// dsh-rewind —— 插件入口
// DeepSeek Harness (dsh) Cordis 插件：代码回滚 + 会话回滚。
//
// 能力：
//  - 每个用户轮次一个检查点；文件变更类工具执行前快照目标文件（不碰 git，bash 不追踪）
//  - rewind_list / rewind_restore 模型工具（code | conversation | both）
//  - 本地 REST + Web UI 注入回滚面板（webserver/index-inject）
//  - 快照存储 ~/.dsh/rewind/v1/<workspaceHash>/<sessionId>.json，保留期清理
//
// 配置（cordis.patch.yml 的 config，整行替换不合并）：
//  enabled / retentionDays / maxTotalMb / trackedTools / panel
import { CheckpointStore } from './store.js'
import { SessionTracker } from './capture.js'
import { RewindService } from './service.js'
import { buildRewindListTool, buildRewindRestoreTool } from './tools.js'
import { buildRoutes, pushInjectRows } from './webui.js'

// defineTool 仅在 dsh 宿主内可解析（安装副本拦截路由）。非 dsh 环境（单测）降级为普通对象。
let defineTool = null
try {
  ({ defineTool } = await import('@deepseek-ai/dsh-tools'))
} catch { /* 非 dsh 环境：工具以鸭子类型注册（字段兼容 defineTool 形状） */ }

export const name = 'dsh-rewind'
export const inject = ['tools']

const DEFAULTS = {
  enabled: true,
  retentionDays: 30,
  maxTotalMb: 512,
  panel: false, // 悬浮面板默认关闭（消息级回退按钮为主 UI）；panel:true 恢复
  confirm: true, // 消息级回退是否二次确认
  trackBashDelete: true, // bash 删除类命令执行前快照（删除的文件可恢复）
  trackedTools: null, // 见 capture.js DEFAULT_TRACKED_TOOLS
}

export function apply(ctx, config) {
  const cfg = { ...DEFAULTS, ...(config || {}) }
  if (!cfg.enabled) return

  const store = new CheckpointStore({ retentionDays: cfg.retentionDays, maxTotalMb: cfg.maxTotalMb })
  const tracker = new SessionTracker(store, { trackedTools: cfg.trackedTools || undefined, trackBashDelete: cfg.trackBashDelete !== false })
  const service = new RewindService({ tracker, store, ctx })

  // ---- 会话事件跟踪（全局）----
  ctx.on('session/event', (session, event) => {
    try { tracker.onSessionEvent(session, event) } catch { /* 跟踪失败不影响主流程 */ }
    if (event?.type === 'turn/end') { try { tracker.flushAll() } catch { /* 忽略 */ } }
  })
  // ---- agent/request waterfall：唯一合法且当轮生效的会话折叠窗口 ----
  // 位于 step/start 之后（system/message 校验通过）、user/message append 之前（当轮 derive 生效）。
  ctx.on('agent/request', (payload, next) => {
    try { service.onRequest(payload) } catch { /* 不阻塞请求 */ }
    return next()
  })
  ctx.on('session/disposed', (session) => {
    try {
      Promise.resolve(tracker.disposeSession(session.id, session.header?.cwd))
        .then(() => store.prune())
        .catch(() => {})
    } catch { /* 忽略 */ }
  })

  // ---- 周期落盘（插件卸载时由 Cordis effect 清理）----
  const flushTimer = setInterval(() => { try { tracker.flushAll() } catch { /* 忽略 */ } }, 10000)
  ctx.effect(() => () => clearInterval(flushTimer))

  // ---- 文件变更工具执行前快照（全局 waterfall，必须放行 next()）----
  ctx.on('tools/pre-execute', (exec, next) => tracker.preExecute(exec, next))

  // ---- 模型工具（apply 内同步注册）----
  const registrationReport = { defineToolLoaded: !!defineTool, tools: [] }
  const defs = [
    buildRewindListTool(service),
    buildRewindRestoreTool(service),
  ]
  for (const def of defs) {
    try {
      const registration = defineTool ? defineTool(def) : def
      ctx.tools.register(registration)
      registrationReport.tools.push({ name: def.name, ok: true, wrapped: !!defineTool })
    } catch (err) {
      registrationReport.tools.push({ name: def?.name, ok: false, error: String(err?.stack || err).slice(0, 400) })
      console.error('[dsh-rewind] 工具注册失败：', def?.name, err)
    }
  }

  // ---- Web UI：消息级回退按钮（总是注入）+ 悬浮面板（panel:true 才注入）----
  // 注入行必须在 apply 内同步注册（桌面端启动时一次性收集）
  try {
    ctx.on('webserver/index-inject', (table) => pushInjectRows(table, { panel: cfg.panel === true, confirm: cfg.confirm !== false }))
  } catch { /* 忽略 */ }

  // ---- REST 路由（webServer 可选等待）----
  try {
    ctx.inject(['webServer'], (svcCtx) => {
      const webServer = svcCtx.webServer
      if (!webServer?.register) return
      for (const route of buildRoutes(service)) {
        try { webServer.register(route) } catch (err) {
          console.error('[dsh-rewind] 路由注册失败：', route.path, err)
        }
      }
      // 调试路由：报告工具注册情况与延迟回滚诊断
      try {
        webServer.register({
          kind: 'exact',
          path: '/dsh-rewind/api/debug',
          handler: async (req, res) => {
            let registryNames = null
            try {
              const t = ctx.get?.('tools') || ctx.tools
              registryNames = typeof t?.list === 'function' ? t.list().map(x => x?.name || x) : (t?.schemas ? Object.keys(t.schemas?.() || {}) : null)
            } catch (e) { registryNames = 'ERR:' + String(e).slice(0, 120) }
            const body = JSON.stringify({
              report: registrationReport,
              registryNames,
              toolsService: !!ctx.tools,
              pending: [...(service.pending || new Map()).entries()].map(([k, v]) => ({ sessionId: k, ...v })),
              diagnostics: service.diagnostics || [],
            })
            res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
            res.end(body)
          },
        })
      } catch { /* 忽略 */ }
      console.log('[dsh-rewind] 面板 API 已注册（/dsh-rewind/api/*）')
    })
  } catch { /* webServer 不存在时静默（仅工具可用） */ }

  // ---- 保留清理：启动时一次 ----
  try { store.prune() } catch { /* 忽略 */ }

  console.log('[dsh-rewind] 已加载（代码回滚 + 会话回滚）')
}
