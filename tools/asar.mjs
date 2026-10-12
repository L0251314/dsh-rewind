// Minimal asar reader (no deps): list or extract entries from app.asar
import fs from 'node:fs'
import path from 'node:path'

const [,, asarPath, mode, pattern] = process.argv
const fd = fs.openSync(asarPath, 'r')
const head = Buffer.alloc(16)
fs.readSync(fd, head, 0, 16, 0)
const headerSize = head.readUInt32LE(4)
const jsonSize = head.readUInt32LE(12)
const jsonBuf = Buffer.alloc(jsonSize)
fs.readSync(fd, jsonBuf, 0, jsonSize, 16)
const header = JSON.parse(jsonBuf.toString('utf8'))
const dataStart = 8 + headerSize

function walk(node, prefix, out) {
  if (!node.files) return
  for (const [name, child] of Object.entries(node.files)) {
    const p = `${prefix}/${name}`
    if (child.files) walk(child, p, out)
    else out.push({ path: p, size: child.size, offset: child.offset })
  }
}

const files = []
walk(header, '', files)

if (mode === 'list') {
  const re = pattern ? new RegExp(pattern) : null
  const dirs = new Set()
  for (const f of files) if (!re || re.test(f.path)) { console.log(f.path) }
  // also print implicit directories matching pattern
  if (re) {
    for (const f of files) {
      if (re.test(f.path)) {
        const parts = f.path.split('/')
        for (let i = 1; i < parts.length; i++) {
          const d = parts.slice(0, i).join('/')
          if (!dirs.has(d)) { dirs.add(d) }
        }
      }
    }
  }
} else if (mode === 'extract') {
  const re = new RegExp(pattern)
  let n = 0
  for (const f of files) {
    if (!re.test(f.path)) continue
    const dest = path.join(process.cwd(), 'asar-out', f.path.split('/').filter(Boolean).join(path.sep))
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    const buf = Buffer.alloc(f.size)
    fs.readSync(fd, buf, 0, f.size, dataStart + Number(f.offset))
    fs.writeFileSync(dest, buf)
    n++
  }
  console.log(`extracted ${n} files`)
}
