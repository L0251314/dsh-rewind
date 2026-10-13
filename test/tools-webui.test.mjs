// 工具定义与 Web 路由/注入单元测试
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { EventEmitter } from 'node:events'
import { buildRewindListTool, buildRewindRestoreTool } from '../lib/tools.js'
import { buildRoutes, pushInjectRows, PANEL_CSS, PANEL_JS, MESSAGE_JS, MSG_CSS } from '../lib/webui.js'
import { RewindService } from '../lib/service.js'
import { CheckpointStore } from '../lib/store.js'
import { SessionTracker } from '../lib/capture.js'

function makeService(t) {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-rewind-tools-'))
  t.after(() => fs.rmSync(ws, { recursive: true, force: true }))
  const store = new CheckpointStore({ root: path.join(ws, '_store') })
  const tracker = new SessionTracker(store)
  const session = { id: 's1', header: { cwd: ws } }
  tracker.onSessionEvent(session, { type: 'turn/start', seq: 1, time: 1000, data: { turn: 1 } })
  tracker.onSessionEvent(session, { type: 'user/message', seq: 2, time: 1000, data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'hello' }] } })
  return new RewindService({ tracker, store, ctx: { get: () => null } })
}

test('rewind_list：execute 输出检查点（投影剔除 messages），render 为文本', async t => {
  const tool = buildRewindListTool(makeService(t))
  assert.equal(tool.name, 'rewind_list')
  const value = await tool.execute({})
  assert.equal(value.checkpoints.length, 1)
  assert.equal(value.checkpoints[0].turn, 1)
  assert.equal('messages' in value, false, 'messages 不进入模型工具输出（schema 外字段）')
  const rendered = tool.output.render({}, value)
  assert.equal(rendered[0].type, 'text')
  assert.match(rendered[0].text, /第 1 轮/)
})

test('rewind_restore：execute 走 service.restore；diff 卡与 generic 卡', async t => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-rewind-tools2-'))
  t.after(() => fs.rmSync(ws, { recursive: true, force: true }))
  fs.writeFileSync(path.join(ws, 'a.txt'), 'new', 'utf8')
  const store = new CheckpointStore({ root: path.join(ws, '_store') })
  const tracker = new SessionTracker(store)
  const session = { id: 's1', header: { cwd: ws } }
  tracker.onSessionEvent(session, { type: 'turn/start', seq: 1, time: 1, data: { turn: 1 } })
  tracker.stateFor(session).checkpoints[0].files.push({ path: 'a.txt', kind: 'modify', content: 'old' })
  tracker.stateFor(session).checkpoints[0].files.push({ path: 'g.txt', kind: 'create' })
  const service = new RewindService({ tracker, store, ctx: { get: () => null } })

  const tool = buildRewindRestoreTool(service)
  assert.equal(tool.name, 'rewind_restore')

  const bad = await tool.execute({ turn: 0, scope: 'code' })
  assert.equal(bad.ok, false)
  assert.match(tool.output.render({}, bad)[0].text, /失败/)

  const ok = await tool.execute({ turn: 1, scope: 'code' })
  assert.equal(ok.ok, true)
  assert.equal(fs.readFileSync(path.join(ws, 'a.txt'), 'utf8'), 'old', '文件被恢复')

  // presentationMeta + presentResult：有文件恢复时出 diff 卡
  const meta = tool.output.presentationMeta({}, ok)
  assert.ok(Array.isArray(meta.diffs) && meta.diffs.some(d => d.path === 'a.txt'))
  const card = tool.presentResult({}, { content: ok, isError: false, meta })
  assert.equal(card.card, 'diff')
  assert.ok(card.diffs.length >= 1)
})

function fakeRes() {
  const res = new EventEmitter()
  res.statusCode = 0
  res.headers = null
  res.body = ''
  res.writeHead = (code, headers) => { res.statusCode = code; res.headers = headers }
  res.end = (b) => { res.body = String(b || ''); res.emit('done') }
  return res
}

test('webui：路由 GET checkpoints / POST restore / 方法拒绝与坏 JSON', async t => {
  const service = makeService(t)
  const routes = buildRoutes(service)
  const byPath = Object.fromEntries(routes.map(r => [r.path, r]))
  assert.ok(byPath['/dsh-rewind/api/checkpoints'])
  assert.ok(byPath['/dsh-rewind/api/restore'])

  // GET checkpoints
  let res = fakeRes()
  await byPath['/dsh-rewind/api/checkpoints'].handler(
    { method: 'GET', url: '/dsh-rewind/api/checkpoints?sessionId=s1' }, res)
  assert.equal(res.statusCode, 200)
  assert.equal(JSON.parse(res.body).sessionId, 's1')

  // POST restore 坏 JSON → 400
  async function postRestore(body) {
    const req = new EventEmitter()
    req.method = 'POST'
    req.url = '/dsh-rewind/api/restore'
    const r = fakeRes()
    const p = byPath['/dsh-rewind/api/restore'].handler(req, r)
    if (body !== undefined) req.emit('data', Buffer.from(body))
    req.emit('end')
    await p
    return r
  }
  const badRes = await postRestore('{bad')
  assert.equal(badRes.statusCode, 400)

  // POST restore 合法但无该轮次 → 409
  const conflictRes = await postRestore(JSON.stringify({ turn: 99, scope: 'code' }))
  assert.equal(conflictRes.statusCode, 409)
})

test('webui：注入行默认=配置+消息级脚本，panel:true 才含悬浮面板', () => {
  const table = []
  pushInjectRows(table)
  assert.equal(table[0].kind, 'global', '配置经 global 行注入')
  assert.deepEqual(table[0].value, { confirm: true })
  assert.equal(table[1].kind, 'style')
  assert.equal(table[2].kind, 'script')
  assert.equal(table.length, 3, '默认不含悬浮面板行')
  assert.ok(MSG_CSS.includes('data-dsh-rw-btn'))
  assert.ok(MESSAGE_JS.includes('cJsG2q_userRow'), '识别用户消息行')
  assert.ok(MESSAGE_JS.includes('xD_KDq_action'), '复用原生按钮样式类')
  assert.ok(MESSAGE_JS.includes('MutationObserver'), '转写动态监听')
  assert.ok(MESSAGE_JS.includes('insertText'), '回填输入框')
  assert.ok(MESSAGE_JS.includes("scope: 'both'"), '一键回退 both 范围')

  const table2 = []
  pushInjectRows(table2, { panel: true, confirm: false })
  assert.ok(table2[0].value.confirm === false)
  const kinds = table2.map(r => r.kind).join(',')
  assert.ok(PANEL_CSS.length > 0 && PANEL_JS.includes('dsh-rewind-btn'))
  assert.equal(table2.length, 5, 'panel:true 追加 2 行')
  assert.ok(kinds.includes('style') && kinds.includes('script'))
})
