// ============================================================================
// dsh-rewind —— ShadowGit 影子仓库适配层
// ============================================================================
// 在工作区之外的独立 git 目录（--git-dir）里维护全树快照；
// 绝不触碰用户自己的 .git / HEAD / 暂存区 / 分支。
// 所有操作通过显式 --git-dir 完成，与工作区的任何 git 仓库完全隔离。
//
// 约定：
//   - 影子目录 = <shadowRoot>/<workspaceHash>.git（以目录形式充当 GIT_DIR）
//   - core.bare=false + core.worktree=<workspace> 写入影子仓库配置
//   - 全树快照 = add -A（带排除 pathspec）→ commit → write-tree 得 treeHash
//   - 恢复 = 删除"目标树没有而当前树有"的文件 → read-tree 目标树 → checkout-index -a -f
// ============================================================================

import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

/** 工作区绝对路径 → 稳定短哈希（跨重启稳定，避免路径分隔符差异）。 */
export function workspaceHash(workspacePath) {
  const norm = String(workspacePath).replace(/[\\/]+/g, '/').replace(/\/+$/, '').toLowerCase()
  return crypto.createHash('sha256').update(norm).digest('hex').slice(0, 16)
}

/** 探测可用的 git 可执行文件；不可用时返回 null（调用方进入降级模式）。 */
export async function resolveGit() {
  const candidates = [process.env.DSH_REWIND_GIT, 'git'].filter(Boolean)
  for (const git of candidates) {
    try {
      const r = await runProcess(git, ['--version'], {})
      if (r.code === 0) return git
    } catch { /* try next */ }
  }
  return null
}

function runProcess(cmd, args, { cwd, env, input } = {}) {
  return new Promise((resolve, reject) => {
    let child
    try {
      child = spawn(cmd, args, { cwd, env, windowsHide: true })
    } catch (err) { reject(err); return }
    const out = []
    const errOut = []
    child.stdout?.on('data', (c) => out.push(c))
    child.stderr?.on('data', (c) => errOut.push(c))
    child.on('error', reject)
    child.on('close', (code) => {
      resolve({
        code,
        stdout: Buffer.concat(out),
        stderr: Buffer.concat(errOut).toString('utf8'),
      })
    })
    if (input !== undefined) child.stdin?.end(input)
    else child.stdin?.end()
  })
}

export class ShadowGitError extends Error {
  constructor(message, opts = {}) {
    super(message)
    this.name = 'ShadowGitError'
    this.code = opts.code
    this.failedPath = opts.failedPath
    this.stderr = opts.stderr
  }
}

/** v1 默认排除：任何层级下命中的目录/文件都不进快照。 */
export const DEFAULT_EXCLUDES = [
  '.git',
  'node_modules',
  '.dsh',
]

const EMPTY_TREE_SHA1 = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'

export class ShadowGit {
  /**
   * @param {object} opts
   * @param {string} opts.workspacePath 工作区绝对路径（快照/恢复的作用域）
   * @param {string} opts.shadowRoot 影子仓库根目录（如 ~/.dsh/storages/rewind/shadow）
   * @param {string} [opts.git] git 可执行文件
   * @param {string[]} [opts.excludes] 追加排除规则（目录名，任意层级生效）
   */
  constructor({ workspacePath, shadowRoot, git = 'git', excludes = [] }) {
    if (!path.isAbsolute(workspacePath)) throw new ShadowGitError('workspacePath 必须是绝对路径')
    this.workspacePath = workspacePath
    this.shadowRoot = shadowRoot
    this.git = git
    this.excludes = [...DEFAULT_EXCLUDES, ...excludes]
    this.gitDir = path.join(shadowRoot, `${workspaceHash(workspacePath)}.git`)
  }

  _baseArgs() {
    return ['--git-dir', this.gitDir]
  }

  async _run(args, { input } = {}) {
    // 统一以工作区为 cwd：pathspec('.') 才能按工作区根解析；树操作不受影响
    const r = await runProcess(this.git, [...this._baseArgs(), ...args], { cwd: this.workspacePath, input })
    return r
  }

  _fail(r, action) {
    throw new ShadowGitError(`git ${action} 失败 (exit ${r.code})：${r.stderr.trim().slice(0, 800)}`, {
      code: 'GIT_FAILED',
      stderr: r.stderr,
    })
  }

  /** 幂等初始化影子仓库；不存在则创建并写入 worktree 配置。 */
  async ensure() {
    const marked = path.join(this.gitDir, 'HEAD')
    if (fs.existsSync(marked)) return
    fs.mkdirSync(this.gitDir, { recursive: true })
    let r = await runProcess(this.git, ['init', '--bare', '--quiet', '.'], { cwd: this.gitDir })
    if (r.code !== 0) this._fail(r, 'init')
    r = await this._run(['config', 'core.bare', 'false'])
    if (r.code !== 0) this._fail(r, 'config core.bare')
    r = await this._run(['config', 'core.worktree', this.workspacePath])
    if (r.code !== 0) this._fail(r, 'config core.worktree')
    r = await this._run(['config', 'core.autocrlf', 'false'])
    if (r.code !== 0) this._fail(r, 'config core.autocrlf')
  }

  _pathspecs(base) {
    // '.' 加入全部；排除规则用 :(exclude) 前缀，目录名带 '/' 表示目录前缀匹配（任意层级）
    const spec = [base]
    for (const e of this.excludes) {
      const name = String(e).replace(/\/+$/, '').replace(/^\*\*\//, '')
      spec.push(`:(exclude,glob)**/${name}/**`)
      spec.push(`:(exclude,glob)**/${name}`)
    }
    return spec
  }

  /** 工作区相对当前索引是否有变化（含未跟踪）。 */
  async isDirty() {
    const r = await this._run(['status', '--porcelain', ...this._pathspecs('.')])
    if (r.code !== 0) this._fail(r, 'status')
    return r.stdout.toString('utf8').trim().length > 0
  }

  /** add -A（带排除）后返回当前树 hash；不做 commit。 */
  async writeTree() {
    let r = await this._run(['add', '-A', '--', ...this._pathspecs('.')])
    if (r.code !== 0) this._fail(r, 'add')
    r = await this._run(['write-tree'])
    if (r.code !== 0) this._fail(r, 'write-tree')
    return r.stdout.toString('utf8').trim()
  }

  /** add -A（带排除），把全部工作区内容纳入索引。 */
  async _stageAll() {
    const r = await this._run(['add', '-A', '--', ...this._pathspecs('.')])
    if (r.code !== 0) this._fail(r, 'add')
  }

  /** 索引（暂存区）相对 base 是否有变化。base 缺省为 HEAD（无 HEAD 用空树）。 */
  async _stagedDirty() {
    const head = await this._run(['rev-parse', '--verify', 'HEAD'])
    const base = head.code === 0 ? 'HEAD' : EMPTY_TREE_SHA1
    const r = await this._run(['diff', '--cached', '--quiet', base])
    return r.code !== 0
  }

  /**
   * 全树快照：add -A → 有暂存变化才 commit。
   * @returns {{ committed: boolean, commitId: string|null, treeHash: string }}
   */
  async snapshot(message) {
    await this.ensure()
    await this._stageAll()
    if (!(await this._stagedDirty())) {
      return { committed: false, commitId: null, treeHash: await this.writeTree() }
    }
    const r = await this._run([
      '-c', 'user.name=dsh-rewind',
      '-c', 'user.email=rewind@dsh.local',
      'commit', '--no-verify', '--quiet', '-m', String(message || 'dsh-rewind snapshot'),
    ])
    if (r.code !== 0) this._fail(r, 'commit')
    const commitId = (await this._run(['rev-parse', 'HEAD'])).stdout.toString('utf8').trim()
    const treeHash = await this.writeTree()
    return { committed: true, commitId, treeHash }
  }

  /** 仅提交（无论是否脏都提交；用于 safety 点等必须落盘的场景）。 */
  async commitForce(message) {
    await this.ensure()
    await this._stageAll()
    const r = await this._run([
      '-c', 'user.name=dsh-rewind',
      '-c', 'user.email=rewind@dsh.local',
      'commit', '--no-verify', '--quiet', '-m', String(message || 'dsh-rewind safety'),
      '--allow-empty',
    ])
    if (r.code !== 0) this._fail(r, 'commit')
    const commitId = (await this._run(['rev-parse', 'HEAD'])).stdout.toString('utf8').trim()
    const treeHash = await this.writeTree()
    return { committed: true, commitId, treeHash }
  }

  /** 两个树之间的文件级差异。status: A=新增 M=修改 D=删除（相对 treeA→treeB）。 */
  async diffFiles(treeA, treeB) {
    const r = await this._run(['diff', '--name-status', '--no-renames', treeA, treeB])
    if (r.code !== 0) this._fail(r, 'diff')
    const out = r.stdout.toString('utf8')
    const files = []
    for (const line of out.split('\n')) {
      const m = /^([AMD])\s+(.+)$/.exec(line.trim())
      if (m) files.push({ status: m[1], path: m[2].replace(/"/g, '') })
    }
    return files
  }

  async hasTree(treeHash) {
    const r = await this._run(['cat-file', '-e', `${treeHash}^{tree}`])
    return r.code === 0
  }

  /** 从指定树读取一个文件的内容（Buffer，二进制安全）；文件不存在返回 null。 */
  async readFileFromTree(treeHash, relPath) {
    const r = await this._run(['cat-file', 'blob', `${treeHash}:${relPath}`])
    if (r.code !== 0) return null
    return r.stdout
  }

  /**
   * 把工作区精确恢复到目标树。
   * 1) 记录当前树 T0；2) 删除 T0 有而目标树没有的文件；3) read-tree + checkout-index 还原其余；
   * 恢复失败（如文件被占用）抛 ShadowGitError（携带 failedPath），由调用方用 T0 回滚。
   * @returns {{ before: string, deleted: string[] }}
   */
  async restoreTree(treeHash) {
    await this.ensure()
    if (!(await this.hasTree(treeHash))) {
      throw new ShadowGitError(`影子仓库中不存在树 ${treeHash}`, { code: 'TREE_NOT_FOUND' })
    }
    const before = await this.writeTree()
    if (before === treeHash) return { before, deleted: [] }

    // 1) 目标树没有的文件（T0→目标 视角为 D 的……注意 diffFiles(treeA,treeB) 的 D 表示 treeA 有 treeB 无）
    const gone = await this.diffFiles(before, treeHash)
    const toDelete = gone.filter((f) => f.status === 'D').map((f) => f.path)
    for (const rel of toDelete) {
      const abs = path.join(this.workspacePath, ...rel.split('/'))
      try { fs.rmSync(abs, { force: true, recursive: true }) } catch { /* 锁定文件在 checkout 阶段兜底 */ }
      // 清理因此变空的父目录（不越过工作区根）
      let dir = path.dirname(abs)
      const root = path.resolve(this.workspacePath)
      while (dir.startsWith(root) && dir !== root) {
        try {
          const entries = fs.readdirSync(dir)
          if (entries.length > 0) break
          fs.rmdirSync(dir)
        } catch { break }
        dir = path.dirname(dir)
      }
    }

    // 2) 还原目标树全部内容（Windows 下杀软/索引器可能短暂锁住新写入的文件，
    //    checkout-index 会跳过该文件并保持 exit 0 —— 用残留检查 + 重试兜底）
    let r = await this._run(['read-tree', treeHash])
    if (r.code !== 0) this._fail(r, 'read-tree')
    // 复核（规格 §7）：重扫工作区得到"实际树"，必须与目标树精确一致；
    // 能同时抓住漏写（目录占位/文件锁）、多写（未删除的残余）与内容不一致。
    let actual = null
    let failedPaths = []
    for (let attempt = 1; attempt <= 3; attempt++) {
      await this._run(['checkout-index', '-a', '-f'])
      actual = await this.writeTree() // add -A + write-tree
      if (actual === treeHash) break
      failedPaths = (await this.diffFiles(treeHash, actual)).slice(0, 10).map((f) => `${f.status} ${f.path}`)
      await new Promise((ok) => setTimeout(ok, 150 * attempt))
    }
    if (actual !== treeHash) {
      throw new ShadowGitError(`恢复工作区失败（${failedPaths.length} 个路径未达成一致，可能被占用或是目录占位）：${failedPaths.join('、')}`, {
        code: 'CHECKOUT_FAILED',
        failedPath: failedPaths[0],
      })
    }
    return { before, deleted: toDelete }
  }

  /** 当前树的 hash（等价 add -A 后 write-tree；用于校验）。 */
  async currentTree() {
    await this.ensure()
    return this.writeTree()
  }
}

export { EMPTY_TREE_SHA1, runProcess }
