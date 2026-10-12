// ============================================================================
// dsh-rewind —— Agent 工具注册（checkpoint_*）
// ============================================================================
// 全部为原生 Function Calling 工具；restore 会在 Host 侧执行"回退前确认"
// （配置 confirmBeforeRestore 时通过 userQuestions 询问用户）。
// ============================================================================

const LIST_OUTPUT = {
  type: 'object',
  properties: {
    sessionId: { type: 'string' },
    workspacePath: { type: 'string' },
    count: { type: 'number' },
    checkpoints: { type: 'json' },
  },
}

function text(value) {
  return [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }]
}

export function registerRewindTools(tools, getService) {
  const disposers = []

  disposers.push(tools.register({
    name: 'checkpoint_list',
    description: '列出当前会话可回退的检查点（每轮自动快照）。用于回答"可以回退到哪"或回退前确认边界。',
    parameters: {},
    output: { schema: LIST_OUTPUT, render: (_a, v) => text(v) },
    async execute(_args, exec) {
      const svc = await getService(exec)
      if (!svc) throw new Error('dsh-rewind 未就绪（git 不可用或工作区未知）')
      const items = svc.list(svc.sessionId)
      return {
        sessionId: svc.sessionId,
        workspacePath: svc.workspacePath,
        count: items.length,
        checkpoints: items.map((c) => ({
          id: c.id, turn: c.turn, trigger: c.trigger, committed: c.committed,
          treeHash: c.treeHash, boundarySeq: c.boundarySeq,
          time: new Date(c.createdAt).toISOString(), restored: c.restored,
        })),
      }
    },
  }))

  disposers.push(tools.register({
    name: 'checkpoint_diff',
    description: '查看当前工作区与某个检查点之间的文件差异（回退将产生的影响清单）。',
    parameters: {
      checkpointId: { type: 'string', description: 'checkpoint_list 返回的检查点 id；缺省为最新检查点' },
    },
    output: { schema: { type: 'json' }, render: (_a, v) => text(v) },
    async execute(args, exec) {
      const svc = await getService(exec)
      if (!svc) throw new Error('dsh-rewind 未就绪')
      const id = args.checkpointId || svc.latest(svc.sessionId)?.id
      if (!id) throw new Error('没有可用的检查点')
      return svc.plan(id)
    },
  }))

  disposers.push(tools.register({
    name: 'checkpoint_restore',
    description: '回退到某个检查点：工作区文件精确恢复到该时刻（treeHash 校验），对话从该轮之前分叉继续。这是破坏性操作，默认会先请求用户确认。',
    parameters: {
      checkpointId: { type: 'string', description: '目标检查点 id；缺省为最新检查点（即回退最近一轮）' },
    },
    output: { schema: { type: 'json' }, render: (_a, v) => text(v) },
    async execute(args, exec) {
      const svc = await getService(exec)
      if (!svc) throw new Error('dsh-rewind 未就绪')
      const id = args.checkpointId || svc.latest(svc.sessionId)?.id
      if (!id) throw new Error('没有可用的检查点')
      const confirmed = await svc.confirmRestore(exec, id)
      if (!confirmed) return { ok: false, code: 'USER_DECLINED', message: '用户拒绝或未确认本次回退' }
      return svc.restore(id)
    },
  }))

  disposers.push(tools.register({
    name: 'checkpoint_verify',
    description: '校验当前工作区是否仍精确等于某个检查点的树（不修改任何文件）。',
    parameters: {
      checkpointId: { type: 'string', description: '目标检查点 id；缺省为最新检查点' },
    },
    output: { schema: { type: 'json' }, render: (_a, v) => text(v) },
    async execute(args, exec) {
      const svc = await getService(exec)
      if (!svc) throw new Error('dsh-rewind 未就绪')
      const id = args.checkpointId || svc.latest(svc.sessionId)?.id
      if (!id) throw new Error('没有可用的检查点')
      return svc.verify(id)
    },
  }))

  return () => { for (const d of disposers) { try { d() } catch { /* noop */ } } }
}
