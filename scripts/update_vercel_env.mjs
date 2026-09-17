// scripts/update_vercel_env.mjs
import fs from 'fs'
import { execSync } from 'child_process'

const env = fs.readFileSync('.env.local', 'utf-8')
const url = env.match(/VITE_SUPABASE_URL=(.*)/)?.[1]?.trim()
const key = env.match(/VITE_SUPABASE_ANON_KEY=(.*)/)?.[1]?.trim()

console.log('Adding Vercel env variables with --value and --no-sensitive...')

try {
  execSync(`npx vercel env add VITE_SUPABASE_URL production,preview,development --value "${url}" --no-sensitive --yes --force`, { stdio: 'inherit' })
} catch (e) {
  console.error('Error adding VITE_SUPABASE_URL:', e.message)
}

try {
  execSync(`npx vercel env add VITE_SUPABASE_ANON_KEY production,preview,development --value "${key}" --no-sensitive --yes --force`, { stdio: 'inherit' })
} catch (e) {
  console.error('Error adding VITE_SUPABASE_ANON_KEY:', e.message)
}

console.log('✅ Done updating Vercel environment variables!')
