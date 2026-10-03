// scripts/cleanup_smoke.mjs
/**
 * 🧹 스모크 테스트 전표 정리
 * ---------------------------------------------------------------------------
 * `npm run smoke`는 전용 테스트 품목(__SMOKETEST_ITEM__)으로 입고/이동/출고/조정을
 * 실제 프로덕션에 기록한다. 재고는 매번 0으로 돌아오지만 전표(stock_transactions)는
 * 남는다. 이 스크립트는 그 전표를 지운다.
 *
 * anon 키로는 삭제가 막혀 있으므로(RLS가 SELECT만 허용) Supabase CLI의 linked 연결
 * (`npx supabase db query --linked`)을 쓴다 — 먼저 `npx supabase login` / `link`가 되어 있어야 한다.
 *
 * 안전장치:
 *   1. 대상은 테스트 품목(__SMOKETEST_ITEM__ / TEST)의 전표 중 메모가 '스모크테스트'로 시작하는 것뿐이다.
 *      다른 품목, 그리고 이 품목이라도 메모가 다른(사람이 직접 만든) 전표는 건드리지 않는다.
 *   2. 테스트 품목에 재고가 0이 아닌 창고가 있으면(이전 스모크가 비정상 종료한 상태) 아무것도 지우지 않고
 *      중단한다. 전표를 지우면 원인을 추적할 수 없게 되므로 사람이 먼저 보게 한다.
 *      삭제 SQL에도 같은 조건을 넣어, 확인과 삭제 사이에 재고가 바뀌어도 지우지 않는다.
 *   3. 테스트 품목 자체와 테스트 창고(SMOKETEST)는 지우지 않는다 — 다음 `npm run smoke`가 재사용한다.
 *
 * 사용법:
 *   npm run smoke:clean              # 삭제
 *   npm run smoke:clean -- --dry-run # 지울 대상만 보여주고 삭제하지 않음
 *   --soft                           # Supabase CLI 연결 실패를 경고로만 처리하고 종료코드 0
 *                                    # (npm run smoke가 통과한 뒤 자동 정리할 때 쓴다 — 정리를 못 해도
 *                                    #  스모크 통과 결과를 실패로 바꾸지 않기 위함. 잔여 재고 중단은 그대로 실패)
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const TEST_ITEM_NAME = '__SMOKETEST_ITEM__'
const TEST_ITEM_COLOR = 'TEST'
const SMOKE_MEMO_PREFIX = '스모크테스트'
const dryRun = process.argv.includes('--dry-run')
const soft = process.argv.includes('--soft')

// SQL은 임시 파일로 넘긴다 (Windows 셸에서 따옴표/% 이스케이프 문제를 피하려고).
function runSql(sql) {
  const dir = mkdtempSync(join(tmpdir(), 'smoke-clean-'))
  const file = join(dir, 'q.sql')
  writeFileSync(file, sql, 'utf8')
  try {
    const out = execFileSync(
      process.platform === 'win32' ? 'npx.cmd' : 'npx',
      ['supabase', 'db', 'query', '--linked', '-f', file],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], shell: process.platform === 'win32', timeout: 120000 }
    )
    const start = out.indexOf('{')
    if (start < 0) throw new Error('쿼리 결과를 해석할 수 없습니다: ' + out.slice(0, 200))
    return JSON.parse(out.slice(start)).rows || []
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const itemFilter = `i.item_name = '${TEST_ITEM_NAME}' AND i.color = '${TEST_ITEM_COLOR}'`

function main() {
  console.log('================================================================')
  console.log(`🧹 [스모크 테스트 전표 정리] ${dryRun ? '(dry-run: 삭제하지 않음)' : '시작...'}`)
  console.log('================================================================')

  const items = runSql(`SELECT i.id FROM items i WHERE ${itemFilter}`)
  if (items.length === 0) {
    console.log('테스트 품목이 없습니다. 정리할 것이 없습니다.')
    return
  }

  const dirty = runSql(`
    SELECT s.warehouse_code, s.box_qty, s.unit_qty
    FROM inventory_stocks s JOIN items i ON i.id = s.item_id
    WHERE ${itemFilter} AND (s.box_qty <> 0 OR s.unit_qty <> 0)
  `)
  if (dirty.length > 0) {
    const detail = dirty.map(r => `${r.warehouse_code} ${r.box_qty}상자/${r.unit_qty}개`).join(', ')
    console.error(`❌ 테스트 품목에 잔여 재고가 있어 중단합니다 (${detail}).`)
    console.error('   이전 스모크 테스트가 비정상 종료됐을 수 있습니다 — 원인을 확인한 뒤 다시 실행하세요.')
    process.exitCode = 1
    return
  }

  const summary = runSql(`
    SELECT count(*)::int AS total,
           count(*) FILTER (WHERE t.memo LIKE '${SMOKE_MEMO_PREFIX}%')::int AS smoke
    FROM stock_transactions t JOIN items i ON i.id = t.item_id
    WHERE ${itemFilter}
  `)[0] || { total: 0, smoke: 0 }
  const others = summary.total - summary.smoke
  console.log(`테스트 품목 전표: 총 ${summary.total}건 (스모크 메모 ${summary.smoke}건, 그 외 ${others}건)`)
  if (others > 0) {
    console.log(`⚠️  메모가 '${SMOKE_MEMO_PREFIX}'로 시작하지 않는 ${others}건은 지우지 않습니다.`)
  }
  if (summary.smoke === 0) {
    console.log('지울 스모크 전표가 없습니다.')
    return
  }
  if (dryRun) {
    console.log(`(dry-run) ${summary.smoke}건이 삭제 대상입니다.`)
    return
  }

  const deleted = runSql(`
    DELETE FROM stock_transactions t
    USING items i
    WHERE i.id = t.item_id
      AND ${itemFilter}
      AND t.memo LIKE '${SMOKE_MEMO_PREFIX}%'
      AND NOT EXISTS (
        SELECT 1 FROM inventory_stocks s
        WHERE s.item_id = i.id AND (s.box_qty <> 0 OR s.unit_qty <> 0)
      )
    RETURNING t.id
  `)
  console.log(`✅ ${deleted.length}건 삭제했습니다.`)
  if (deleted.length !== summary.smoke) {
    console.error(`⚠️  예상(${summary.smoke}건)과 다릅니다. 실행 중 재고가 바뀌었을 수 있으니 다시 확인하세요.`)
    process.exitCode = 1
  }
}

try {
  main()
} catch (err) {
  if (soft) {
    console.warn('⚠️  스모크 전표를 자동 정리하지 못했습니다 (스모크 테스트 결과에는 영향 없음):', err.message || err)
    console.warn('   Supabase CLI 로그인/링크 후 `npm run smoke:clean`으로 직접 정리하세요.')
  } else {
    console.error('❌ 정리 실패:', err.message || err)
    console.error('   Supabase CLI가 로그인/링크된 상태인지 확인하세요 (npx supabase login, npx supabase link).')
    process.exitCode = 1
  }
}
