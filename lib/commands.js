// ============================================================================
// dsh-rewind —— 斜杠命令（/rewind、/checkpoints）
// ============================================================================
// 命令直接作用于当前 agent 会话；/rewind 无参数时回退最近一轮。
// ============================================================================

export function registerRewindCommands(ctx, resolveServiceForAgent) {
  const disposers = []

  disposers.push(ctx.commands.register({
    name: 'rewind',
    description: 'dsh-rewind：回退代码与对话到指定轮之前（缺省回退最近一轮）',
    input: { hint: '[turn 轮号 | checkpointId]' },
    handler: async ({ agent, rawInput }) => {
      const svc = await resolveServiceForAgent(agent)
      if (!svc) return { kind: 'error', text: 'dsh-rewind 未就绪：git 不可用或无法确定工作区' }
      const input = String(rawInput || '').trim()
      let target = null
      if (!input) {
        target = svc.latest(svc.sessionId)
      } else if (/^\d+$/.test(input)) {
        target = svc.findByTurn(svc.sessionId, Number(input))
      } else {
        target = svc.get(input)
      }
      if (!target) return { kind: 'error', text: `找不到匹配的检查点（${input || '最新'}）。先运行 /checkpoints 查看可用检查点。` }
      const result = await svc.restore(target.id)
      if (!result.ok) return { kind: 'error', text: `回退失败 [${result.code}]：${result.message}` }
      const lines = [
        `✅ 已回退到第 ${target.turn ?? '?'} 轮之前（检查点 ${target.id}）`,
        `文件变更 ${result.files.length} 项，整树校验${result.verified ? '通过' : '失败'}，安全点 ${result.safetyCommitId.slice(0, 8)}`,
        result.childSessionId ? `已分叉新会话：${result.childSessionId}（在侧边栏打开它继续）` : '（未分叉会话）',
      ]
      return { kind: 'success', text: lines.join('\n') }
    },
  }))

  disposers.push(ctx.commands.register({
    name: 'checkpoints',
    description: 'dsh-rewind：列出当前会话的检查点',
    input: { hint: '' },
    handler: async ({ agent }) => {
      const svc = await resolveServiceForAgent(agent)
      if (!svc) return { kind: 'error', text: 'dsh-rewind 未就绪' }
      const items = svc.list(svc.sessionId)
      if (items.length === 0) return { kind: 'success', text: '当前会话还没有检查点。' }
      const lines = items.map((c) => {
        const t = new Date(c.createdAt).toLocaleTimeString()
        return `${c.turn === null || c.turn === undefined ? '·' : `T${c.turn}`}  ${c.id}  ${c.trigger}  ${t}${c.restored ? '（已回退过）' : ''}`
      })
      return { kind: 'success', text: `工作区：${svc.workspacePath}\n${lines.join('\n')}` }
    },
  }))

  return () => { for (const d of disposers) { try { d() } catch { /* noop */ } } }
}
