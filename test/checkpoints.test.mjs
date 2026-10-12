// ============================================================================
// dsh-rewind —— CheckpointService 测试（真实影子仓库 + 桩 fork/rename）
// ============================================================================

import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, it } from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { resolveGit } from '../lib/shadow-git.js'
import { CheckpointService } from '../lib/checkpoints.js'

let git = null
let tmp = null

before(async () => {
  git = await resolveGit()
  if (!git) throw new Error('测试环境缺少 git')
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-rewind-svc-'))
})

after(() => {
  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { /* noop */ }
})

function makeService(name, { fork, rename, log } = {}) {
  const ws = path.join(tmp, name)
  fs.mkdirSync(ws, { recursive: true })
  // 影子仓库与索引必须放在工作区之外（与插件运行时布局一致：
  // 运行时位于 ~/.dsh/storages/rewind/，且 DEFAULT_EXCLUDES 已排除 .dsh）
  return new CheckpointService({
    workspacePath: ws,
    shadowRoot: path.join(tmp, `${name}--shadow`),
    indexPath: path.join(tmp, `${name}--index.json`),
    git,
    fork,
    rename,
    log: log ?? (() => {}),
  })
}

function write(wsPath, rel, content) {
  const abs = path.join(wsPath, ...rel.split('/'))
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, content)
}
function read(wsPath, rel) {
  return fs.readFileSync(path.join(wsPath, ...rel.split('/')), 'utf8')
}

describe('CheckpointService', () => {
  it('快照去重：树未变化复用 commit 且补边界记录', async () => {
    const ws = path.join(tmp, 'dedupe')
    fs.mkdirSync(ws, { recursive: true })
    const svc = makeService('dedupe')
    write(ws, 'f.txt', '1\n')
    const a = await svc.snapshot({ sessionId: 's1', turn: 1, trigger: 'turn', boundarySeq: 4 })
    assert.equal(a.committed, true)
    const b = await svc.snapshot({ sessionId: 's1', turn: 2, trigger: 'turn', boundarySeq: 9 })
    assert.equal(b.committed, false)
    assert.equal(b.treeHash, a.treeHash)
    assert.equal(b.boundarySeq, 9)
    const items = svc.list('s1')
    assert.equal(items.length, 2)
    assert.equal(items[0].id, a.id)
  })

  it('plan 输出受影响文件清单与计数', async () => {
    const name = 'plan'
    const ws = path.join(tmp, name)
    const svc = makeService(name)
    write(ws, 'a.txt', 'v1\n')
    write(ws, 'b.txt', 'keep\n')
    const cp = await svc.snapshot({ sessionId: 's', turn: 1, trigger: 'turn', boundarySeq: 3 })
    write(ws, 'a.txt', 'v2\n')
    write(ws, 'c.txt', 'new\n')
    fs.rmSync(path.join(ws, 'b.txt'))
    const plan = await svc.plan(cp.id)
    assert.equal(plan.counts.modified, 1)
    assert.equal(plan.counts.added, 1)
    assert.equal(plan.counts.deleted, 1)
    const byPath = Object.fromEntries(plan.files.map((f) => [f.path, f.status]))
    assert.equal(byPath['a.txt'], 'M') // 回退将还原修改
    assert.equal(byPath['b.txt'], 'A') // 回退将恢复被删文件
    assert.equal(byPath['c.txt'], 'D') // 回退将移除后建文件
  })

  it('restore：代码精确恢复 + fork(boundarySeq) 调用 + rename 回调', async () => {
    const name = 'restore-ok'
    const ws = path.join(tmp, name)
    const forks = []
    const renames = []
    const svc = makeService(name, {
      fork: async (sessionId, boundarySeq) => { forks.push({ sessionId, boundarySeq }); return 'child-1' },
      rename: async (parent, child, turn) => { renames.push({ parent, child, turn }) },
    })
    write(ws, 'code.js', 'v1\n')
    const cp = await svc.snapshot({ sessionId: 'sess-1', turn: 2, trigger: 'turn', boundarySeq: 12 })
    write(ws, 'code.js', 'v2-broken\n')
    write(ws, 'junk.log', 'extra\n')

    const result = await svc.restore(cp.id)
    assert.equal(result.ok, true)
    assert.equal(result.verified, true)
    assert.equal(result.childSessionId, 'child-1')
    assert.deepEqual(forks, [{ sessionId: 'sess-1', boundarySeq: 12 }])
    assert.deepEqual(renames, [{ parent: 'sess-1', child: 'child-1', turn: 2 }])
    assert.equal(read(ws, 'code.js'), 'v1\n')
    assert.ok(!fs.existsSync(path.join(ws, 'junk.log')))
    // 恢复后当前树 == 检查点树
    const verify = await svc.verify(cp.id)
    assert.equal(verify.match, true)
    // 检查点标记已恢复
    assert.equal(svc.get(cp.id).restored, true)
  })

  it('restore：代码恢复失败自动回滚安全点', async () => {
    const name = 'restore-restore-fail'
    const ws = path.join(tmp, name)
    const svc = makeService(name)
    // 桩：恢复目标树时抛错（模拟文件锁），回滚安全点走真实实现
    const realRestore = svc.shadow.restoreTree.bind(svc.shadow)
    let failNext = true
    svc.shadow.restoreTree = async (tree) => {
      if (failNext) { failNext = false; throw new Error('boom: 模拟文件被占用') }
      return realRestore(tree)
    }
    write(ws, 'f.txt', 'before\n')
    const cp = await svc.snapshot({ sessionId: 's', turn: 1, trigger: 'turn', boundarySeq: 2 })
    write(ws, 'f.txt', 'after\n')
    const result = await svc.restore(cp.id)
    assert.equal(result.ok, false)
    assert.equal(result.code, 'RESTORE_FAILED')
    assert.match(result.message, /boom/)
    assert.equal(read(ws, 'f.txt'), 'after\n', '恢复失败必须回滚到 safety 点（工作区原状）')
  })

  it('restore：fork 失败时代码回滚到回退前状态', async () => {
    const name = 'restore-fork-fail'
    const ws = path.join(tmp, name)
    const svc = makeService(name, {
      fork: async () => { throw new Error('fork exploded') },
    })
    write(ws, 'f.txt', 'before\n')
    const cp = await svc.snapshot({ sessionId: 's', turn: 1, trigger: 'turn', boundarySeq: 2 })
    write(ws, 'f.txt', 'after\n')
    const result = await svc.restore(cp.id)
    assert.equal(result.ok, false)
    assert.equal(result.code, 'FORK_FAILED')
    assert.equal(read(ws, 'f.txt'), 'after\n', 'fork 失败必须把代码回滚到 safety 点')
  })

  it('restore：目标不存在返回 NOT_FOUND', async () => {
    const svc = makeService('restore-missing')
    const result = await svc.restore('no-such-id')
    assert.equal(result.ok, false)
    assert.equal(result.code, 'NOT_FOUND')
  })

  it('索引跨实例持久化', async () => {
    const name = 'persist'
    const ws = path.join(tmp, name)
    fs.mkdirSync(ws, { recursive: true })
    const svc1 = makeService(name)
    write(ws, 'p.txt', 'data\n')
    const cp = await svc1.snapshot({ sessionId: 's', turn: 1, trigger: 'turn', boundarySeq: 1 })
    const svc2 = makeService(name)
    assert.equal(svc2.get(cp.id)?.id, cp.id)
    assert.equal(svc2.list('s').length, 1)
  })

  it('findByTurn 取该轮最早的检查点', async () => {
    const name = 'by-turn'
    const ws = path.join(tmp, name)
    fs.mkdirSync(ws, { recursive: true })
    const svc = makeService(name)
    write(ws, 'x.txt', '1\n')
    await svc.snapshot({ sessionId: 's', turn: 3, trigger: 'turn', boundarySeq: 5 })
    write(ws, 'x.txt', '2\n')
    const second = await svc.snapshot({ sessionId: 's', turn: 3, trigger: 'pre-write', boundarySeq: 6 })
    const found = svc.findByTurn('s', 3)
    assert.equal(found.boundarySeq, 5)
    assert.notEqual(found.id, second.id)
  })
})
