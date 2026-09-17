// scripts/set_vercel_envs.mjs
import fs from 'fs'
import { spawnSync } from 'child_process'

const env = fs.readFileSync('.env.local', 'utf-8')
const url = env.match(/VITE_SUPABASE_URL=(.*)/)?.[1]?.trim()
const key = env.match(/VITE_SUPABASE_ANON_KEY=(.*)/)?.[1]?.trim()

console.log('Target URL:', url)
console.log('Target Key prefix:', key?.substring(0, 15))

// 1. Set URL
console.log('Setting VITE_SUPABASE_URL...')
const r1 = spawnSync('npx.cmd', ['vercel', 'env', 'add', 'VITE_SUPABASE_URL', 'production,preview,development', '--value', url, '--no-sensitive', '--yes', '--force'], {
  stdio: 'inherit',
  encoding: 'utf-8'
})
console.log('URL status:', r1.status)

// 2. Set Key
console.log('Setting VITE_SUPABASE_ANON_KEY...')
const r2 = spawnSync('npx.cmd', ['vercel', 'env', 'add', 'VITE_SUPABASE_ANON_KEY', 'production,preview,development', '--value', key, '--no-sensitive', '--yes', '--force'], {
  stdio: 'inherit',
  encoding: 'utf-8'
})
console.log('Key status:', r2.status)

console.log('All set!')
