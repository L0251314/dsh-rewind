import mod from '../lib/index.js'
console.log('typeof mod:', typeof mod)
console.log('keys:', Object.keys(mod ?? {}))
console.log('typeof default:', typeof mod?.default)
console.log('name:', mod?.default?.name)
