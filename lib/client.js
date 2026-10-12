// ============================================================================
// dsh-rewind —— Client 半（Web UI）
// ============================================================================
// 在 conversation.chat.turnTail（每轮完成 Turn 的动作行前扩展区）注入撤回图标。
// 点击 → /dsh-rewind/api/plan 拉取受影响文件清单 → 内联确认 → restore →
// 成功后 uiWorkspace.openSession(分叉会话)。
//
// 动态客户端内置符号（见 Inspect Builtin 契约）：ctx / React / host / styles / console。
// 全部防御式访问：任一能力缺失时静默降级，绝不影响聊天主界面。
// ============================================================================

const ROUTE = '/dsh-rewind/api'

let cssInserted = false
function ensureStyles() {
  if (cssInserted) return
  cssInserted = true
  try {
    if (typeof styles !== 'undefined' && styles?.insert) {
      styles.insert(`
.dsh-rewind-wrap{display:inline-flex;align-items:center;position:relative}
.dsh-rewind-btn{display:inline-flex;align-items:center;gap:4px;border:1px solid transparent;border-radius:6px;
  background:transparent;color:var(--dsh-fg-muted,#888);cursor:pointer;font-size:12px;line-height:1;
  padding:3px 6px;opacity:.55;transition:opacity .12s ease,background .12s ease}
.dsh-rewind-btn:hover{opacity:1;background:var(--dsh-bg-hover,rgba(128,128,128,.12));color:inherit}
.dsh-rewind-btn[disabled]{opacity:.35;cursor:default}
.dsh-rewind-pop{position:absolute;bottom:calc(100% + 6px);left:0;z-index:60;width:340px;max-height:280px;overflow:auto;
  border:1px solid var(--dsh-border,rgba(128,128,128,.35));border-radius:10px;padding:10px 12px;
  background:var(--dsh-bg,#1e1e1e);color:inherit;box-shadow:0 8px 24px rgba(0,0,0,.35);font-size:12px}
.dsh-rewind-pop h4{margin:0 0 6px;font-size:12px;font-weight:600}
.dsh-rewind-pop ul{margin:4px 0 8px;padding-left:16px;max-height:120px;overflow:auto}
.dsh-rewind-pop li{margin:1px 0;word-break:break-all}
.dsh-rewind-pop .st-M{color:#e2b341}.dsh-rewind-pop .st-D{color:#e2574b}.dsh-rewind-pop .st-A{color:#5bb98b}
.dsh-rewind-actions{display:flex;gap:8px;justify-content:flex-end}
.dsh-rewind-actions button{border-radius:6px;border:1px solid var(--dsh-border,rgba(128,128,128,.35));
  background:transparent;color:inherit;padding:3px 10px;cursor:pointer;font-size:12px}
.dsh-rewind-actions button.primary{background:var(--dsh-accent,#4c7dff);border-color:transparent;color:#fff}
.dsh-rewind-err{color:#e2574b;margin:4px 0 0;white-space:pre-wrap}
.dsh-rewind-ok{color:#5bb98b;margin:4px 0 0}
`)
    }
  } catch { /* 无 styles 内置时跳过美化 */ }
}

async function api(path, body) {
  const res = await fetch(`${ROUTE}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok || data.ok === false) throw new Error(data.error ?? data.message ?? `HTTP ${res.status}`)
  return data
}

function statusClass(st) { return st === 'M' ? 'st-M' : st === 'D' ? 'st-D' : st === 'A' ? 'st-A' : '' }
// diff 方向 = 当前树 → 检查点树（回退将发生什么）：M 还原 / D 移除后建的 / A 恢复被删的
const STATUS_LABEL = { M: '还原', D: '移除', A: '恢复' }

function RewindButton(props) {
  const R = typeof React !== 'undefined' ? React : null
  if (!R) return null
  const { turn } = props
  const sessionId = props.sessionId ?? props.session?.id ?? null
  if (!sessionId || typeof turn !== 'number') return null

  const [phase, setPhase] = R.useState('idle') // idle | loading | confirm | running | done | error
  const [plan, setPlan] = R.useState(null)
  const [message, setMessage] = R.useState('')
  const [childId, setChildId] = R.useState(null)

  const openPlan = async () => {
    setPhase('loading')
    try {
      const data = await api(`/plan?sessionId=${encodeURIComponent(sessionId)}&turn=${turn}`)
      setPlan(data)
      setPhase('confirm')
    } catch (err) {
      setMessage(String(err.message ?? err))
      setPhase('error')
    }
  }

  const doRestore = async () => {
    setPhase('running')
    try {
      const result = await api('/restore', { sessionId, turn })
      if (result.ok) {
        setChildId(result.childSessionId ?? null)
        setPhase('done')
        try {
          if (result.childSessionId) {
            const uw = (typeof ctx !== 'undefined' && ctx?.get?.('uiWorkspace')) ?? null
            uw?.openSession?.(result.childSessionId)
          }
        } catch { /* 跳转失败不提示致命错误 */ }
      } else {
        setMessage(result.message ?? '回退失败')
        setPhase('error')
      }
    } catch (err) {
      setMessage(String(err.message ?? err))
      setPhase('error')
    }
  }

  const busy = phase === 'loading' || phase === 'running'

  const kids = []
  kids.push(R.createElement('button', {
    className: 'dsh-rewind-btn',
    title: `回退到第 ${turn} 轮之前（代码 + 对话）`,
    disabled: busy,
    onClick: (e) => {
      e.stopPropagation()
      if (phase === 'idle' || phase === 'error') void openPlan()
      else if (phase === 'confirm') setPhase('idle')
      else if (phase === 'done') setPhase('idle')
    },
  }, '↩ 回退本轮'))

  if (phase === 'confirm' && plan) {
    const files = plan.files ?? []
    const counts = plan.counts ?? {}
    kids.push(R.createElement('div', { className: 'dsh-rewind-pop' }, [
      R.createElement('h4', { key: 'h' }, `回退到第 ${turn} 轮之前（还原 ${counts.modified ?? 0} / 移除 ${counts.deleted ?? 0} / 恢复 ${counts.added ?? 0}）`),
      files.length > 0
        ? R.createElement('ul', { key: 'l' }, files.slice(0, 50).map((f, i) =>
            R.createElement('li', { key: i }, R.createElement('span', { className: statusClass(f.status) }, `[${STATUS_LABEL[f.status] ?? f.status}] `), f.path)))
        : R.createElement('div', { key: 'e' }, '（无文件差异）'),
      R.createElement('div', { key: 'note', style: { opacity: .7 } }, '当前状态会先保存安全点，可再次回退反悔。'),
      R.createElement('div', { key: 'a', className: 'dsh-rewind-actions' }, [
        R.createElement('button', { key: 'c', onClick: () => setPhase('idle') }, '取消'),
        R.createElement('button', { key: 'ok', className: 'primary', disabled: busy, onClick: () => void doRestore() }, busy ? '回退中…' : '确认回退'),
      ]),
    ]))
  }
  if (phase === 'error') {
    kids.push(R.createElement('div', { className: 'dsh-rewind-err' }, `回退失败：${message}`))
  }
  if (phase === 'done') {
    kids.push(R.createElement('div', { className: 'dsh-rewind-ok' }, childId
      ? '✅ 已回退并分叉新会话'
      : '✅ 已回退（会话分叉不可用，代码已恢复）'))
  }

  return R.createElement('span', { className: 'dsh-rewind-wrap' }, kids)
}

export function apply(ctx) {
  try {
    if (!ctx?.slots?.inject || !ctx?.slots?.register) {
      console.error('[dsh-rewind] ctx.slots 不可用，撤回图标未注册')
      return
    }
    ctx.slots.inject('conversation.chat.turnTail', () => ctx.slots.register({
      id: 'dsh-rewind.undo',
      order: 0,
      label: '回退本轮（代码+对话）',
    }, RewindButton))
  } catch (err) {
    console.error('[dsh-rewind] slot 注册失败', err)
  }
}
