// 诊断：最小复现"多轮快照后恢复 v1 失败"
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { ShadowGit, resolveGit } from '../lib/shadow-git.js'

const git = await resolveGit()
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rewind-diag-'))
const ws = path.join(tmp, 'ws')
fs.mkdirSync(ws, { recursive: true })
const shadow = new ShadowGit({ workspacePath: ws, shadowRoot: path.join(tmp, 'shadow'), git })

fs.writeFileSync(path.join(ws, 'seed.txt'), 'seed\n')
await shadow.snapshot('seed')

const trees = []
for (const v of ['v1', 'v2', 'v3']) {
  fs.writeFileSync(path.join(ws, 'step.txt'), v + '\n')
  const r = await shadow.snapshot('t-' + v)
  trees.push({ v, tree: r.treeHash, committed: r.committed })
}
console.log('trees:', trees)

fs.writeFileSync(path.join(ws, 'step.txt'), 'v3\n')
const target = trees[0]
console.log('restoring to', target.v, target.tree)
try {
  const out = await shadow.restoreTree(target.tree)
  console.log('restore ok:', out)
} catch (err) {
  console.log('restore failed:', err.message)
}
console.log('content now:', JSON.stringify(fs.readFileSync(path.join(ws, 'step.txt'), 'utf8')))
const idx = await shadow._run(['ls-files', '-s'])
console.log('index step.txt:', idx.stdout.toString().split('\n').filter((l) => l.includes('step')))
const st = await shadow._run(['status', '--porcelain'])
console.log('status:', JSON.stringify(st.stdout.toString()))
fs.rmSync(tmp, { recursive: true, force: true })
