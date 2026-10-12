// 诊断：目录占位场景（目标树 a.txt=文件，工作区 a.txt=目录[仅排除内容]）
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { ShadowGit, resolveGit } from '../lib/shadow-git.js'

const git = await resolveGit()
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rewind-diag2-'))
const ws = path.join(tmp, 'ws')
fs.mkdirSync(ws, { recursive: true })
const shadow = new ShadowGit({ workspacePath: ws, shadowRoot: path.join(tmp, 'shadow'), git })

fs.writeFileSync(path.join(ws, 'base.txt'), 'base\n')
fs.writeFileSync(path.join(ws, 'a.txt'), 'file version\n')
const target = await shadow.snapshot('a-as-file')
console.log('target tree:', target.treeHash, 'committed:', target.committed)

fs.rmSync(path.join(ws, 'a.txt'))
fs.mkdirSync(path.join(ws, 'a.txt', 'node_modules'), { recursive: true })
fs.writeFileSync(path.join(ws, 'a.txt', 'node_modules', 'x.js'), 'x\n')
const safety = await shadow.snapshot('safety')
console.log('safety committed:', safety.committed, safety.treeHash)
const st0 = await shadow._run(['status', '--porcelain'])
console.log('status before restore:', JSON.stringify(st0.stdout.toString()))

try {
  const out = await shadow.restoreTree(target.treeHash)
  console.log('restore OK (unexpected):', out)
} catch (err) {
  console.log('restore threw:', err.code, '-', err.message.slice(0, 200))
}
console.log('a.txt is dir?', fs.statSync(path.join(ws, 'a.txt')).isDirectory())
console.log('x.js exists?', fs.existsSync(path.join(ws, 'a.txt', 'node_modules', 'x.js')))
fs.rmSync(tmp, { recursive: true, force: true })
