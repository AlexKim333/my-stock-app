// src/lib/zoneAllocation.js
/**
 * 센트로 구역 출고창고 자동 배정 (순수 함수 — DOM·네트워크 없음, scripts/test_zone_allocation.mjs로 검사)
 *
 * 한 품목이 같은 구역의 여러 창고(MAIN, MANUELDOBLADO, CIRCUNBALAXION, GUATEMALA)에 나뉘어 있을 때,
 * 출고 수량을 어느 창고에서 낼지 정한다. 규칙:
 *   1. 우선 창고(기본 MAIN)를 포함해 한 창고에서 전량을 낼 수 있으면 그 창고 하나(우선 창고 → 화면 순서).
 *   2. 한 창고로 모자라면 우선 창고 가용분을 먼저 쓰고, 나머지는 가용재고가 많은 창고부터 채운다(줄 수 최소화).
 *   3. 구역 전체로도 모자라면 모자라는 수량은 우선 창고 줄에 얹어 short로 알린다(화면이 재고부족으로 표시, 서버가 제출 시 거절).
 * 상자 단위 요청(낱개 없음)은 상자 단위로만 나눈다 — 한 상자를 두 창고에서 쪼개 꺼내지 않는다.
 */

/**
 * @param {number} reqUnits 요청 수량(낱개 환산)
 * @param {number} pack 입수(상자당 낱개 수)
 * @param {{wh: string, avail: number}[]} candidates 구역 창고별 가용재고(낱개 환산), 화면 순서
 * @param {string} priorityWh 우선 출고창고
 * @returns {{parts: {wh: string, units: number, short: number}[], short: number}}
 */
export function allocateZoneUnits(reqUnits, pack, candidates, priorityWh) {
  const req = Math.max(0, Math.trunc(Number(reqUnits) || 0))
  const bc = Math.max(1, Math.trunc(Number(pack) || 1))
  const list = (candidates || []).map(c => ({ wh: String(c.wh), avail: Math.max(0, Math.trunc(Number(c.avail) || 0)) }))
  const priority = list.find(c => c.wh === priorityWh) ? priorityWh : (list[0] ? list[0].wh : priorityWh)
  if (req === 0) return { parts: [], short: 0 }

  // 상자 단위 요청이면 가용재고도 온전한 상자만 센다.
  const step = (bc > 1 && req % bc === 0) ? bc : 1
  const usable = c => Math.floor(c.avail / step) * step
  const ordered = [
    ...list.filter(c => c.wh === priority),
    ...list.filter(c => c.wh !== priority)
  ]

  const whole = ordered.find(c => usable(c) >= req)
  if (whole) return { parts: [{ wh: whole.wh, units: req, short: 0 }], short: 0 }

  const parts = []
  let left = req
  const take = c => {
    const n = Math.min(usable(c), left)
    if (n > 0) {
      parts.push({ wh: c.wh, units: n, short: 0 })
      left -= n
    }
  }
  const first = ordered[0]
  if (first) take(first)
  ordered.slice(1)
    .sort((a, b) => usable(b) - usable(a))
    .forEach(c => { if (left > 0) take(c) })

  if (left > 0) {
    let p = parts.find(x => x.wh === priority)
    if (!p) {
      p = { wh: priority, units: 0, short: 0 }
      parts.unshift(p)
    }
    p.units += left
    p.short += left
  }
  return { parts, short: left }
}

/** 낱개 환산 수량을 상자+낱개로 */
export function unitsToBoxUnit(units, pack) {
  const bc = Math.max(1, Math.trunc(Number(pack) || 1))
  const n = Math.max(0, Math.trunc(Number(units) || 0))
  return { box: Math.floor(n / bc), unit: n % bc }
}
