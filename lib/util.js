// dsh-rewind —— 工具函数（零依赖，纯 Node）
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'

/** 插件数据根目录：~/.dsh/rewind/v1（与官方 sessions/ 完全隔离） */
export function rewindRoot(dshHome) {
  const home = dshHome || process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  return path.join(home, 'rewind', 'v1')
}

/** 工作区目录 → 稳定短哈希（Windows 大小写/分隔符不敏感，统一归一） */
export function workspaceHash(cwd) {
  const norm = path.normalize(String(cwd || '')).replace(/[\\/]+$/, '').toLowerCase()
  return crypto.createHash('sha256').update(norm).digest('hex').slice(0, 16)
}

/** 会话存储文件路径：<root>/<wsHash>/<sessionId>.json */
export function sessionStorePath(root, cwd, sessionId) {
  return path.join(root, workspaceHash(cwd), `${sessionId}.json`)
}

/** 原子写入 JSON（tmp + rename，避免半写文件） */
export function atomicWriteJson(file, data) {
  const dir = path.dirname(file)
  fs.mkdirSync(dir, { recursive: true })
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`)
  fs.writeFileSync(tmp, JSON.stringify(data), 'utf8')
  try {
    fs.renameSync(tmp, file)
  } catch (err) {
    // Windows rename 覆盖已存在文件偶发 EPERM/EEXIST，退化为覆盖写
    try { fs.copyFileSync(tmp, file); fs.rmSync(tmp, { force: true }) } catch { throw err }
  }
}

/** 读取 JSON；损坏返回 null（单文件损坏不影响整体） */
export function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

/** 把任意路径解析为 workspace 内的绝对路径；越界返回 null */
export function resolveInsideWorkspace(cwd, rawPath) {
  if (typeof rawPath !== 'string' || rawPath.length === 0) return null
  const abs = path.isAbsolute(rawPath) ? path.normalize(rawPath) : path.resolve(cwd, rawPath)
  const root = path.resolve(cwd)
  const rel = path.relative(root, abs)
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return null
  return abs
}

/** 工作区内路径 → 工作区相对路径（统一 / 分隔） */
export function toWorkspaceRel(cwd, absPath) {
  const rel = path.relative(path.resolve(cwd), absPath)
  return rel.split(path.sep).join('/')
}

/** 截断文本用于检查点标签 */
export function summarizePrompt(text, max = 160) {
  const s = String(text || '').replace(/\s+/g, ' ').trim()
  return s.length > max ? s.slice(0, max) + '…' : s
}

/** 安全移除目录树（仅限 rewind 数据根内），返回是否删除 */
export function rmRfInside(root, target) {
  const abs = path.resolve(target)
  const base = path.resolve(root)
  if (abs === base || !abs.startsWith(base + path.sep)) return false
  fs.rmSync(abs, { recursive: true, force: true })
  return true
}

/** 列出目录下所有文件（递归），返回 [{file, size, mtime}] */
export function listFilesDeep(dir) {
  const out = []
  let entries = []
  try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return out }
  for (const e of entries) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) out.push(...listFilesDeep(p))
    else {
      let st = null
      try { st = fs.statSync(p) } catch { continue }
      out.push({ file: p, size: st.size, mtime: st.mtimeMs })
    }
  }
  return out
}
