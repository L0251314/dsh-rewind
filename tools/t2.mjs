import fs from 'node:fs'

const u = new URL('../lib/index.js', import.meta.url)
console.log('resolves to:', u.href)
const text = fs.readFileSync(u, 'utf8')
console.log('first 120 bytes:', JSON.stringify(text.slice(0, 120)))
console.log('has export default:', text.includes('export default'))
console.log('has export const:', text.includes('export const'))
console.log('has module.exports:', text.includes('module.exports'))

const m = await import(u.href)
console.log('dynamic keys:', Object.keys(m))
console.log('dynamic default type:', typeof m.default)
