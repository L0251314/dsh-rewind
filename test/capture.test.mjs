// 捕获器单元测试
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { CheckpointStore } from '../lib/store.js'
import { SessionTracker } from '../lib/capture.js'

function makeWs(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-rewind-cap-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

function fakeSession(id, cwd) {
  return { id, header: { cwd } }
}

function turnEvent(turn, seq) { return { type: 'turn/start', seq, time: Date.now(), data: { turn } } }
function userEvent(seq, text) {
  return { type: 'user/message', seq, time: Date.now(), data: { source: { kind: 'user' }, content: [{ type: 'text', text }] } }
}

test('捕获：promptFull 全量存档（>160 不截断；32KB 上限截断标记）', async t => {
  const ws = makeWs(t)
  const store = new CheckpointStore({ root: path.join(ws, '_store') })
  const tracker = new SessionTracker(store)
  const session = fakeSession('s1', ws)
  const longMsg = '长'.repeat(5000) // >160 但 <32KB
  tracker.onSessionEvent(session, turnEvent(1, 1))
  tracker.onSessionEvent(session, userEvent(2, longMsg))
  const cp1 = tracker.sessions.get('s1').checkpoints[0]
  assert.equal(cp1.promptFull, longMsg, '全量保存不按 160 截断')
  assert.equal(cp1.prompt.length, 160 + 1, 'prompt 仍为 160 字摘要')

  const huge = 'x'.repeat(32 * 1024 + 100)
  tracker.onSessionEvent(session, turnEvent(2, 3))
  tracker.onSessionEvent(session, userEvent(4, huge))
  const cp2 = tracker.sessions.get('s1').checkpoints[1]
  assert.equal(cp2.promptFull.length, 32 * 1024, '超长截断到 32KB')
  assert.equal(cp2.promptTruncated, true, '截断由 promptTruncated 标记')
  assert.equal(cp1.promptTruncated, undefined, '未截断无标记')
})

test('捕获：bash 删除命令执行前快照（删除可恢复）；非删除命令不追踪', async t => {
  const ws = makeWs(t)
  fs.writeFileSync(path.join(ws, 'gone.txt'), 'GONE-CONTENT', 'utf8')
  const store = new CheckpointStore({ root: path.join(ws, '_store') })
  const tracker = new SessionTracker(store)
  const session = fakeSession('s1', ws)
  tracker.onSessionEvent(session, turnEvent(1, 1))

  await tracker.preExecute({ name: 'bash', arguments: { command: 'rm gone.txt' }, agent: { session } }, async () => ({}))
  const cp = tracker.sessions.get('s1').checkpoints[0]
  assert.deepEqual(cp.files, [{ path: 'gone.txt', kind: 'delete', content: 'GONE-CONTENT' }], 'rm 目标在删除前快照')

  await tracker.preExecute({ name: 'bash', arguments: { command: 'echo hello' }, agent: { session } }, async () => ({}))
  assert.equal(cp.files.length, 1, '非删除命令不产生快照')

  // pwsh 变体（Windows 桌面端实际使用的 shell 工具）；同路径去重，用第二文件验证
  fs.writeFileSync(path.join(ws, 'gone2.txt'), 'G2', 'utf8')
  await tracker.preExecute({ name: 'pwsh', arguments: { command: 'Remove-Item -Path "gone2.txt"' }, agent: { session } }, async () => ({}))
  assert.equal(cp.files.length, 2, 'pwsh 删除命令同样快照')
  assert.deepEqual(cp.files[1], { path: 'gone2.txt', kind: 'delete', content: 'G2' })
})

test('捕获：write 工具执行前快照；同轮去重；轮次锚定与提示词', async t => {
  const ws = makeWs(t)
  fs.writeFileSync(path.join(ws, 'a.ts'), 'v0', 'utf8')
  const store = new CheckpointStore({ root: path.join(ws, '_store') })
  const tracker = new SessionTracker(store)
  const session = fakeSession('s1', ws)

  tracker.onSessionEvent(session, turnEvent(1, 3))
  tracker.onSessionEvent(session, userEvent(4, '请修改 a.ts'))

  const nextCalls = []
  const next = async () => { nextCalls.push(1); return { kind: 'allow' } }
  await tracker.preExecute({ name: 'write', arguments: { file_path: 'a.ts' }, agent: { session } }, next)
  assert.equal(nextCalls.length, 1, '必须放行 next()')

  // 模拟工具已写入新内容，同轮再次执行 → 仍是轮前快照
  fs.writeFileSync(path.join(ws, 'a.ts'), 'v1', 'utf8')
  await tracker.preExecute({ name: 'write', arguments: { file_path: 'a.ts' }, agent: { session } }, next)

  const st = tracker.sessions.get('s1')
  assert.equal(st.checkpoints.length, 1)
  const cp = st.checkpoints[0]
  assert.equal(cp.turn, 1)
  assert.equal(cp.prompt, '请修改 a.ts')
  assert.deepEqual(cp.files, [{ path: 'a.ts', kind: 'modify', content: 'v0' }], '同轮去重且为轮前内容')
})

test('捕获：新建文件记 create；view 命令不追踪；bash 不追踪', async t => {
  const ws = makeWs(t)
  const store = new CheckpointStore({ root: path.join(ws, '_store') })
  const tracker = new SessionTracker(store)
  const session = fakeSession('s1', ws)
  tracker.onSessionEvent(session, turnEvent(1, 1))

  await tracker.preExecute({ name: 'str_replace_editor', arguments: { command: 'create', path: 'new.ts', content: 'x' }, agent: { session } }, async () => ({}))
  await tracker.preExecute({ name: 'str_replace_editor', arguments: { command: 'view', path: 'new.ts' }, agent: { session } }, async () => ({}))
  await tracker.preExecute({ name: 'bash', arguments: { command: 'echo hi > out.txt' }, agent: { session } }, async () => ({}))

  const cp = tracker.sessions.get('s1').checkpoints[0]
  assert.deepEqual(cp.files.map(f => f.path), ['new.ts'], '只有 create 记录；view 与 bash 不追踪')
  assert.equal(cp.files[0].kind, 'create')
})

test('捕获：越出工作区的路径被拒绝；相对路径正确解析', async t => {
  const ws = makeWs(t)
  fs.writeFileSync(path.join(ws, 'in.txt'), 'x', 'utf8')
  const store = new CheckpointStore({ root: path.join(ws, '_store') })
  const tracker = new SessionTracker(store)
  const session = fakeSession('s1', ws)
  tracker.onSessionEvent(session, turnEvent(1, 1))

  await tracker.preExecute({ name: 'edit', arguments: { file_path: 'in.txt' }, agent: { session } }, async () => ({}))
  await tracker.preExecute({ name: 'edit', arguments: { file_path: '../outside.txt' }, agent: { session } }, async () => ({}))
  await tracker.preExecute({ name: 'write', arguments: { file_path: path.join(ws, 'abs.txt') }, agent: { session } }, async () => ({}))

  const cp = tracker.sessions.get('s1').checkpoints[0]
  assert.deepEqual(cp.files.map(f => f.path), ['in.txt', 'abs.txt'], '越界路径被拒，相对与绝对路径都解析')
})

test('多会话隔离；disposeSession 落盘；重启后可恢复（新 tracker 载入历史）', async t => {
  const wsA = makeWs(t)
  const wsB = makeWs(t)
  const store = new CheckpointStore({ root: path.join(wsA, '_store') })
  const tracker = new SessionTracker(store)
  const s1 = fakeSession('s1', wsA)
  const s2 = fakeSession('s2', wsB)
  tracker.onSessionEvent(s1, turnEvent(1, 1))
  tracker.onSessionEvent(s2, turnEvent(1, 1))
  fs.writeFileSync(path.join(wsA, 'a.txt'), 'A', 'utf8')
  fs.writeFileSync(path.join(wsB, 'b.txt'), 'B', 'utf8')
  await tracker.preExecute({ name: 'write', arguments: { file_path: 'a.txt' }, agent: { session: s1 } }, async () => ({}))
  await tracker.preExecute({ name: 'write', arguments: { file_path: 'b.txt' }, agent: { session: s2 } }, async () => ({}))

  assert.notEqual(tracker.sessions.get('s1').checkpoints[0].files[0].path,
    tracker.sessions.get('s2').checkpoints[0].files[0].path, '两会话互不串扰')

  await tracker.disposeSession('s1', wsA)
  assert.ok(!tracker.sessions.has('s1'))

  // 新 tracker（模拟重启后 resume）从磁盘恢复检查点
  const tracker2 = new SessionTracker(new CheckpointStore({ root: store.root }))
  const st = tracker2.stateFor(s1)
  assert.equal(st.checkpoints.length, 1)
  assert.equal(st.checkpoints[0].files[0].content, 'A', '重启后回滚可用')
})
