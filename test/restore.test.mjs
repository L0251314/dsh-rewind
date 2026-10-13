// 恢复引擎与服务编排单元测试
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { restoreCode, rewindConversation, buildRestoreDiffs } from '../lib/restore.js'
import { RewindService } from '../lib/service.js'
import { CheckpointStore, ensureCheckpoint } from '../lib/store.js'
import { SessionTracker } from '../lib/capture.js'

function makeWs(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-rewind-restore-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

test('restoreCode：回写 modify、删除 create、恢复被删文件、跳过 skip、拒绝越界、失败可重试', t => {
  const ws = makeWs(t)
  fs.writeFileSync(path.join(ws, 'a.ts'), 'changed', 'utf8')
  fs.writeFileSync(path.join(ws, 'keep.ts'), 'keep', 'utf8')
  const checkpoints = [
    { turn: 1, files: [{ path: 'a.ts', kind: 'modify', content: 'orig-a' }] },
    { turn: 2, files: [{ path: 'sub/new.ts', kind: 'create' }, { path: '../evil.ts', kind: 'modify', content: 'evil' }, { path: 'big.bin', kind: 'skip' }, { path: 'gone.txt', kind: 'delete', content: 'RESURRECT' }] },
  ]
  const r = restoreCode(checkpoints, ws, 1)
  assert.equal(fs.readFileSync(path.join(ws, 'a.ts'), 'utf8'), 'orig-a')
  assert.equal(fs.existsSync(path.join(ws, 'sub', 'new.ts')), false, 'create 在轮前不存在 → 删除（本就无文件）')
  assert.equal(fs.readFileSync(path.join(ws, 'keep.ts'), 'utf8'), 'keep')
  assert.ok(!fs.existsSync(path.join(ws, '..', 'evil.ts')), '越界路径未写入')
  assert.equal(fs.readFileSync(path.join(ws, 'gone.txt'), 'utf8'), 'RESURRECT', '被删除文件按轮前快照恢复')
  assert.deepEqual(r.restored, ['a.ts', 'gone.txt'])
  assert.deepEqual(r.deleted, ['sub/new.ts'])
  assert.deepEqual(r.skipped, ['big.bin'])
  assert.equal(r.failed.length, 1)
  assert.match(r.failed[0].error, /工作区/)

  // create 的删除路径：先真实创建，再恢复删除
  fs.mkdirSync(path.join(ws, 'sub'), { recursive: true })
  fs.writeFileSync(path.join(ws, 'sub', 'new.ts'), 'x', 'utf8')
  const r2 = restoreCode(checkpoints, ws, 2)
  assert.equal(fs.existsSync(path.join(ws, 'sub', 'new.ts')), false)
  assert.deepEqual(r2.deleted, ['sub/new.ts'])
})

test('rewindConversation：单事件阴影化目标轮起的 surface（合法窗口 turn/step 由调用方传入）；无节点时为 no-op', () => {
  const appends = []
  const session = {
    surface: { nodes: [1, 4, 7, 9, 12] },
    append(type, data, opts) { appends.push({ type, data, opts }) },
  }
  const r = rewindConversation(session, 7, { turn: 3, step: 2 })
  assert.equal(r.shadowed, 3)
  assert.equal(r.startSeq, 7)
  assert.equal(r.endSeq, 12)
  assert.equal(r.turn, 3)
  // 仅一个 system/message 事件（agent/request 窗口内合法落盘）
  assert.equal(appends.length, 1)
  const a = appends[0]
  assert.equal(a.type, 'system/message')
  assert.deepEqual([a.data.turn, a.data.step], [3, 2], 'turn/step 取自 agent/request payload（requireOpenStep 校验）')
  assert.deepEqual(a.opts.surfaceOp, { op: 'replace', startSeq: 7, endSeq: 12 })
  assert.deepEqual(a.opts.sourceEventSeqs, [7, 9, 12], '必须精确覆盖被阴影节点')
  assert.deepEqual(a.data.message.content, [], '空 system 节点为休眠态，不投影')
  assert.deepEqual(a.data.message.source, { kind: 'system-prompt' }, '必须携带 producer-owned source（v4 校验）')

  const r2 = rewindConversation(session, 99, { turn: 3, step: 2 })
  assert.equal(r2.shadowed, 0)
  assert.equal(appends.length, 1, '无可回退节点时不 append')
})

test('rewindConversation：阴影范围含受保护 system head 时拆为 head 单独重写 + 其余批量阴影', () => {
  const appends = []
  const session = {
    surface: { nodes: [7, 9, 12] }, // nodes[0]=7 是受保护的 system head
    append(type, data, opts) { appends.push({ type, data, opts }) },
  }
  const r = rewindConversation(session, 4, { turn: 2, step: 1 })
  assert.equal(r.shadowed, 3)
  // head（7）单独重写 + 其余（9..12）批量阴影
  assert.equal(appends.length, 2)
  assert.deepEqual(appends[0].opts.surfaceOp, { op: 'replace', startSeq: 7, endSeq: 7 }, 'head 必须被恰好单独重写')
  assert.deepEqual(appends[0].opts.sourceEventSeqs, [7])
  assert.deepEqual(appends[1].opts.surfaceOp, { op: 'replace', startSeq: 9, endSeq: 12 })
  assert.deepEqual(appends[1].opts.sourceEventSeqs, [9, 12])
  assert.notEqual(appends[0].data.message.id, appends[1].data.message.id, '两个独立空 system 节点')
})

test('buildRestoreDiffs：含 old/new 文本；超限返回 null', t => {
  const ws = makeWs(t)
  fs.writeFileSync(path.join(ws, 'a.ts'), 'now', 'utf8')
  const checkpoints = [{ turn: 1, files: [{ path: 'a.ts', kind: 'modify', content: 'before' }] }]
  const diffs = buildRestoreDiffs(checkpoints, ws, 1)
  assert.deepEqual(diffs, [{ path: 'a.ts', oldText: 'before', newText: 'now' }])
  const big = [{ turn: 1, files: [{ path: 'a.ts', kind: 'modify', content: 'x'.repeat(300 * 1024) }] }]
  assert.equal(buildRestoreDiffs(big, ws, 1), null)
})

/** ---------- RewindService 编排 ---------- */

function buildService(t, { files = {} } = {}) {
  const ws = makeWs(t)
  for (const [p, c] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(ws, p)), { recursive: true })
    fs.writeFileSync(path.join(ws, p), c, 'utf8')
  }
  const store = new CheckpointStore({ root: path.join(ws, '_store') })
  const tracker = new SessionTracker(store)
  const session = { id: 's-x', header: { cwd: ws } }
  tracker.onSessionEvent(session, { type: 'turn/start', seq: 2, time: Date.now(), data: { turn: 1 } })
  tracker.onSessionEvent(session, { type: 'user/message', seq: 3, time: Date.now(), data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'make files' }] } })
  const liveSession = {
    surface: { nodes: [1, 4, 5] },
    appends: [],
    append(type, data, opts) { liveSession.appends.push({ type, data, opts }); liveSession.lastAppend = { type, data, opts } },
  }
  const ctx = {
    get(name) {
      if (name === 'sessions') return { get: () => liveSession, flush: async () => true }
      return null
    },
  }
  const service = new RewindService({ tracker, store, ctx, defer: (fn) => fn() })
  return { service, ws, session, liveSession }
}

test('service.restore：参数校验、未知轮次；conversation 统一挂 pending 由 agent/request 窗口执行', async t => {
  const { service } = buildService(t)
  assert.equal((await service.restore({ turn: 0, scope: 'code' })).ok, false)
  assert.equal((await service.restore({ turn: 1, scope: 'nope' })).ok, false)
  assert.equal((await service.restore({ turn: 9, scope: 'code' })).ok, false)
  // conversation：pending 延迟到下一次请求窗口
  const svc = buildService(t).service
  const deferred = await svc.restore({ turn: 1, scope: 'conversation' })
  assert.equal(deferred.ok, true)
  assert.equal(deferred.conversation.deferred, true)
  // both：代码即时生效，会话挂 pending
  const svc2 = buildService(t, { files: { 'x.txt': 'edited' } }).service
  svc2.tracker.sessions.get('s-x').checkpoints[0].files.push({ path: 'x.txt', kind: 'modify', content: 'orig' })
  const both = await svc2.restore({ turn: 1, scope: 'both' })
  assert.equal(both.ok, true)
  assert.ok(both.code, '代码部分即时执行')
  assert.equal(both.conversation.deferred, true, '会话部分挂 pending')

  // 下一次请求的 agent/request waterfall 触发折叠（turn/step 取自 payload）
  const live = svc2.ctx.get('sessions').get('s-x')
  svc2.onRequest({ agent: { session: { id: 's-x', ...live } }, turn: 2, step: 1 })
  assert.equal(live.appends.length, 1, 'agent/request 窗口内折叠落盘')
  const a = live.appends[0]
  assert.equal(a.type, 'system/message')
  assert.deepEqual([a.data.turn, a.data.step], [2, 1], 'turn/step 取自请求窗口')
  assert.deepEqual(a.opts.surfaceOp, { op: 'replace', startSeq: 4, endSeq: 5 })
})

test('service.restore code 范围：文件被恢复；conversation 折叠在请求窗口生效', async t => {
  const { service, ws, liveSession } = buildService(t, { files: { 'a.txt': 'edited' } })
  // 手工造两个可见轮：turn1 轮前 a.txt='seed'，turn2 轮前 a.txt='orig'
  const st = service.tracker.sessions.get('s-x')
  st.checkpoints[0].files.push({ path: 'a.txt', kind: 'modify', content: 'seed' })
  trackerAddTurn(st, 2, 20)
  st.checkpoints[1].files.push({ path: 'a.txt', kind: 'modify', content: 'orig' })

  // code 回滚到 turn2 → a.txt = orig（turn≥2 的检查点被硬裁剪）
  const r1 = await service.restore({ turn: 2, scope: 'code' })
  assert.equal(r1.ok, true)
  assert.equal(fs.readFileSync(path.join(ws, 'a.txt'), 'utf8'), 'orig')
  assert.equal(liveSession.lastAppend, undefined, 'code 范围不动会话')
  assert.equal(st.checkpoints.length, 1, 'turn2 检查点已裁剪')

  // both 回滚到 turn1 → a.txt = seed + conversation 挂 pending
  const r2 = await service.restore({ turn: 1, scope: 'both' })
  assert.equal(r2.ok, true)
  assert.equal(r2.conversation.deferred, true)
  assert.equal(liveSession.appends.length, 0, 'restore 时不立即 append（等请求窗口）')
  assert.equal(fs.readFileSync(path.join(ws, 'a.txt'), 'utf8'), 'seed')

  // agent/request 窗口触发
  service.onRequest({ agent: { session: { id: 's-x', ...liveSession } }, turn: 3, step: 1 })
  assert.equal(liveSession.appends.length, 1, '窗口内折叠落盘')
  assert.equal(liveSession.appends[0].data.turn, 3)

  const summary = service.summarize(r2)
  assert.match(summary, /第 1 轮/)
  assert.match(summary, /恢复 1 个文件/)
})

function trackerAddTurn(st, turn, seq) {
  st.turn = turn
  st.turnStartSeq = seq
  ensureCheckpoint(st.checkpoints, { turn, turnStartSeq: seq, time: Date.now() })
}

test('onRequest：无 pending 时为 no-op；写入失败重新挂回 pending', async t => {
  const { service } = buildService(t)
  // 无 pending：不 append
  const live = service.ctx.get('sessions').get('s-x')
  service.onRequest({ agent: { session: { id: 's-x', ...live } }, turn: 2, step: 1 })
  assert.equal(live.appends.length, 0, '无 pending 不动作')
  // 挂 pending，但 append 抛错 → 保留 pending
  await service.restore({ turn: 1, scope: 'conversation' })
  const bad = {
    id: 's-x',
    surface: { nodes: [1, 4, 5] },
    append() { throw new Error('boom') },
    appends: [],
  }
  service.onRequest({ agent: { session: bad }, turn: 5, step: 2 })
  assert.equal(service.pending.has('s-x'), true, '失败重新挂回 pending')
  // 下一次成功窗口执行
  const good = { id: 's-x', surface: { nodes: [1, 4, 5] }, appends: [], append(type, data, opts) { good.appends.push({ type, data, opts }) } }
  service.onRequest({ agent: { session: good }, turn: 6, step: 1 })
  assert.equal(good.appends.length, 1)
  assert.equal(good.appends[0].data.turn, 6)
})

test('service.listCheckpoints：含 turn/time/prompt/files + messages 映射', async t => {
  const { service } = buildService(t, { files: { 'b.txt': 'x' } })
  const st = service.tracker.sessions.get('s-x')
  st.checkpoints[0].files.push({ path: 'b.txt', kind: 'create' })
  st.checkpoints[0].promptFull = 'make files 全文'
  const list = service.listCheckpoints()
  assert.equal(list.sessionId, 's-x')
  assert.equal(list.checkpoints[0].prompt, 'make files')
  assert.deepEqual(list.checkpoints[0].files, [{ path: 'b.txt', kind: 'create' }])
  assert.deepEqual(list.messages, [{ turn: 1, promptFull: 'make files 全文', truncated: false }], 'messages 仅含真实用户输入轮')
})
