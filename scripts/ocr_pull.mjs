// scripts/ocr_pull.mjs
/**
 * 자동 수집된 OCR 정답 세트를 내려받는다: npm run ocr:pull
 *
 * 앱에서 스캔 → 제출까지 끝난 건마다 ocr_samples 테이블에 [사진, 당시 AI 판독, 사람이 확정한 품목]이 쌓인다
 * (supabase/migrations/20261003120000_ocr_samples.sql). 이 스크립트는 그중 확정된 것을
 * tests/ocr/private/<날짜>-<종류>-<id 앞 8자리>/ 로 내려받아 `npm run test:ocr` 케이스로 만든다.
 *
 * - 사진에 고객 이름이 있으므로 tests/ocr/private는 git에 올라가지 않는다(.gitignore).
 * - 테이블은 앱(anon 키)으로 읽을 수 없게 막혀 있어서, 프로젝트 관리자 권한인 Supabase CLI
 *   (`supabase db query --linked`, 로그인·링크 필요)로 읽는다.
 * - 이미 내려받은 표본은 건너뛴다.
 * - expected.json은 "제출 때 확정한 결과"로 만든 초안이다. 직접 입력한 행이 빠지거나 다른 스캔과 합쳐진 행이
 *   있을 수 있으니 사진과 대조해 검토한 뒤 "needs_review": false로 바꾸자.
 *
 * 옵션
 *  --dry-run        내려받지 않고 대상만 보여준다
 *  --delete-pulled  내려받은 표본을 DB에서 지운다(DB 용량 절약. 사진은 로컬에만 남는다)
 */
import fs from 'fs'
import os from 'os'
import path from 'path'
import { spawnSync } from 'child_process'
import { fileURLToPath, pathToFileURL } from 'url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const OUT_DIR = path.join(ROOT, 'tests/ocr/private')
const BATCH = 5
const args = new Set(process.argv.slice(2))
const dryRun = args.has('--dry-run')
const deletePulled = args.has('--delete-pulled')

/** Supabase CLI로 SQL을 실행하고 rows를 돌려준다. SQL은 따옴표 문제를 피하려고 임시 파일로 넘긴다. */
function query(sql) {
  const tmp = path.join(os.tmpdir(), `ocr_pull_${process.pid}_${Date.now()}.sql`)
  fs.writeFileSync(tmp, sql)
  try {
    const r = spawnSync('npx', ['supabase', 'db', 'query', '--linked', '--output-format', 'json', '-f', tmp], {
      cwd: ROOT, encoding: 'utf8', shell: process.platform === 'win32', maxBuffer: 256 * 1024 * 1024
    })
    // CLI는 성공·실패 모두 stdout에 JSON을 낸다(실패: {"_tag":"Error","error":{"message":...}}).
    const out = r.stdout || ''
    let json = null
    try { json = JSON.parse(out.slice(out.indexOf('{'), out.lastIndexOf('}') + 1)) } catch { /* 아래에서 처리 */ }
    if (r.status !== 0 || !json || json._tag === 'Error') {
      const msg = json?.error?.message || (r.stderr || out).trim().split('\n').slice(-3).join('\n')
      throw new Error(msg)
    }
    return json.rows || []
  } finally {
    fs.rmSync(tmp, { force: true })
  }
}

const isUuid = s => /^[0-9a-f-]{36}$/i.test(s)
const inList = ids => ids.filter(isUuid).map(id => `'${id}'`).join(',')

/** 제출 때 확정한 행을 test:ocr의 expected.items 형식으로 바꾼다. */
export function toExpectedItems(scanType, confirmed, mixed) {
  return (confirmed || []).map(c => {
    const item = { modelo: c.itemName }
    const color = String(c.color || '').toUpperCase()
    if (color && color !== 'SURTIDO') item.color = color
    // 다른 스캔·직접 입력과 합쳐진 표본은 수량이 섞였을 수 있어 품번·색상만 비교한다.
    if (mixed) return item
    const boxes = Number(c.boxQty) || 0
    const units = Number(c.individualQty) || 0
    if (scanType === 'audit') {
      item.boxes = boxes
      item.piezas = units
    } else if (units === 0) {
      // 주문서·송장은 상자 단위만 비교한다(낱개 주문은 AI 출력의 단위가 달라 비교하지 않음).
      item.boxes = boxes
    }
    return item
  })
}

function existingIds() {
  if (!fs.existsSync(OUT_DIR)) return new Set()
  const ids = new Set()
  for (const d of fs.readdirSync(OUT_DIR)) {
    const meta = path.join(OUT_DIR, d, 'sample.json')
    if (fs.existsSync(meta)) {
      try { ids.add(JSON.parse(fs.readFileSync(meta, 'utf8')).id) } catch { /* 손상된 메타는 무시 */ }
    }
  }
  return ids
}

function main() {
  console.log('🔎 확정된 OCR 표본을 조회합니다 (Supabase CLI)...')
  let list
  try {
    list = query(`select id, created_at, scan_type, used_model, confirm_note,
         jsonb_array_length(coalesce(confirmed, '[]'::jsonb)) as item_count
    from public.ocr_samples where confirmed is not null order by created_at`)
  } catch (e) {
    if (/ocr_samples.*does not exist/.test(e.message)) {
      console.error('❌ ocr_samples 테이블이 없습니다. 마이그레이션 20261003120000_ocr_samples.sql을 먼저 적용하세요.')
    } else {
      console.error('❌ 조회 실패. `npx supabase login`과 `npx supabase link`가 되어 있는지 확인하세요.\n' + e.message)
    }
    process.exit(1)
  }

  const have = existingIds()
  const todo = list.filter(r => !have.has(r.id))
  console.log(`   확정 표본 ${list.length}건, 이미 받은 것 ${list.length - todo.length}건, 새로 받을 것 ${todo.length}건`)
  for (const r of todo) {
    console.log(`   - ${String(r.created_at).slice(0, 16)} ${r.scan_type.padEnd(12)} ${r.item_count}개 품목${r.confirm_note === 'mixed' ? ' (합쳐진 행 있음)' : ''}`)
  }
  if (dryRun || todo.length === 0) return

  fs.mkdirSync(OUT_DIR, { recursive: true })
  const pulled = []
  for (let i = 0; i < todo.length; i += BATCH) {
    const ids = todo.slice(i, i + BATCH).map(r => r.id)
    const rows = query(`select id, created_at, scan_type, used_model, confirm_note, confirmed, ocr_result,
           encode(image, 'base64') as image_b64
      from public.ocr_samples where id in (${inList(ids)})`)
    for (const r of rows) {
      const date = new Date(r.created_at).toISOString().slice(0, 10).replace(/-/g, '')
      const dir = path.join(OUT_DIR, `${date}-${r.scan_type}-${r.id.slice(0, 8)}`)
      fs.mkdirSync(dir, { recursive: true })
      const mixed = r.confirm_note === 'mixed'
      fs.writeFileSync(path.join(dir, 'image.jpg'), Buffer.from(r.image_b64, 'base64'))
      fs.writeFileSync(path.join(dir, 'ocr_result.json'), JSON.stringify(r.ocr_result, null, 2) + '\n')
      fs.writeFileSync(path.join(dir, 'sample.json'), JSON.stringify({
        id: r.id, created_at: r.created_at, used_model: r.used_model, confirm_note: r.confirm_note, confirmed: r.confirmed
      }, null, 2) + '\n')
      fs.writeFileSync(path.join(dir, 'expected.json'), JSON.stringify({
        type: r.scan_type,
        note: `자동 수집 ${String(r.created_at).slice(0, 10)} (${r.used_model || '모델 미상'}). 제출 때 확정한 결과로 만든 초안이라 사진과 대조해 검토 필요.` +
          (mixed ? ' 다른 스캔·직접 입력과 합쳐진 행이 있어 수량은 비교하지 않음.' : ''),
        needs_review: true,
        items: toExpectedItems(r.scan_type, r.confirmed, mixed)
      }, null, 2) + '\n')
      pulled.push(r.id)
      console.log(`   💾 ${path.relative(ROOT, dir)}`)
    }
  }

  if (deletePulled && pulled.length) {
    query(`delete from public.ocr_samples where id in (${inList(pulled)})`)
    console.log(`🗑️ DB에서 ${pulled.length}건 삭제 (사진은 로컬에만 남음)`)
  }
  console.log(`\n✅ ${pulled.length}건 내려받음. expected.json을 사진과 대조해 검토한 뒤 "needs_review": false로 바꾸세요.`)
}

// 테스트에서 toExpectedItems만 가져다 쓸 수 있게, 직접 실행했을 때만 내려받기를 한다.
if (import.meta.url === pathToFileURL(process.argv[1]).href) main()
