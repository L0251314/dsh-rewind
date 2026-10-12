// 离线复现：用桩 cordis root/ctx 走一遍 dsh-rewind 的 apply() 全路径
import mod from '../lib/index.js'

const events = []
const stubCtx = {
  get(name) {
    if (name === 'webServer') return { register: (r) => { events.push(['webServer.register', r.path]); return () => {} }, tapIndex: () => () => {} }
    if (name === 'tools') return { register: (d) => { events.push(['tools.register', d.name]); return () => {} }, guard: () => () => {} }
    if (name === 'commands') return { register: (d) => { events.push(['commands.register', d.name]); return () => {} } }
    if (name === 'sessions') return { get: () => undefined, fork: () => { throw new Error('stub') } }
    if (name === 'connection') return { requestRejection: () => 403 }
    return undefined
  },
  sessions: { get: () => undefined },
  on: (name, fn) => { events.push(['ctx.on', name]); return () => {} },
}

const root = {
  inject(names, cb) {
    events.push(['root.inject', names.join(',')])
    try {
      cb(stubCtx)
      events.push(['inject-callback ok'])
    } catch (err) {
      events.push(['inject-callback THREW', String(err && err.stack ? err.stack.split('\n').slice(0, 4).join(' | ') : err)])
    }
    return () => {}
  },
  on(name, fn) { events.push(['root.on', name]); return () => {} },
  effect(f) {
    events.push(['root.effect'])
    try { const d = f(); return typeof d === 'function' ? d : () => {} } catch (err) { events.push(['effect THREW', String(err)]); return () => {} }
  },
}

try {
  const plugin = mod.default ?? mod
  console.log('plugin:', plugin.name)
  plugin.apply(root)
  console.log('apply() 返回正常')
} catch (err) {
  console.log('apply() 同步抛错:', err.stack)
}
console.log('--- 事件轨迹 ---')
for (const e of events) console.log(JSON.stringify(e))
await new Promise((r) => setTimeout(r, 1500))
console.log('--- 1.5s 后（异步 resolveGit 完成后）---')
for (const e of events.slice(-4)) console.log(JSON.stringify(e))
process.exit(0)
