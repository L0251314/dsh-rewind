// 存储层单元测试
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { CheckpointStore, ensureCheckpoint, recordFileSnap, planCodeRestore } from '../lib/store.js'
import { workspaceHash, sessionStorePath } from '../lib/util.js'

function tmpRoot(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-rewind-store-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

test('ensureCheckpoint：创建并保持 turn 升序；同轮不重复创建；提示词首次为空时回填', () => {
  const cps = []
  const a = ensureCheckpoint(cps, { turn: 2, turnStartSeq: 10, time: 2 })
  const b = ensureCheckpoint(cps, { turn: 1, turnStartSeq: 5, time: 1 })
  ensureCheckpoint(cps, { turn: 2, turnStartSeq: 10, time: 2, prompt: 'hello' })
  assert.equal(cps.length, 2)
  assert.deepEqual(cps.map(c => c.turn), [1, 2])
  assert.equal(a, cps[1])
  assert.equal(b, cps[0])
  assert.equal(cps[1].prompt, 'hello', '同轮后补提示词应回填')
})

test('recordFileSnap：同轮同路径去重；create 不带 content', () => {
  const cp = { turn: 1, turnStartSeq: 1, time: 1, prompt: '', files: [] }
  assert.equal(recordFileSnap(cp, 'a.ts', 'modify', 'old'), true)
  assert.equal(recordFileSnap(cp, 'a.ts', 'modify', 'changed'), false, '第二次触碰不覆盖轮前状态')
  assert.equal(recordFileSnap(cp, 'b.ts', 'create'), true)
  assert.equal(cp.files.length, 2)
  assert.deepEqual(cp.files[1], { path: 'b.ts', kind: 'create' })
})

test('planCodeRestore：目标轮（含）之后按路径取最早快照', () => {
  const cps = [
    { turn: 1, files: [{ path: 'a.ts', kind: 'modify', content: 'A0' }, { path: 'b.ts', kind: 'create' }] },
    { turn: 2, files: [{ path: 'a.ts', kind: 'modify', content: 'A1' }] },
    { turn: 3, files: [{ path: 'c.ts', kind: 'create' }] },
  ]
  const plan = planCodeRestore(cps, 2)
  assert.equal(plan.length, 2, 'a.ts 取 turn2 的最早版，c.ts 新建')
  assert.equal(plan.find(p => p.path === 'a.ts').content, 'A1')
  assert.ok(plan.find(p => p.path === 'c.ts'))
  const planAll = planCodeRestore(cps, 1)
  assert.equal(planAll.find(p => p.path === 'a.ts').content, 'A0')
})

test('CheckpointStore：save/load 往返；损坏文件容忍；prune 只清自己根目录', t => {
  const root = tmpRoot(t)
  const store = new CheckpointStore({ root })
  const cwd = path.join(root, 'ws')
  fs.mkdirSync(cwd, { recursive: true })
  const cps = [ensureCheckpoint([], { turn: 1, turnStartSeq: 3, time: 111, prompt: 'p1' })]
  recordFileSnap(cps[0], 'x.txt', 'modify', 'old-x')
  store.save(cwd, 'session-abc', cps)
  const file = sessionStorePath(root, cwd, 'session-abc')
  assert.ok(fs.existsSync(file))
  assert.equal(store.load(cwd, 'session-abc')[0].files[0].content, 'old-x')

  // 损坏文件 → null
  fs.writeFileSync(file, '{oops', 'utf8')
  assert.equal(store.load(cwd, 'session-abc'), null)

  // prune：过期删除（含损坏的会话文件——按 mtime 处理）
  fs.writeFileSync(path.join(path.dirname(file), 'old.json'), JSON.stringify({ v: 1 }))
  const past = new Date(Date.now() - 40 * 24 * 3600 * 1000)
  fs.utimesSync(path.join(path.dirname(file), 'old.json'), past, past)
  fs.utimesSync(file, past, past)
  const { removed } = store.prune()
  assert.ok(removed.some(f => f.endsWith('old.json')), '过期文件应被清理')
  assert.ok(removed.includes(file), '损坏的会话文件同样按 mtime 清理')
})

test('workspaceHash / sessionStorePath：稳定且与 cwd 关联', () => {
  const h1 = workspaceHash('C:\\Work\\Proj')
  const h2 = workspaceHash('c:/work/proj/')
  assert.equal(h1, h2, '大小写与分隔符归一')
  assert.equal(h1.length, 16)
})
