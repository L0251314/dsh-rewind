// dsh-rewind —— 模型工具定义
// 返回符合 @deepseek-ai/dsh-tools defineTool 形状的普通对象；
// 由 index.ts/index.js 在运行时经 defineTool 包装后注册（本文件不 import dsh，便于单测）。

/**
 * @param {import('./service.js').RewindService} service
 */
export function buildRewindListTool(service) {
  return {
    name: 'rewind_list',
    description: '列出当前会话的所有回滚检查点（每个用户轮次一个）。返回轮次号、时间、用户提示词摘要与涉及的文件。用户要求"回退/撤销/回滚到某一步"时，先用本工具查看可用轮次。',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          sessionId: { type: 'string' },
          cwd: { type: 'string' },
          checkpoints: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                turn: { type: 'number' },
                time: { type: 'number' },
                prompt: { type: 'string' },
                files: {
                  type: 'array',
                  items: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                      path: { type: 'string' },
                      kind: { type: 'string' },
                    },
                  },
                },
              },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: formatCheckpoints(value),
      }],
    },
    presentCall: () => ({ card: 'generic', title: '查看回滚检查点', kind: 'search' }),
    async execute() {
      const v = service.listCheckpoints()
      // 投影到声明的 schema（剔除 messages 等未声明字段，避免 canonical 校验失败）
      return { sessionId: v.sessionId, cwd: v.cwd, checkpoints: v.checkpoints }
    },
    presentResult: (_args, { content }) => ({
      card: 'generic',
      title: '回滚检查点',
      content: [{ type: 'text', text: content?.[0]?.text || formatCheckpoints(content) }],
    }),
  }
}

/**
 * @param {import('./service.js').RewindService} service
 */
export function buildRewindRestoreTool(service) {
  return {
    name: 'rewind_restore',
    description: '把工作区与/或会话回滚到指定轮次之前（类似 TraeWork 的回退）。scope=code 仅恢复文件；conversation 仅回退对话历史；both 两者同时。执行前应与用户确认，并先用 rewind_list 查看轮次。',
    parameters: {
      turn: { type: 'number', required: true, description: '目标轮次号（rewind_list 返回的 turn）' },
      scope: {
        type: 'string',
        required: true,
        description: '回滚范围：code=仅文件，conversation=仅会话，both=全部',
        enum: ['code', 'conversation', 'both'],
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          sessionId: { type: 'string' },
          turn: { type: 'number' },
          scope: { type: 'string' },
          code: { type: 'object', additionalProperties: true },
          conversation: { type: 'object', additionalProperties: true },
          error: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: service.summarize(value) }],
      presentationMeta: (_args, value) => {
        const diffs = value?.ok && (value.scope === 'code' || value.scope === 'both')
          ? service.diffsFor(value.sessionId, value.turn)
          : null
        return diffs ? { diffs } : {}
      },
    },
    presentCall: (args) => ({
      card: 'generic',
      title: `回滚到第 ${args?.turn ?? '?'} 轮之前（${args?.scope || 'both'}）`,
      kind: 'read',
    }),
    async execute(args) {
      return service.restore(args)
    },
    presentResult: (_args, { content, isError, meta }) => {
      if (isError) {
        return { card: 'generic', title: '回滚失败', content: [{ type: 'text', text: extractText(content) }] }
      }
      const diffs = meta?.diffs
      if (Array.isArray(diffs) && diffs.length > 0) {
        return { card: 'diff', title: `已回滚到第 ${content?.turn ?? ''} 轮之前`, diffs }
      }
      return { card: 'generic', title: '回滚完成', content: [{ type: 'text', text: extractText(content) }] }
    },
  }
}

function extractText(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content.map(b => (b?.type === 'text' ? b.text : '')).join('')
  }
  return JSON.stringify(content)
}

function formatCheckpoints(value) {
  const list = Array.isArray(value?.checkpoints) ? value.checkpoints : []
  if (list.length === 0) return '当前会话还没有可回滚的检查点。'
  const lines = list.map(cp => {
    const files = (cp.files || [])
      .map(f => `${f.kind === 'create' ? '+' : f.kind === 'skip' ? '!' : '~'} ${f.path}`)
      .join(', ')
    return `第 ${cp.turn} 轮 · ${new Date(cp.time).toLocaleString()} · ${cp.prompt || '(无提示词)'}${files ? ` · ${files}` : ''}`
  })
  return ['可用回滚点（从新到旧执行 turn 参数即可回滚到该轮之前）：', ...lines].join('\n')
}
