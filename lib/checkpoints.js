// ============================================================================
// dsh-rewind —— CheckpointService 检查点编排
// ============================================================================
// 职责：
//   - 检查点索引持久化（原子写 JSON）
//   - snapshot：全树快照 + 边界记录（treeHash 去重：树未变则复用 commit，只补边界）
//   - plan：回退前受影响文件清单（改/删/增）
//   - restore：safety 点 → 恢复树 → treeHash 校验 → 会话分叉 → 命名
//     顺序约束：代码先恢复并校验通过后才分叉对话，失败自动回滚 safety 点。
//   - verify：当前树 === 检查点树
// 本模块不依赖 DSH：fork/rename 通过注入函数实现，便于桩测试。
// ============================================================================

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { ShadowGit } from './shadow-git.js'

/** 原子写 JSON 索引（tmp + rename，防进程中断损坏）。 */
export class JsonIndex {
  constructor(filePath) {
    this.filePath = filePath
    this.data = { version: 1, checkpoints: [] }
    this.loaded = false
  }

  load() {
    if (this.loaded) return this.data
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8'))
      if (parsed && Array.isArray(parsed.checkpoints)) {
        this.data = { version: 1, checkpoints: parsed.checkpoints }
      }
    } catch { /* 首次或损坏：以空索引起步 */ }
    this.loaded = true
    return this.data
  }

  save() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true })
    const tmp = `${this.filePath}.${process.pid}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8')
    fs.renameSync(tmp, this.filePath)
  }

  bySession(sessionId) {
    return this.load().checkpoints.filter(
      (c) => c.sessionId === sessionId && !c.superseded,
    )
  }

  all() {
    return this.load().checkpoints.filter((c) => !c.superseded)
  }
}

export function newCheckpointId() {
  return `cp_${Date.now().toString(36)}_${crypto.randomBytes(3).toString('hex')}`
}

export class CheckpointService {
  /**
   * @param {object} opts
   * @param {string} opts.workspacePath
   * @param {string} opts.shadowRoot 影子仓库根
   * @param {string} opts.indexPath 索引 JSON 路径
   * @param {string} [opts.git]
   * @param {string[]} [opts.excludes]
   * @param {(sessionId: string, boundarySeq: number) => Promise<string|null>} [opts.fork]
   *   会话分叉（注入 DSH 实现）；返回子会话 id 或 null
   * @param {(sessionId: string, title: string) => Promise<boolean>} [opts.rename]
   * @param {(level: string, msg: string) => void} [opts.log]
   */
  constructor(opts) {
    this.workspacePath = opts.workspacePath
    this.shadow = new ShadowGit({
      workspacePath: opts.workspacePath,
      shadowRoot: opts.shadowRoot,
      git: opts.git,
      excludes: opts.excludes,
    })
    this.index = new JsonIndex(opts.indexPath)
    this.fork = opts.fork ?? null
    this.rename = opts.rename ?? null
    this.log = opts.log ?? (() => {})
  }

  _save() {
    try { this.index.save() } catch (err) { this.log('warn', `索引保存失败：${err.message}`) }
  }

  /**
   * 记录一个检查点。boundarySeq = 会话事件流的边界（inclusive，fork 会继承到该条）。
   * 树未变化时不重复 commit，但仍然补一条边界记录（同一 commitId）。
   */
  async snapshot({ sessionId, turn, trigger, boundarySeq }) {
    const res = await this.shadow.snapshot(`dsh-rewind: session=${sessionId} turn=${turn ?? '?'} trigger=${trigger}`)
    const entry = {
      id: newCheckpointId(),
      sessionId,
      workspacePath: this.workspacePath,
      turn: turn ?? null,
      boundarySeq: boundarySeq ?? null,
      trigger,
      commitId: res.commitId,
      treeHash: res.treeHash,
      committed: res.committed,
      createdAt: Date.now(),
      restored: false,
    }
    this.index.load().checkpoints.push(entry)
    this._save()
    return entry
  }

  list(sessionId) {
    const items = sessionId ? this.index.bySession(sessionId) : this.index.all()
    return items.slice().sort((a, b) => a.createdAt - b.createdAt)
  }

  get(checkpointId) {
    return this.index.load().checkpoints.find(
      (c) => c.id === checkpointId && !c.superseded,
    ) ?? null
  }

  /** 按 turn 找"该轮开始前"的检查点（同 turn 多条时取最早）。 */
  findByTurn(sessionId, turn) {
    const items = this.list(sessionId).filter((c) => c.turn === turn)
    return items[0] ?? null
  }

  /** 最近一个可回退的检查点（默认"上一轮"）。 */
  latest(sessionId) {
    const items = this.list(sessionId)
    return items.length > 0 ? items[items.length - 1] : null
  }

  /** 受影响文件清单：当前树 → 检查点树。 */
  async plan(checkpointId) {
    const cp = this.get(checkpointId)
    if (!cp) throw new Error(`检查点不存在：${checkpointId}`)
    const current = await this.shadow.currentTree()
    const files = await this.shadow.diffFiles(current, cp.treeHash)
    return {
      checkpointId,
      turn: cp.turn,
      current,
      target: cp.treeHash,
      counts: {
        modified: files.filter((f) => f.status === 'M').length,
        deleted: files.filter((f) => f.status === 'D').length,
        added: files.filter((f) => f.status === 'A').length,
      },
      files,
    }
  }

  /**
   * 回退到检查点。
   * @returns {{ ok: true, childSessionId: string|null, safetyCommitId: string,
   *             files: {path,status}[], verified: boolean } |
   *             { ok: false, code: string, message: string }}
   */
  async restore(checkpointId) {
    const cp = this.get(checkpointId)
    if (!cp) return { ok: false, code: 'NOT_FOUND', message: `检查点不存在：${checkpointId}` }
    if (!cp.treeHash) return { ok: false, code: 'BAD_ENTRY', message: '检查点缺少 treeHash' }

    // 1) safety 点：当前状态先落盘，回退永远可反悔
    let safety
    try {
      safety = await this.shadow.commitForce(`dsh-rewind: safety before restore ${cp.id}`)
    } catch (err) {
      return { ok: false, code: 'SAFETY_FAILED', message: `安全点创建失败：${err.message}` }
    }

    // 2) 代码恢复（失败自动回滚 safety 树）
    let applied
    try {
      applied = await this.shadow.restoreTree(cp.treeHash)
    } catch (err) {
      try { await this.shadow.restoreTree(safety.treeHash) } catch (rollbackErr) {
        this.log('error', `回滚安全点失败：${rollbackErr.message}`)
      }
      return { ok: false, code: 'RESTORE_FAILED', message: err.message, failedPath: err.failedPath }
    }

    // 3) 校验：恢复后的工作区必须精确等于检查点树
    let verified = false
    try {
      const after = await this.shadow.currentTree()
      verified = after === cp.treeHash
    } catch (err) {
      this.log('error', `校验失败：${err.message}`)
    }
    if (!verified) {
      try { await this.shadow.restoreTree(safety.treeHash) } catch (rollbackErr) {
        this.log('error', `回滚安全点失败：${rollbackErr.message}`)
      }
      return { ok: false, code: 'VERIFY_FAILED', message: '恢复后树校验不一致，已回滚到回退前状态' }
    }

    // 4) 对话分叉（校验通过后才执行；失败同样回滚代码）
    let childSessionId = null
    if (this.fork && cp.boundarySeq !== null && cp.boundarySeq !== undefined) {
      try {
        childSessionId = await this.fork(cp.sessionId, cp.boundarySeq)
      } catch (err) {
        try { await this.shadow.restoreTree(safety.treeHash) } catch (rollbackErr) {
          this.log('error', `回滚安全点失败：${rollbackErr.message}`)
        }
        return { ok: false, code: 'FORK_FAILED', message: `代码已恢复但会话分叉失败，已回滚：${err.message}` }
      }
      if (childSessionId && this.rename) {
        try {
          await this.rename(cp.sessionId, childSessionId, cp.turn)
        } catch (err) { this.log('warn', `分叉会话命名失败：${err.message}`) }
      }
    }

    cp.restored = true
    cp.restoredAt = Date.now()
    this._save()

    const plan = await this.plan(cp.id).catch(() => null)
    return {
      ok: true,
      childSessionId,
      safetyCommitId: safety.commitId,
      files: plan ? plan.files : [],
      deletedWorktree: applied.deleted,
      verified,
    }
  }

  /** 校验当前工作区是否仍精确等于检查点树。 */
  async verify(checkpointId) {
    const cp = this.get(checkpointId)
    if (!cp) throw new Error(`检查点不存在：${checkpointId}`)
    const current = await this.shadow.currentTree()
    return { checkpointId, expected: cp.treeHash, current, match: current === cp.treeHash }
  }
}
