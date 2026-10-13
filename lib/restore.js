// dsh-rewind —— 恢复引擎
// code 范围：按最早快照回写工作区文件（新建删除）。
// conversation 范围：以 surface replace 阴影化目标轮及之后的全部 surface 节点
//（空 system/message 不投影 → 模型历史与 UI 同时消失；官方 compaction 同机制）。
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { planCodeRestore } from './store.js'
import { resolveInsideWorkspace } from './util.js'

/**
 * 执行 code 恢复。
 * @param {Array<Checkpoint>} checkpoints 已按 turn 升序的全部检查点
 * @param {string} cwd 工作区根
 * @param {number} fromTurn 目标轮（含）
 * @returns {{restored: string[], deleted: string[], skipped: string[], failed: Array<{path, error}>}}
 */
export function restoreCode(checkpoints, cwd, fromTurn) {
  const plan = planCodeRestore(checkpoints, fromTurn)
  const result = { restored: [], deleted: [], skipped: [], failed: [] }
  for (const snap of plan) {
    const abs = resolveInsideWorkspace(cwd, snap.path)
    if (!abs) { result.failed.push({ path: snap.path, error: '路径越出工作区，已拒绝' }); continue }
    try {
      if (snap.kind === 'create') {
        fs.rmSync(abs, { force: true })
        result.deleted.push(snap.path)
      } else if (snap.kind === 'modify' || snap.kind === 'delete') {
        // modify：写回轮前内容；delete：该文件在轮后被删除 → 原样恢复
        fs.mkdirSync(path.dirname(abs), { recursive: true })
        fs.writeFileSync(abs, snap.content, 'utf8')
        result.restored.push(snap.path)
      } else {
        result.skipped.push(snap.path)
      }
    } catch (err) {
      result.failed.push({ path: snap.path, error: String(err?.message || err) })
    }
  }
  return result
}

/**
 * 会话回滚：把 [目标轮 turn/start] 之后的全部 surface 节点阴影化为一个空 system 节点。
 * 空节点为休眠态（不投影任何消息）→ 模型历史与 UI 同时清除目标轮及之后内容。
 *
 * ⚠️ v4 重放校验（requireOpenStep）要求 system/message 的 {turn, step} 必须匹配
 * "打开中的 turn/step"，否则整份日志在重载时被判 corrupt（SessionFormatError 实锤）。
 * 本函数只能在 agent/request waterfall 内调用——该窗口位于 step/start 之后、
 * user/message append 之前：system/message 合法落盘，且折叠对当轮请求立即生效。
 *
 * @param {object} session    活动 Session 实例（须有 .surface.nodes 与 .append）
 * @param {number} turnStartSeq 目标轮 turn/start 的事件 seq
 * @param {object} opts       { turn, step } 当前打开的轮/步（取自 agent/request payload）
 * @returns {{shadowed: number, startSeq, endSeq, turn}}
 */
export function rewindConversation(session, turnStartSeq, opts = {}) {
  const nodes = Array.from(session.surface?.nodes || [])
  const shadowed = nodes.filter(seq => seq >= turnStartSeq)
  if (shadowed.length === 0) {
    return { shadowed: 0, startSeq: null, endSeq: null, turn: opts.turn }
  }
  const turn = opts.turn
  const step = opts.step
  // 消息形状必须与官方 createSystemMessage 一致（v4 持久化校验要求
  // producer-owned source kind；空文本时 content 为空数组 → 休眠节点不投影）。
  const message = () => ({
    id: crypto.randomUUID(),
    role: 'system',
    content: [],
    source: { kind: 'system-prompt' },
  })
  // surface 第一个节点是受保护的 system head：不能被跨范围批量 replace，
  // 只能被"恰好针对该节点"的单独 system/message 重写（官方 prompt consolidation 同款）。
  // head 重写为空后，官方 prompt admission 会在后续请求自动恢复/重注入提示词。
  const head = nodes[0]
  const appends = []
  if (shadowed[0] === head) {
    appends.push({ startSeq: head, endSeq: head, sourceEventSeqs: [head] })
    const rest = shadowed.slice(1)
    if (rest.length > 0) {
      appends.push({ startSeq: rest[0], endSeq: rest[rest.length - 1], sourceEventSeqs: rest })
    }
  } else {
    appends.push({ startSeq: shadowed[0], endSeq: shadowed[shadowed.length - 1], sourceEventSeqs: shadowed })
  }
  let last = null
  for (const a of appends) {
    session.append(
      'system/message',
      { turn, step, message: message() },
      {
        surfaceOp: { op: 'replace', startSeq: a.startSeq, endSeq: a.endSeq },
        sourceEventSeqs: a.sourceEventSeqs,
      },
    )
    last = a
  }
  return {
    shadowed: shadowed.length,
    startSeq: appends[0].startSeq,
    endSeq: last.endSeq,
    turn,
  }
}

/**
 * 组装 code 恢复的 diff 卡数据（供 presentResult / Web 面板展示）。
 * 仅当总字节数受限时返回 diffs，否则返回 null（调用方退化 generic 卡）。
 */
export function buildRestoreDiffs(checkpoints, cwd, fromTurn, maxBytes = 256 * 1024) {
  const plan = planCodeRestore(checkpoints, fromTurn)
  const diffs = []
  let total = 0
  for (const snap of plan) {
    if (snap.kind === 'skip') continue
    const abs = resolveInsideWorkspace(cwd, snap.path)
    let newText = ''
    try { newText = fs.readFileSync(abs, 'utf8') } catch { newText = '' }
    const oldText = snap.kind === 'create' ? null : String(snap.content ?? '')
    total += (oldText?.length || 0) + newText.length
    if (total > maxBytes) return null
    diffs.push({ path: snap.path, oldText, newText })
  }
  return diffs.length > 0 ? diffs : null
}
