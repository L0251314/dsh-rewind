// dsh-rewind —— 检查点存储层
// 布局：<root>/<workspaceHash>/<sessionId>.json
// 文件结构：{ version, sessionId, cwd, checkpoints: Checkpoint[] }
// Checkpoint = { turn, turnStartSeq, time, prompt, files: FileSnap[] }
// FileSnap = { path(工作区相对), kind: 'modify'|'create'|'skip', content?: string }
import fs from 'node:fs'
import path from 'node:path'
import {
  rewindRoot as defaultRoot, sessionStorePath, atomicWriteJson, readJson,
  listFilesDeep, rmRfInside,
} from './util.js'

const STORE_VERSION = 1

export class CheckpointStore {
  /**
   * @param {object} opts
   * @param {string} [opts.root]        存储根目录（默认 ~/.dsh/rewind/v1）
   * @param {number} [opts.retentionDays] 保留天数（默认 30）
   * @param {number} [opts.maxTotalMb]   总量上限 MB（默认 512）
   */
  constructor(opts = {}) {
    this.root = opts.root || defaultRoot()
    this.retentionDays = Number.isFinite(opts.retentionDays) ? opts.retentionDays : 30
    this.maxTotalMb = Number.isFinite(opts.maxTotalMb) ? opts.maxTotalMb : 512
  }

  fileFor(cwd, sessionId) {
    return sessionStorePath(this.root, cwd, sessionId)
  }

  /** 读取某会话已持久化的检查点；缺失/损坏返回 null（调用方降级） */
  load(cwd, sessionId) {
    const data = readJson(this.fileFor(cwd, sessionId))
    if (!data || data.version !== STORE_VERSION || !Array.isArray(data.checkpoints)) return null
    return data.checkpoints
  }

  /** 最近更新的会话文件（用于重启后"当前会话"回退解析），返回 {cwd, sessionId, mtime} 或 null */
  latestSessionFile() {
    let best = null
    for (const f of listFilesDeep(this.root)) {
      if (!f.file.endsWith('.json')) continue
      if (!best || f.mtime > best.mtime) best = f
    }
    if (!best) return null
    const data = readJson(best.file)
    if (!data?.sessionId || !data?.cwd) return null
    return { cwd: data.cwd, sessionId: data.sessionId, mtime: best.mtime }
  }

  /** 原子保存某会话全部检查点 */
  save(cwd, sessionId, checkpoints) {
    atomicWriteJson(this.fileFor(cwd, sessionId), {
      version: STORE_VERSION,
      sessionId,
      cwd,
      checkpoints,
    })
  }

  /** 删除某会话的存储文件 */
  remove(cwd, sessionId) {
    try { fs.rmSync(this.fileFor(cwd, sessionId), { force: true }) } catch { /* 忽略 */ }
  }

  /**
   * 保留清理：删除过期会话文件；超过总量上限时按 mtime 最旧优先删除。
   * 只操作本插件根目录，绝不触碰官方数据。
   * @returns {{removed: string[], keptBytes: number}}
   */
  prune(now = Date.now()) {
    const removed = []
    const files = listFilesDeep(this.root).sort((a, b) => a.mtime - b.mtime)
    const cutoff = now - this.retentionDays * 24 * 3600 * 1000
    const maxBytes = this.maxTotalMb * 1024 * 1024
    let total = files.reduce((s, f) => s + f.size, 0)
    for (const f of files) {
      if (f.mtime < cutoff || total > maxBytes) {
        try { fs.rmSync(f.file, { force: true }); removed.push(f.file); total -= f.size } catch { /* 忽略 */ }
      }
    }
    return { removed, keptBytes: Math.max(total, 0) }
  }
}

/** ---------- 纯内存操作（便于单测） ---------- */

/**
 * 确保某轮的检查点存在（不存在则创建），返回该检查点对象。
 * checkpoints 需按 turn 升序维护。
 */
export function ensureCheckpoint(checkpoints, { turn, turnStartSeq, time, prompt = '' }) {
  let cp = checkpoints.find(c => c.turn === turn)
  if (!cp) {
    cp = { turn, turnStartSeq, time, prompt, files: [] }
    const idx = checkpoints.findIndex(c => c.turn > turn)
    if (idx === -1) checkpoints.push(cp)
    else checkpoints.splice(idx, 0, cp)
  } else {
    if (prompt && !cp.prompt) cp.prompt = prompt
  }
  return cp
}

/**
 * 记录文件快照：同一检查点内同一路径仅首次生效（轮前状态）。
 * @param {'modify'|'create'|'delete'|'skip'} kind
 * @returns {boolean} 是否实际记录
 */
export function recordFileSnap(checkpoint, relPath, kind, content) {
  if (checkpoint.files.some(f => f.path === relPath)) return false
  checkpoint.files.push(kind === 'modify' || kind === 'delete'
    ? { path: relPath, kind, content }
    : { path: relPath, kind })
  return true
}

/**
 * 计算 code 恢复计划：目标轮（含）之后所有检查点，按路径取最早快照。
 * @returns {Array<{path, kind, content?}>} 每路径一条，按检查点顺序稳定排序
 */
export function planCodeRestore(checkpoints, fromTurn) {
  const byPath = new Map()
  for (const cp of checkpoints) {
    if (cp.turn < fromTurn) continue
    for (const snap of cp.files) {
      if (!byPath.has(snap.path)) byPath.set(snap.path, snap)
    }
  }
  return [...byPath.values()]
}
