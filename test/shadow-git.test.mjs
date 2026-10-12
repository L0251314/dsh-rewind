// ============================================================================
// dsh-rewind —— ShadowGit 集成测试（真实 git + 临时工作区）
// 运行：node --test test/
// 覆盖：快照精确性、恢复精确性（整树 hash 断言）、中文文件名、二进制、
//       嵌套目录、删除/新增/修改、恢复失败自动回滚。
// ============================================================================

import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { ShadowGit, resolveGit, workspaceHash } from '../lib/shadow-git.js'

let git = null
let tmp = null
let ws = null
let shadow = null

function write(rel, content) {
  const abs = path.join(ws, ...rel.split('/'))
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, content)
}
function read(rel) {
  return fs.readFileSync(path.join(ws, ...rel.split('/')))
}
function rm(rel) {
  fs.rmSync(path.join(ws, ...rel.split('/')), { force: true, recursive: true })
}

before(async () => {
  git = await resolveGit()
  if (!git) throw new Error('测试环境缺少 git')
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-rewind-test-'))
  ws = path.join(tmp, 'ws')
  fs.mkdirSync(ws, { recursive: true })
  shadow = new ShadowGit({ workspacePath: ws, shadowRoot: path.join(tmp, 'shadow'), git })
})

after(() => {
  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { /* Windows 句柄延迟 */ }
})

describe('ShadowGit', () => {
  it('workspaceHash 稳定且与分隔符无关', () => {
    const a = workspaceHash('C:\\Users\\测试\\proj')
    const b = workspaceHash('C:/Users/测试/proj')
    assert.equal(a, b)
    assert.equal(a, workspaceHash('C:\\Users\\测试\\proj\\'))
    assert.notEqual(a, workspaceHash('C:/Users/测试/proj2'))
  })

  it('ensure 创建影子仓库且不污染用户工作区', async () => {
    await shadow.ensure()
    assert.ok(fs.existsSync(path.join(shadow.gitDir, 'HEAD')))
    // 工作区没有 .git（影子在别处）
    assert.ok(!fs.existsSync(path.join(ws, '.git')))
    // 用户自带的 .git 也不受影响（独立场景）
    const ws2 = path.join(tmp, 'ws2')
    fs.mkdirSync(ws2, { recursive: true })
    fs.mkdirSync(path.join(ws2, '.git'), { recursive: true })
    fs.writeFileSync(path.join(ws2, '.git', 'HEAD'), 'user repo')
    const s2 = new ShadowGit({ workspacePath: ws2, shadowRoot: path.join(tmp, 'shadow'), git })
    await s2.ensure()
    assert.equal(fs.readFileSync(path.join(ws2, '.git', 'HEAD'), 'utf8'), 'user repo')
  })

  it('空工作区可快照', async () => {
    const res = await shadow.snapshot('empty')
    assert.match(res.treeHash, /^[0-9a-f]{40}$/)
  })

  it('快照→修改→恢复：文件内容精确还原（含中文/二进制/嵌套）', async () => {
    write('hello.txt', '你好，世界 v1\n')
    write('docs/中文 文件名.md', '# 中文标题\n内容一\n')
    write('nested/deep/dir/a.js', 'console.log(1)\n')
    write('blob.bin', Buffer.from([0, 1, 2, 255, 254, 0x0d, 0x0a, 0x00]))

    const cp = await shadow.snapshot('turn-1')
    assert.equal(cp.committed, true)
    assert.match(cp.treeHash, /^[0-9a-f]{40}$/)

    // 破坏现场：改、删、增
    write('hello.txt', '被 agent 改坏了\n')
    rm('docs/中文 文件名.md')
    write('new-file.txt', '多出来的文件\n')
    write('nested/deep/dir/a.js', 'console.log(999)\n')

    const restore = await shadow.restoreTree(cp.treeHash)
    assert.ok(restore.deleted.includes('new-file.txt'))

    // 整树精确相等
    const afterTree = await shadow.currentTree()
    assert.equal(afterTree, cp.treeHash, '恢复后整树 hash 必须等于检查点树')
    // 逐文件内容断言
    assert.equal(read('hello.txt').toString('utf8'), '你好，世界 v1\n')
    assert.equal(read('docs/中文 文件名.md').toString('utf8'), '# 中文标题\n内容一\n')
    assert.equal(read('nested/deep/dir/a.js').toString('utf8'), 'console.log(1)\n')
    assert.deepEqual([...read('blob.bin')], [0, 1, 2, 255, 254, 0x0d, 0x0a, 0x00])
    assert.ok(!fs.existsSync(path.join(ws, 'new-file.txt')), '新增文件必须被移除')
  })

  it('树未变化时 snapshot 不产生新 commit', async () => {
    const before = await shadow.currentTree()
    const r1 = await shadow.snapshot('no-change')
    assert.equal(r1.committed, false)
    assert.equal(r1.treeHash, before)
  })

  it('diffFiles 报告 修改/删除/新增', async () => {
    const base = await shadow.snapshot('diff-base')
    write('hello.txt', '改了\n')
    rm('blob.bin')
    write('added.txt', 'new\n')
    const next = await shadow.snapshot('diff-next')
    const files = await shadow.diffFiles(base.treeHash, next.treeHash)
    const byPath = Object.fromEntries(files.map((f) => [f.path, f.status]))
    assert.equal(byPath['hello.txt'], 'M')
    assert.equal(byPath['blob.bin'], 'D')
    assert.equal(byPath['added.txt'], 'A')
  })

  it('readFileFromTree 二进制安全', async () => {
    write('blob2.bin', Buffer.from([9, 8, 7, 0, 0, 250]))
    const tree = await shadow.currentTree()
    const buf = await shadow.readFileFromTree(tree, 'blob2.bin')
    assert.ok(buf)
    assert.deepEqual([...buf.slice(0, 3)], [9, 8, 7])
    assert.equal(await shadow.readFileFromTree(tree, 'no-such.txt'), null)
  })

  it('目录占位（仅含忽略文件）：git 强制清障后仍精确恢复', async () => {
    // 目标树：a.txt 是"文件"
    write('a.txt', 'file version\n')
    const target = await shadow.snapshot('a-as-file')
    // 现场：a.txt 变成"目录"，里面只有被排除的 node_modules 文件
    rm('a.txt')
    write('a.txt/node_modules/x.js', 'x\n')
    const safety = await shadow.snapshot('safety')
    assert.equal(safety.committed, true)

    // git checkout-index 会清掉仅含忽略文件的阻碍目录，精确还原 a.txt 文件
    await shadow.restoreTree(target.treeHash)
    assert.equal(await shadow.currentTree(), target.treeHash, '整树必须精确一致')
    assert.equal(fs.statSync(path.join(ws, 'a.txt')).isDirectory(), false)
    // （OS 级文件锁导致的恢复失败路径在 checkpoints.test.mjs 以桩测试覆盖）
  })

  it('多轮快照独立可回退', async () => {
    write('step.txt', 'v1\n')
    const cp1 = await shadow.snapshot('t1')
    write('step.txt', 'v2\n')
    const cp2 = await shadow.snapshot('t2')
    write('step.txt', 'v3\n')
    const cp3 = await shadow.snapshot('t3')
    assert.notEqual(cp1.treeHash, cp2.treeHash)
    assert.notEqual(cp2.treeHash, cp3.treeHash)

    await shadow.restoreTree(cp1.treeHash)
    assert.equal(read('step.txt').toString(), 'v1\n')
    await shadow.restoreTree(cp3.treeHash)
    assert.equal(read('step.txt').toString(), 'v3\n')
  })
})
