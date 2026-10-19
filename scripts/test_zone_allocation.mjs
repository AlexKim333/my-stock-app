// scripts/test_zone_allocation.mjs
// 센트로 구역 출고창고 자동 배정(src/lib/zoneAllocation.js) 오프라인 회귀 테스트. npm test에 포함.
import { allocateZoneUnits, unitsToBoxUnit } from '../src/lib/zoneAllocation.js'

let fail = 0
function check(label, actual, expected) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) {
    console.log(`✅ ${label}`)
  } else {
    fail += 1
    console.log(`❌ ${label}\n   기대: ${e}\n   실제: ${a}`)
  }
}

const P = 10 // 입수 10
const zone = (main, man, cir, gua) => [
  { wh: 'MAIN', avail: main * P },
  { wh: 'MANUELDOBLADO', avail: man * P },
  { wh: 'CIRCUNBALAXION', avail: cir * P },
  { wh: 'GUATEMALA', avail: gua * P }
]
const parts = r => r.parts.map(p => `${p.wh}:${p.units / P}${p.short ? `(부족${p.short / P})` : ''}`)

check('한 창고에만 재고 → 그 창고', parts(allocateZoneUnits(3 * P, P, zone(0, 0, 5, 0), 'MAIN')), ['CIRCUNBALAXION:3'])
check('MAIN이 전량 가능 → MAIN', parts(allocateZoneUnits(3 * P, P, zone(5, 9, 9, 0), 'MAIN')), ['MAIN:3'])
check('우선 창고 GUATEMALA가 전량 가능 → GUATEMALA', parts(allocateZoneUnits(3 * P, P, zone(5, 0, 0, 4), 'GUATEMALA')), ['GUATEMALA:3'])
check('MAIN 부족, 다른 한 창고가 전량 가능 → 그 창고 하나', parts(allocateZoneUnits(5 * P, P, zone(2, 3, 6, 0), 'MAIN')), ['CIRCUNBALAXION:5'])
check('한 창고로 부족 → MAIN 먼저, 나머지는 많은 창고부터', parts(allocateZoneUnits(9 * P, P, zone(3, 2, 4, 1), 'MAIN')), ['MAIN:3', 'CIRCUNBALAXION:4', 'MANUELDOBLADO:2'])
check('우선 창고가 0이면 많은 창고부터', parts(allocateZoneUnits(6 * P, P, zone(5, 0, 0, 0).map(c => c.wh === 'GUATEMALA' ? c : { ...c, avail: c.wh === 'MAIN' ? 4 * P : c.wh === 'CIRCUNBALAXION' ? 3 * P : 0 }), 'GUATEMALA')), ['MAIN:4', 'CIRCUNBALAXION:2'])
check('구역 전체 부족 → 있는 만큼 + 부족분은 우선 창고 줄', parts(allocateZoneUnits(10 * P, P, zone(3, 0, 2, 0), 'MAIN')), ['MAIN:8(부족5)', 'CIRCUNBALAXION:2'])
check('재고 전혀 없음 → 우선 창고 줄 전량 부족', allocateZoneUnits(2 * P, P, zone(0, 0, 0, 0), 'MAIN'), { parts: [{ wh: 'MAIN', units: 20, short: 20 }], short: 20 })
check('상자 요청은 상자 단위로만 나눔(낱개 자투리 미사용)',
  allocateZoneUnits(2 * P, P, [{ wh: 'MAIN', avail: 15 }, { wh: 'GUATEMALA', avail: 10 }], 'MAIN'),
  { parts: [{ wh: 'MAIN', units: 10, short: 0 }, { wh: 'GUATEMALA', units: 10, short: 0 }], short: 0 })
check('낱개 요청은 낱개 단위로 나눔',
  allocateZoneUnits(7, P, [{ wh: 'MAIN', avail: 4 }, { wh: 'GUATEMALA', avail: 5 }], 'MAIN'),
  { parts: [{ wh: 'MAIN', units: 4, short: 0 }, { wh: 'GUATEMALA', units: 3, short: 0 }], short: 0 })
check('요청 0 → 배정 없음', allocateZoneUnits(0, P, zone(1, 1, 1, 1), 'MAIN'), { parts: [], short: 0 })
check('목록에 없는 우선 창고 → 첫 창고(MAIN)를 우선으로', parts(allocateZoneUnits(2 * P, P, zone(0, 0, 0, 0), 'PANTACO')), ['MAIN:2(부족2)'])
check('상자+낱개 환산', unitsToBoxUnit(23, 10), { box: 2, unit: 3 })

if (fail) {
  console.log(`\n🚨 ${fail}건 실패`)
  process.exit(1)
}
console.log('\n🎉 센트로 출고창고 자동 배정 테스트 통과')
