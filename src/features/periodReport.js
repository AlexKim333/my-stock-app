/**
 * 기간 보고서 UI 컨트롤러 — 기간을 골라 입고·출고·이동을 일자/거래처/품목/창고/담당자별로 집계하고 엑셀로 내려받는다.
 * ---------------------------------------------------------------------------
 * index.html의 "📑 기간 보고서" 모달 전용 코드다. index.html에서만 로드되며 그 페이지의 인라인 전역에 의존한다:
 *   - callServer(fnName, args, opt) : supabaseAdapter 브릿지 호출 (getPeriodReport, getStockSnapshot)
 *   - escapeHtml(v)                 : HTML 이스케이프 헬퍼
 *   - isBranchLocation(name)        : 거래처 이름이 내부 창고(지점)인지 (typeof로 가드)
 *
 * 수량은 모두 상자 환산(상자 + 낱개 ÷ 입수)이다. 이동(창고 간)은 출고 실적에 넣지 않고 따로 센다.
 * 반품 입고(type 'RETURN', DB에서는 INBOUND + return_of_invoice)는 입고에 넣지 않고, 반품일 기준으로
 * 따로 센다. 순출고 = 출고 − 반품. 판매 속도(일평균·재고 분석)는 순출고를 쓴다.
 * 서버는 전표 행만 돌려주고 집계는 여기서 하므로, 탭·창고 필터·품목 필터·검색을 바꿔도 다시 조회하지 않는다.
 * 품목 필터는 요약·모든 탭·엑셀에 같이 걸린다. 거래처 필터도 같지만 재고 분석 탭(현재 재고 기준)에는 걸리지 않는다.
 * 거래처·지점별 탭의 행을 누르면 그 거래처로 필터를 걸고 품목별 합계 피벗으로 간다. 피벗 탭(기본 탭)은 행 차원 × 열 차원으로 고른 값을 펼친다
 * (예: 한 품목의 거래처 × 일자 출고). 품목별 탭의 행을 누르면 그 품목으로 필터를 걸고 피벗으로 간다.
 * 재고 분석 탭(소진 예상·안 팔리는 재고·안전재고 점검)은 고른 기간의 출고량을 판매 속도로 쓰고
 * 현재 재고 스냅샷과 비교한다. 창고 필터와 상관없이 전체 출고·전체 재고 기준이다.
 * HTML 속성이 호출하는 함수만 파일 하단에서 window에 노출한다.
 */

const PR_TABS = [
  { key: 'pivot', label: '🧮 피벗' },
  { key: 'daily', label: '일자별' },
  { key: 'partner', label: '거래처·지점별' },
  { key: 'item', label: '품목별' },
  { key: 'warehouse', label: '창고별' },
  { key: 'handler', label: '담당자별' },
  { key: 'cover', label: '소진 예상', analysis: true },
  { key: 'dead', label: '안 팔리는 재고', analysis: true },
  { key: 'safety', label: '안전재고 점검', analysis: true }
];
const PR_DEAD_COVER_DAYS = 180; // 이보다 오래 버틸 재고는 '느리게 팔림'으로 본다
const PR_MAX_TABLE_ROWS = 500;

let prData = null; // { from, to, rows }
let prSnapshot = null; // getStockSnapshot().items — 재고 분석 탭용 현재 재고
let prTab = 'pivot';
let prLoading = false;

const PR_PIVOT_MAX_COLS = 60; // 날짜가 아닌 열 차원은 합계 상위만 열로 펼치고 나머지는 '기타'로 묶는다

/** 피벗 차원: key(r)로 묶고 label(r)로 보여 준다. dates면 기간의 모든 날(주·월)을 순서대로 펼친다. */
const PR_PIVOT_DIMS = {
  partner: { label: '거래처·지점', key: r => r.partner || (r.type === 'MOVE' ? `→ ${r.dst || '?'} (이동)` : '(미지정)') },
  item: { label: '품목', key: r => String(r.itemId), name: r => prItemLabel(r) },
  date: { label: '일자', dates: true, key: r => r.date },
  week: { label: '주(월요일 시작)', dates: true, key: r => prWeekKey(r.date) },
  month: { label: '월', dates: true, key: r => String(r.date || '').slice(0, 7) },
  warehouse: { label: '창고', key: r => (r.type === 'MOVE' ? (r.src || r.wh) : r.wh) || '(미지정)' },
  handler: { label: '담당자', key: r => r.handler || '(미지정)' },
  none: { label: '(합계만)', key: () => '합계' }
};
/** 피벗 값: 해당하지 않는 전표 행은 null을 돌려 빠진다. */
const PR_PIVOT_MEASURES = {
  out: { label: '출고 (상자 환산)', v: r => (r.type === 'OUTBOUND' ? r.boxEq : null) },
  netOut: { label: '순출고 (출고 − 반품)', v: r => (r.type === 'OUTBOUND' ? r.boxEq : r.type === 'RETURN' ? -r.boxEq : null) },
  outLines: { label: '출고 횟수 (줄)', v: r => (r.type === 'OUTBOUND' ? 1 : null) },
  in: { label: '입고', v: r => (r.type === 'INBOUND' ? r.boxEq : null) },
  ret: { label: '반품', v: r => (r.type === 'RETURN' ? r.boxEq : null) },
  move: { label: '이동', v: r => (r.type === 'MOVE' ? r.boxEq : null) }
};
const PR_WEEKDAY = ['일', '월', '화', '수', '목', '금', '토'];

function prItemLabel(r) {
  return r.color ? `${r.name} / ${r.color}` : String(r.name || '');
}

function prWeekKey(dateStr) {
  const [y, m, d] = String(dateStr).split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() - ((dt.getDay() + 6) % 7));
  return prDateStr(dt);
}

function prRound1(n) {
  return Math.round((Number(n) || 0) * 10) / 10;
}

function prFmt(n) {
  return prRound1(n).toLocaleString(undefined, { maximumFractionDigits: 1 });
}

/** 반품률 표시: 반품이 없으면 빈칸 */
function prRate(ret, out) {
  if (!(ret > 0)) return '';
  return out > 0 ? `${(ret / out * 100).toFixed(1)}%` : '출고 없음';
}

function prDateStr(d) {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function prIsBranch(name) {
  return typeof isBranchLocation === 'function' && !!name && isBranchLocation(name);
}

function openPeriodReportModal() {
  const modal = document.getElementById('periodReportModal');
  if (!modal) return;
  modal.style.display = 'flex';
  const fromEl = document.getElementById('prFrom');
  if (fromEl && !fromEl.value) setPeriodReportPreset('7d');
  else if (!prData) loadPeriodReport();
}

function closePeriodReportModal() {
  const modal = document.getElementById('periodReportModal');
  if (modal) modal.style.display = 'none';
}

function setPeriodReportPreset(preset) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  let from = new Date(today);
  let to = new Date(today);
  if (preset === '7d') from.setDate(from.getDate() - 6);
  else if (preset === '30d') from.setDate(from.getDate() - 29);
  else if (preset === 'month') from = new Date(today.getFullYear(), today.getMonth(), 1);
  else if (preset === 'lastMonth') {
    from = new Date(today.getFullYear(), today.getMonth() - 1, 1);
    to = new Date(today.getFullYear(), today.getMonth(), 0);
  }
  document.getElementById('prFrom').value = prDateStr(from);
  document.getElementById('prTo').value = prDateStr(to);
  loadPeriodReport();
}

function prSetStatus(text, isError) {
  const el = document.getElementById('prStatus');
  if (!el) return;
  el.textContent = text || '';
  el.style.color = isError ? '#b91c1c' : '#64748b';
}

function loadPeriodReport() {
  if (prLoading) return;
  const from = document.getElementById('prFrom').value;
  const to = document.getElementById('prTo').value;
  if (!from || !to) {
    prSetStatus('시작일과 종료일을 고르세요.', true);
    return;
  }
  prLoading = true;
  prSetStatus('⏳ 전표를 불러오는 중...');
  callServer('getStockSnapshot', [], {
    key: 'getStockSnapshot',
    mode: 'latest',
    onSuccess: res => {
      prSnapshot = (res && res.items) || [];
      if (prData && prIsAnalysisTab()) renderPeriodReport();
    },
    onError: err => {
      prSnapshot = null;
      console.warn('[periodReport] 재고 스냅샷 조회 실패:', err);
    }
  });
  callServer('getPeriodReport', [from, to], {
    key: 'getPeriodReport',
    mode: 'latest',
    onSuccess: res => {
      prLoading = false;
      prData = { from, to, rows: (res && res.rows) || [] };
      prFillWarehouseFilter();
      prFillItemFilter();
      prFillPartnerFilter();
      const days = prDays().length;
      prSetStatus(`${from} ~ ${to} · 전표 행 ${prData.rows.length.toLocaleString()}건 · 수량은 상자 환산(낱개 ÷ 입수)` +
        (days < 28 ? ' · ⚠️ 재고 분석의 판매 속도는 기간이 짧으면 흔들립니다(30~90일 권장)' : ''));
      renderPeriodReport();
    },
    onError: err => {
      prLoading = false;
      prSetStatus('조회 실패: ' + ((err && err.message) || err), true);
    }
  });
}

function prFillWarehouseFilter() {
  const sel = document.getElementById('prWh');
  if (!sel || !prData) return;
  const cur = sel.value;
  const set = new Set(['MAIN']);
  prData.rows.forEach(r => [r.wh, r.src, r.dst].forEach(w => { if (w) set.add(w); }));
  const list = ['MAIN', ...Array.from(set).filter(w => w !== 'MAIN').sort()];
  sel.innerHTML = '<option value="">전체 창고</option>' +
    list.map(w => `<option value="${escapeHtml(w)}">${escapeHtml(w)}</option>`).join('');
  sel.value = list.includes(cur) ? cur : '';
}

function prFillItemFilter() {
  const list = document.getElementById('prItemList');
  if (!list || !prData) return;
  const labels = new Set();
  prData.rows.forEach(r => labels.add(prItemLabel(r)));
  list.innerHTML = Array.from(labels).sort().map(l => `<option value="${escapeHtml(l)}"></option>`).join('');
}

/**
 * 품목 필터 판정 함수. 비어 있으면 null.
 * 목록의 이름("품명 / 컬러")과 정확히 같으면 그 품목만, 아니면 품명·컬러·이름에 그 글자가 들어간 품목 전부.
 */
function prItemMatcher() {
  const q = String((document.getElementById('prItem') || {}).value || '').trim().toUpperCase();
  if (!q) return null;
  const exact = prData && prData.rows.some(r => prItemLabel(r).toUpperCase() === q);
  if (exact) return r => prItemLabel(r).toUpperCase() === q;
  return r => [r.name, r.color, prItemLabel(r)].some(v => String(v || '').toUpperCase().includes(q));
}

/** 이동 전표는 거래처가 비어 있으므로 도착 창고(지점 거래처 이름 = 창고 코드)를 거래처로 본다. */
function prPartnerOf(r) {
  return r.partner || (r.type === 'MOVE' ? r.dst || '' : '');
}

function prFillPartnerFilter() {
  const list = document.getElementById('prPartnerList');
  if (!list || !prData) return;
  const names = new Set();
  prData.rows.forEach(r => { const p = prPartnerOf(r); if (p) names.add(p); });
  list.innerHTML = Array.from(names).sort().map(p => `<option value="${escapeHtml(p)}"></option>`).join('');
}

/** 거래처 필터 판정 함수. 비어 있으면 null. 목록의 이름과 정확히 같으면 그 거래처만, 아니면 그 글자가 들어간 거래처 전부. */
function prPartnerMatcher() {
  const q = prPartnerQuery().toUpperCase();
  if (!q) return null;
  if (prPartnerIsExact()) return r => prPartnerOf(r).toUpperCase() === q;
  return r => prPartnerOf(r).toUpperCase().includes(q);
}

function prPartnerQuery() {
  return String((document.getElementById('prPartner') || {}).value || '').trim();
}

function prPartnerIsExact() {
  const q = prPartnerQuery().toUpperCase();
  return !!q && !!prData && prData.rows.some(r => prPartnerOf(r).toUpperCase() === q);
}

function prFilteredRows() {
  if (!prData) return [];
  const wh = (document.getElementById('prWh') || {}).value || '';
  const itemMatch = prItemMatcher();
  const partnerMatch = prPartnerMatcher();
  return prData.rows.filter(r => {
    if (itemMatch && !itemMatch(r)) return false;
    if (partnerMatch && !partnerMatch(r)) return false;
    if (!wh) return true;
    // 입고·출고는 재고가 늘거나 준 창고(warehouse_code)로만 거른다. 서브창고발 입고는 본사 입고라서
    // 서브창고 필터에 넣으면 그 창고의 입고로 잘못 보인다(창고별 탭의 '본사로 보냄'에서 따로 보여 준다).
    return r.type === 'MOVE' ? (r.src === wh || r.dst === wh || r.wh === wh) : r.wh === wh;
  });
}

function prFillPivotControls() {
  const fill = (id, map, def) => {
    const sel = document.getElementById(id);
    if (!sel || sel.options.length) return;
    sel.innerHTML = Object.entries(map).map(([k, d]) => `<option value="${k}">${escapeHtml(d.label)}</option>`).join('');
    sel.value = def;
  };
  fill('prPivRow', PR_PIVOT_DIMS, 'partner');
  fill('prPivCol', PR_PIVOT_DIMS, 'date');
  fill('prPivMeasure', PR_PIVOT_MEASURES, 'out');
}

function prPivotSettings() {
  prFillPivotControls();
  const val = (id, map, def) => {
    const v = (document.getElementById(id) || {}).value;
    return map[v] ? v : def;
  };
  return {
    row: val('prPivRow', PR_PIVOT_DIMS, 'partner'),
    col: val('prPivCol', PR_PIVOT_DIMS, 'date'),
    measure: val('prPivMeasure', PR_PIVOT_MEASURES, 'out')
  };
}

/** 날짜 차원의 버킷 목록(기간 전체, 데이터 없는 날도 포함)과 화면용 이름 */
function prDateBuckets(dimKey) {
  const dim = PR_PIVOT_DIMS[dimKey];
  const keys = [];
  prDays().forEach(d => {
    const k = dim.key({ date: d });
    if (!keys.includes(k)) keys.push(k);
  });
  const label = k => {
    if (dimKey === 'date') {
      const [y, m, d] = k.split('-').map(Number);
      return `${k.slice(5)}(${PR_WEEKDAY[new Date(y, m - 1, d).getDay()]})`;
    }
    if (dimKey === 'week') return `${k.slice(5)} 시작 주`;
    return k;
  };
  return keys.map(k => ({ key: k, label: label(k) }));
}

/** 피벗 표: 행 차원 × 열 차원, 값은 고른 지표. 마지막 열은 행 합계, 마지막 행은 열 합계. */
function prBuildPivot(rows) {
  const { row, col, measure } = prPivotSettings();
  const rowDim = PR_PIVOT_DIMS[row];
  const colDim = PR_PIVOT_DIMS[col];
  const mv = PR_PIVOT_MEASURES[measure].v;
  const names = new Map(); // 품목처럼 key와 보여 줄 이름이 다른 차원용
  const cells = new Map(); // rowKey -> Map(colKey -> value)
  const rowTot = new Map();
  const colTot = new Map();
  let grand = 0;
  rows.forEach(r => {
    const v = mv(r);
    if (v == null) return;
    const rk = rowDim.key(r);
    const ck = colDim.key(r);
    if (rowDim.name) names.set('r:' + rk, rowDim.name(r));
    if (colDim.name) names.set('c:' + ck, colDim.name(r));
    if (!cells.has(rk)) cells.set(rk, new Map());
    const m = cells.get(rk);
    m.set(ck, (m.get(ck) || 0) + v);
    rowTot.set(rk, (rowTot.get(rk) || 0) + v);
    colTot.set(ck, (colTot.get(ck) || 0) + v);
    grand += v;
  });

  let colList = colDim.dates
    ? prDateBuckets(col)
    : Array.from(colTot.keys())
      .sort((a, b) => colTot.get(b) - colTot.get(a))
      .map(k => ({ key: k, label: names.get('c:' + k) || k }));
  let otherKeys = null;
  if (!colDim.dates && colList.length > PR_PIVOT_MAX_COLS) {
    otherKeys = new Set(colList.slice(PR_PIVOT_MAX_COLS - 1).map(c => c.key));
    colList = colList.slice(0, PR_PIVOT_MAX_COLS - 1);
  }
  if (col === 'none') colList = [];

  const columns = [{ key: 'label', label: col === 'none' ? rowDim.label : `${rowDim.label} \\ ${colDim.label}`, sticky: true }];
  colList.forEach((c, i) => columns.push({ key: 'c' + i, label: c.label, num: true }));
  if (otherKeys) columns.push({ key: 'cOther', label: `기타 ${otherKeys.size}`, num: true });
  columns.push({ key: 'total', label: '합계', num: true, bold: true });

  const makeRow = (label, get, total) => {
    const o = { label, total };
    colList.forEach((c, i) => { o['c' + i] = get(c.key); });
    if (otherKeys) o.cOther = Array.from(otherKeys).reduce((s, k) => s + (get(k) || 0), 0);
    return o;
  };

  const rowKeys = rowDim.dates
    ? prDateBuckets(row).map(b => b.key)
    : Array.from(rowTot.keys()).sort((a, b) => rowTot.get(b) - rowTot.get(a));
  const rowLabels = rowDim.dates ? new Map(prDateBuckets(row).map(b => [b.key, b.label])) : null;
  const out = rowKeys.map(rk => {
    const m = cells.get(rk) || new Map();
    return makeRow(rowLabels ? rowLabels.get(rk) : (names.get('r:' + rk) || rk), k => m.get(k) || 0, rowTot.get(rk) || 0);
  });
  if (out.length > 1 || !rowDim.dates) out.push({ ...makeRow('합계', k => colTot.get(k) || 0, grand), _total: true });
  return { columns, rows: grand === 0 && !rowTot.size ? [] : out, pivot: true };
}

function swapPeriodReportPivot() {
  prFillPivotControls();
  const r = document.getElementById('prPivRow');
  const c = document.getElementById('prPivCol');
  if (!r || !c) return;
  if (c.value === 'none') return;
  [r.value, c.value] = [c.value, r.value];
  renderPeriodReport();
}

function clearPeriodReportItem() {
  const el = document.getElementById('prItem');
  if (el) el.value = '';
  renderPeriodReport();
}

function prSetPivot(row, col) {
  prFillPivotControls();
  const r = document.getElementById('prPivRow');
  const c = document.getElementById('prPivCol');
  if (r) r.value = row;
  if (c) c.value = col;
}

/**
 * 거래처 필터 입력. 한 거래처를 정확히 고른 순간 피벗 행이 거래처면(한 줄짜리 표가 되므로)
 * 그 거래처의 품목별 합계(품목 × 합계만)로 바꿔 준다.
 */
function onPeriodReportPartnerChange() {
  if (prPartnerIsExact() && prTab === 'pivot' && (document.getElementById('prPivRow') || {}).value === 'partner') {
    prSetPivot('item', 'none');
  }
  renderPeriodReport();
}

function clearPeriodReportPartner() {
  const el = document.getElementById('prPartner');
  if (el) el.value = '';
  renderPeriodReport();
}

/** 거래처·지점별 탭에서 거래처를 누르면 그 거래처로 필터를 걸고 품목별 합계 피벗으로 간다. */
function drillPeriodReportPartner(name) {
  const el = document.getElementById('prPartner');
  if (!el) return;
  el.value = name || '';
  prSetPivot('item', 'none');
  prTab = 'pivot';
  renderPeriodReport();
}

/** 품목별 탭에서 품목을 누르면 그 품목으로 필터를 걸고 거래처 × 일자 피벗으로 간다. */
function drillPeriodReportItem(label) {
  const el = document.getElementById('prItem');
  if (!el) return;
  el.value = label || '';
  prSetPivot('partner', 'date');
  prTab = 'pivot';
  renderPeriodReport();
}

function prDays() {
  if (!prData) return [];
  const [fy, fm, fd] = prData.from.split('-').map(Number);
  const [ty, tm, td] = prData.to.split('-').map(Number);
  const d = new Date(fy, fm - 1, fd);
  const end = new Date(ty, tm - 1, td);
  const days = [];
  while (d <= end) {
    days.push(prDateStr(d));
    d.setDate(d.getDate() + 1);
  }
  return days;
}

/** 요약 수치 */
function prSummary(rows) {
  const s = { inAll: 0, inFromSub: 0, outAll: 0, ret: 0, move: 0, invoices: new Set(), retInvoices: new Set(), outItems: new Set(), outPartners: new Set() };
  rows.forEach(r => {
    if (r.invoice) s.invoices.add(r.invoice);
    if (r.type === 'INBOUND') {
      s.inAll += r.boxEq;
      if (r.src) s.inFromSub += r.boxEq;
    } else if (r.type === 'OUTBOUND') {
      s.outAll += r.boxEq;
      s.outItems.add(r.itemId);
      if (r.partner) s.outPartners.add(r.partner);
    } else if (r.type === 'RETURN') {
      s.ret += r.boxEq;
      if (r.invoice) s.retInvoices.add(r.invoice);
    } else if (r.type === 'MOVE') {
      s.move += r.boxEq;
    }
  });
  const dayCount = Math.max(1, prDays().length);
  const netOut = s.outAll - s.ret;
  return {
    inAll: s.inAll,
    inFromSub: s.inFromSub,
    outAll: s.outAll,
    ret: s.ret,
    retInvoiceCount: s.retInvoices.size,
    netOut,
    // 같은 기간 출고 대비 반품 비율(반품된 원 출고가 기간 밖일 수도 있으므로 참고치)
    returnRate: s.outAll > 0 ? s.ret / s.outAll : null,
    outPartnerCount: s.outPartners.size,
    move: s.move,
    invoiceCount: s.invoices.size,
    outItemCount: s.outItems.size,
    outPerDay: netOut / dayCount,
    dayCount
  };
}

/** 탭별 표 정의: { columns: [{ key, label, num }], rows: [{...}] } — 화면과 엑셀이 같이 쓴다. */
function prBuildTable(tab, rows) {
  const add = (map, key, init) => {
    if (!map.has(key)) map.set(key, init());
    return map.get(key);
  };

  if (tab === 'pivot') return prBuildPivot(rows);

  if (tab === 'daily') {
    const map = new Map(prDays().map(d => [d, { date: d, inAll: 0, inFromSub: 0, out: 0, ret: 0, move: 0, inv: new Set() }]));
    rows.forEach(r => {
      const g = map.get(r.date);
      if (!g) return;
      if (r.invoice) g.inv.add(r.invoice);
      if (r.type === 'INBOUND') {
        g.inAll += r.boxEq;
        if (r.src) g.inFromSub += r.boxEq;
      } else if (r.type === 'OUTBOUND') g.out += r.boxEq;
      else if (r.type === 'RETURN') g.ret += r.boxEq;
      else if (r.type === 'MOVE') g.move += r.boxEq;
    });
    return {
      columns: [
        { key: 'date', label: '날짜' },
        { key: 'inAll', label: '입고', num: true },
        { key: 'inFromSub', label: '└ 서브창고발', num: true },
        { key: 'out', label: '출고', num: true },
        { key: 'ret', label: '반품', num: true },
        { key: 'netOut', label: '순출고', num: true },
        { key: 'move', label: '이동', num: true },
        { key: 'invCount', label: '전표 수', num: true }
      ],
      rows: Array.from(map.values()).map(g => ({ ...g, netOut: g.out - g.ret, invCount: g.inv.size }))
    };
  }

  if (tab === 'partner') {
    const map = new Map();
    rows.forEach(r => {
      if (r.type !== 'INBOUND' && r.type !== 'OUTBOUND' && r.type !== 'RETURN') return;
      const name = r.partner || '(미지정)';
      const g = add(map, name, () => ({ partner: name, in: 0, out: 0, ret: 0, outInv: new Set(), outItems: new Set() }));
      if (r.type === 'INBOUND') g.in += r.boxEq;
      else if (r.type === 'RETURN') g.ret += r.boxEq;
      else {
        g.out += r.boxEq;
        if (r.invoice) g.outInv.add(r.invoice);
        g.outItems.add(r.itemId);
      }
    });
    return {
      columns: [
        { key: 'partner', label: '거래처' },
        { key: 'kind', label: '구분' },
        { key: 'out', label: '출고', num: true },
        { key: 'ret', label: '반품', num: true },
        { key: 'netOut', label: '순출고', num: true },
        { key: 'retRate', label: '반품률' },
        { key: 'outInvCount', label: '출고 전표 수', num: true },
        { key: 'outItemCount', label: '출고 품목 수', num: true },
        { key: 'in', label: '입고', num: true }
      ],
      rows: Array.from(map.values())
        .map(g => ({
          partner: g.partner,
          _partner: g.partner === '(미지정)' ? '' : g.partner,
          // 내부 창고로 가는 출고는 보통 이동(MOVE)으로 기록되지만, 이름이 창고인 거래처는 구분해 둔다.
          kind: prIsBranch(g.partner) ? '내부 창고' : (g.out > 0 || g.ret > 0 ? '거래처' : '입고처'),
          out: g.out,
          ret: g.ret,
          netOut: g.out - g.ret,
          retRate: prRate(g.ret, g.out),
          outInvCount: g.outInv.size,
          outItemCount: g.outItems.size,
          in: g.in
        }))
        .sort((a, b) => b.netOut - a.netOut || b.in - a.in),
      drillPartner: true
    };
  }

  if (tab === 'item') {
    const map = new Map();
    rows.forEach(r => {
      const g = add(map, r.itemId, () => ({
        name: r.name, color: r.color, pack: r.pack, _item: prItemLabel(r),
        outBox: 0, outUnit: 0, out: 0, ret: 0, outLines: 0, outPartners: new Set(), in: 0, move: 0
      }));
      if (r.type === 'OUTBOUND') {
        g.outBox += r.box;
        g.outUnit += r.unit;
        g.out += r.boxEq;
        g.outLines += 1;
        if (r.partner) g.outPartners.add(r.partner);
      } else if (r.type === 'INBOUND') g.in += r.boxEq;
      else if (r.type === 'RETURN') g.ret += r.boxEq;
      else if (r.type === 'MOVE') g.move += r.boxEq;
    });
    return {
      columns: [
        { key: 'name', label: '품명' },
        { key: 'color', label: '컬러' },
        { key: 'pack', label: '입수', num: true },
        { key: 'outBox', label: '출고 상자', num: true },
        { key: 'outUnit', label: '출고 낱개', num: true },
        { key: 'out', label: '출고(환산)', num: true },
        { key: 'ret', label: '반품', num: true },
        { key: 'netOut', label: '순출고', num: true },
        { key: 'retRate', label: '반품률' },
        { key: 'outLines', label: '출고 횟수', num: true },
        { key: 'outPartnerCount', label: '출고 거래처 수', num: true },
        { key: 'in', label: '입고', num: true },
        { key: 'move', label: '이동', num: true }
      ],
      rows: Array.from(map.values())
        .map(g => ({ ...g, netOut: g.out - g.ret, retRate: prRate(g.ret, g.out), outPartnerCount: g.outPartners.size }))
        .sort((a, b) => b.netOut - a.netOut || b.in - a.in),
      drillItem: true
    };
  }

  if (tab === 'warehouse') {
    const map = new Map();
    const get = wh => add(map, wh, () => ({ wh, in: 0, out: 0, ret: 0, toMain: 0, moveOut: 0, moveIn: 0 }));
    rows.forEach(r => {
      if (r.type === 'INBOUND') {
        get(r.wh).in += r.boxEq;
        if (r.src) get(r.src).toMain += r.boxEq; // 서브창고 → 본사 입고확정으로 그 창고에서 빠진 양
      }
      else if (r.type === 'OUTBOUND') get(r.wh).out += r.boxEq;
      else if (r.type === 'RETURN') get(r.wh).ret += r.boxEq; // 반품을 받은 창고
      else if (r.type === 'MOVE') {
        get(r.src || r.wh).moveOut += r.boxEq;
        if (r.dst) get(r.dst).moveIn += r.boxEq;
      }
    });
    return {
      columns: [
        { key: 'wh', label: '창고' },
        { key: 'in', label: '입고', num: true },
        { key: 'out', label: '출고', num: true },
        { key: 'ret', label: '반품 받음', num: true },
        { key: 'toMain', label: '본사로 보냄', num: true },
        { key: 'moveOut', label: '이동 나감', num: true },
        { key: 'moveIn', label: '이동 들어옴', num: true }
      ],
      rows: Array.from(map.values()).sort((a, b) => (a.wh === 'MAIN' ? -1 : b.wh === 'MAIN' ? 1 : a.wh.localeCompare(b.wh)))
    };
  }

  // handler
  const map = new Map();
  rows.forEach(r => {
    const name = r.handler || '(미지정)';
    const g = add(map, name, () => ({ handler: name, in: 0, out: 0, ret: 0, move: 0, inv: new Set() }));
    if (r.invoice) g.inv.add(r.invoice);
    if (r.type === 'INBOUND') g.in += r.boxEq;
    else if (r.type === 'OUTBOUND') g.out += r.boxEq;
    else if (r.type === 'RETURN') g.ret += r.boxEq;
    else if (r.type === 'MOVE') g.move += r.boxEq;
  });
  return {
    columns: [
      { key: 'handler', label: '담당자' },
      { key: 'in', label: '입고', num: true },
      { key: 'out', label: '출고', num: true },
      { key: 'ret', label: '반품', num: true },
      { key: 'move', label: '이동', num: true },
      { key: 'invCount', label: '전표 수', num: true }
    ],
    rows: Array.from(map.values())
      .map(g => ({ handler: g.handler, in: g.in, out: g.out, ret: g.ret, move: g.move, invCount: g.inv.size }))
      .sort((a, b) => (b.in + b.out + b.ret + b.move) - (a.in + a.out + a.ret + a.move))
  };
}

function prIsAnalysisTab(tab = prTab) {
  return PR_TABS.some(t => t.key === tab && t.analysis);
}

function prLeadDays() {
  const v = Math.round(Number((document.getElementById('prLeadDays') || {}).value));
  return v > 0 ? Math.min(v, 365) : 14;
}

/** 품목별 현재 재고(상자 환산)와 기간 판매 속도. 창고 필터와 상관없이 전체 출고 기준. */
function prAnalysisItems() {
  if (!prData || !prSnapshot) return null;
  const days = Math.max(1, prDays().length);
  const outMap = new Map();
  prData.rows.forEach(r => {
    if (r.type === 'OUTBOUND') outMap.set(r.itemId, (outMap.get(r.itemId) || 0) + r.boxEq);
    else if (r.type === 'RETURN') outMap.set(r.itemId, (outMap.get(r.itemId) || 0) - r.boxEq);
  });
  const itemMatch = prItemMatcher();
  return prSnapshot.filter(it => !itemMatch || itemMatch(it)).map(it => {
    const main = it.mainUnits / it.pack;
    const sub = it.subUnits / it.pack;
    const held = it.heldUnits / it.pack;
    // 이동중(서브창고 → MAIN 발주)은 아직 서브창고 재고에 들어 있으므로 전체 재고에 다시 더하지 않는다.
    const mainAvail = Math.max(0, main + it.inTransitBoxes - held);
    const total = Math.max(0, main + sub - held);
    const out = Math.max(0, outMap.get(it.itemId) || 0); // 순출고 (반품이 출고보다 많으면 0)
    const avg = out / days;
    return {
      ...it,
      main, sub, held, mainAvail, total, out, avg,
      coverMain: avg > 0 ? mainAvail / avg : null,
      coverTotal: avg > 0 ? total / avg : null
    };
  });
}

function prAnalysisTable(tab) {
  const list = prAnalysisItems();
  if (!list) return null;
  const days = n => (n == null ? '-' : Math.round(n));

  if (tab === 'cover') {
    const rows = list.filter(it => it.avg > 0).map(it => {
      const c = it.coverMain;
      const status = it.mainAvail <= 0 ? '🔴 메인 품절' : c < 7 ? '🔴 1주 내 소진' : c < 14 ? '🟠 2주 내 소진' : c < 30 ? '🟡 한 달 내' : '';
      return {
        name: it.name, color: it.color, mainAvail: it.mainAvail, sub: it.sub, avg: it.avg,
        coverMain: days(it.coverMain), coverTotal: days(it.coverTotal), status, _sort: c
      };
    }).sort((a, b) => a._sort - b._sort || b.avg - a.avg);
    return {
      columns: [
        { key: 'name', label: '품명' },
        { key: 'color', label: '컬러' },
        { key: 'mainAvail', label: '메인 가용(실재고+이동중−보류)', num: true, zero: true },
        { key: 'sub', label: '서브창고 재고', num: true },
        { key: 'avg', label: '일평균 출고', num: true },
        { key: 'coverMain', label: '메인 소진일', num: true, zero: true },
        { key: 'coverTotal', label: '전체 소진일', num: true, zero: true },
        { key: 'status', label: '상태' }
      ],
      rows
    };
  }

  if (tab === 'dead') {
    const fromDate = prData.from;
    // 가장 이른 등록일은 시스템 이전 시 일괄 등록한 날이라 '신규'로 보지 않는다.
    const createdDates = list.map(it => (it.createdAt ? prDateStr(new Date(it.createdAt)) : '')).filter(Boolean).sort();
    const importDay = createdDates[0] || '';
    const rows = list.filter(it => it.total > 0 && (it.avg === 0 || it.coverTotal > PR_DEAD_COVER_DAYS)).map(it => {
      const created = it.createdAt ? prDateStr(new Date(it.createdAt)) : '';
      return {
        name: it.name, color: it.color, main: it.main, sub: it.sub, total: it.total, out: it.out,
        coverTotal: it.avg === 0 ? '출고 없음' : Math.round(it.coverTotal),
        created,
        note: created && created >= fromDate && created !== importDay ? '기간 중 신규 등록' : ''
      };
    }).sort((a, b) => (a.out === 0 ? 0 : 1) - (b.out === 0 ? 0 : 1) || b.total - a.total);
    return {
      columns: [
        { key: 'name', label: '품명' },
        { key: 'color', label: '컬러' },
        { key: 'main', label: '메인 재고', num: true },
        { key: 'sub', label: '서브창고 재고', num: true },
        { key: 'total', label: '전체 재고', num: true },
        { key: 'out', label: '기간 출고', num: true },
        { key: 'coverTotal', label: '전체 소진일', num: true },
        { key: 'created', label: '등록일' },
        { key: 'note', label: '비고' }
      ],
      rows
    };
  }

  // safety: 권장 안전재고 = 일평균 출고 × 보충 기간(일)
  const lead = prLeadDays();
  const ORDER = { '🔴 부족': 0, '🟡 미설정': 1, '🔵 과다': 2, '⚪ 기간 중 출고 없음': 3, '🟢 적정': 4 };
  const rows = list.filter(it => it.safeBoxes > 0 || it.avg > 0).map(it => {
    const suggested = Math.ceil(it.avg * lead);
    let verdict = '🟢 적정';
    if (it.avg === 0) verdict = '⚪ 기간 중 출고 없음';
    else if (it.safeBoxes === 0) verdict = '🟡 미설정';
    else if (it.safeBoxes > suggested * 2) verdict = '🔵 과다';
    else if (it.safeBoxes < suggested * 0.5) verdict = '🔴 부족';
    return {
      name: it.name, color: it.color, safe: it.safeBoxes, avg: it.avg, suggested,
      diff: it.safeBoxes - suggested, mainAvail: it.mainAvail, verdict
    };
  }).sort((a, b) => ORDER[a.verdict] - ORDER[b.verdict] || Math.abs(b.diff) - Math.abs(a.diff));
  return {
    columns: [
      { key: 'name', label: '품명' },
      { key: 'color', label: '컬러' },
      { key: 'safe', label: '현재 안전재고', num: true, zero: true },
      { key: 'avg', label: '일평균 출고', num: true },
      { key: 'suggested', label: `권장(${lead}일분)`, num: true, zero: true },
      { key: 'diff', label: '차이(현재−권장)', num: true, zero: true },
      { key: 'mainAvail', label: '메인 가용', num: true, zero: true },
      { key: 'verdict', label: '판정' }
    ],
    rows
  };
}

function setPeriodReportTab(tab) {
  prTab = tab;
  renderPeriodReport();
}

function onPeriodReportFilterChange() {
  renderPeriodReport();
}

function renderPeriodReport() {
  const tabsEl = document.getElementById('prTabs');
  if (tabsEl) {
    tabsEl.innerHTML = PR_TABS.map((t, i) => {
      const on = t.key === prTab;
      const sep = t.analysis && !PR_TABS[i - 1].analysis
        ? '<span style="align-self:center; font-size:8pt; font-weight:800; color:#475569; margin-left:6px;">📦 재고 분석:</span>'
        : '';
      return sep + `<button type="button" onclick="setPeriodReportTab('${t.key}')" style="padding:5px 12px; border-radius:6px; font-size:8.5pt; font-weight:700; cursor:pointer; border:1px solid ${on ? '#1d4ed8' : '#cbd5e1'}; background:${on ? '#1d4ed8' : '#ffffff'}; color:${on ? '#ffffff' : '#334155'};">${t.label}</button>`;
    }).join('');
  }
  const searchWrap = document.getElementById('prSearchWrap');
  if (searchWrap) searchWrap.style.display = prTab === 'item' || prTab === 'partner' || prIsAnalysisTab() ? 'block' : 'none';
  const leadWrap = document.getElementById('prLeadWrap');
  if (leadWrap) leadWrap.style.display = prTab === 'safety' ? 'inline-flex' : 'none';
  const pivotWrap = document.getElementById('prPivotWrap');
  if (pivotWrap) pivotWrap.style.display = prTab === 'pivot' ? 'inline-flex' : 'none';
  if (prTab === 'pivot') prFillPivotControls();
  const itemEl = document.getElementById('prItem');
  if (itemEl) itemEl.style.background = itemEl.value.trim() ? '#dbeafe' : '#ffffff';
  const partnerEl = document.getElementById('prPartner');
  if (partnerEl) partnerEl.style.background = partnerEl.value.trim() ? '#dbeafe' : '#ffffff';

  const summaryEl = document.getElementById('prSummary');
  const tableEl = document.getElementById('prTable');
  if (!prData) {
    if (summaryEl) summaryEl.innerHTML = '';
    if (tableEl) tableEl.innerHTML = '';
    return;
  }

  const rows = prFilteredRows();
  const s = prSummary(rows);
  if (summaryEl) {
    const card = (title, value, sub, color) => `
      <div style="background:#ffffff; border:1px solid #e2e8f0; border-left:4px solid ${color}; border-radius:8px; padding:10px 12px; min-width:0;">
        <div style="font-size:7.8pt; font-weight:700; color:#64748b;">${title}</div>
        <div style="font-size:14pt; font-weight:900; color:#0f172a;">${value}</div>
        <div style="font-size:7.5pt; color:#64748b; margin-top:2px;">${sub}</div>
      </div>`;
    summaryEl.innerHTML =
      card('📥 입고', `${prFmt(s.inAll)}<span style="font-size:8.5pt; color:#64748b;"> 상자</span>`, `서브창고발 ${prFmt(s.inFromSub)}상자 포함`, '#10b981') +
      card('📤 출고', `${prFmt(s.outAll)}<span style="font-size:8.5pt; color:#64748b;"> 상자</span>`, `거래처 ${s.outPartnerCount.toLocaleString()}곳 · 순출고 ${prFmt(s.netOut)}상자`, '#f59e0b') +
      card('↩️ 반품', `${prFmt(s.ret)}<span style="font-size:8.5pt; color:#64748b;"> 상자</span>`,
        s.ret > 0 ? `반품 전표 ${s.retInvoiceCount.toLocaleString()}건 · 출고 대비 ${s.returnRate == null ? '-' : (s.returnRate * 100).toFixed(1) + '%'}` : '기간 중 반품 없음', '#ea580c') +
      card('📆 일평균 순출고', `${prFmt(s.outPerDay)}<span style="font-size:8.5pt; color:#64748b;"> 상자</span>`, `${s.dayCount}일 기준 · 출고 품목 ${s.outItemCount.toLocaleString()}개`, '#3b82f6') +
      card('🔁 창고 간 이동', `${prFmt(s.move)}<span style="font-size:8.5pt; color:#64748b;"> 상자</span>`, `전표 ${s.invoiceCount.toLocaleString()}건`, '#8b5cf6');
  }

  if (!tableEl) return;
  const table = prIsAnalysisTab() ? prAnalysisTable(prTab) : prBuildTable(prTab, rows);
  if (!table) {
    tableEl.innerHTML = '<div style="padding:24px; text-align:center; color:#94a3b8; font-size:9pt;">⏳ 현재 재고를 불러오는 중입니다...</div>';
    return;
  }
  let list = table.rows;
  const q = String((document.getElementById('prSearch') || {}).value || '').trim().toUpperCase();
  if (q && (prTab === 'item' || prTab === 'partner' || prIsAnalysisTab())) {
    list = list.filter(r => [r.name, r.color, r.partner].some(v => String(v || '').toUpperCase().includes(q)));
  }
  if (!list.length) {
    tableEl.innerHTML = '<div style="padding:24px; text-align:center; color:#94a3b8; font-size:9pt;">이 조건에 해당하는 전표가 없습니다.</div>';
    return;
  }
  const shown = list.slice(0, PR_MAX_TABLE_ROWS);
  // 피벗의 첫 열(행 이름)은 가로 스크롤해도 왼쪽에 붙어 있게 한다.
  const stickyCss = (c, bg) => (c.sticky ? `position:sticky; left:0; background:${bg}; border-right:1.5px solid #cbd5e1;` : '');
  const head = table.columns.map(c => `<th style="padding:6px 8px; text-align:${c.num ? 'right' : 'left'}; white-space:nowrap; position:sticky; top:0; ${c.sticky ? 'left:0; z-index:2; border-right:1.5px solid #cbd5e1;' : 'z-index:1;'} background:#f1f5f9; border-bottom:1.5px solid #cbd5e1;">${escapeHtml(c.label)}</th>`).join('');
  const body = shown.map(r => {
    const bg = r._total ? '#f1f5f9' : '#ffffff';
    const trAttr = table.drillItem && r._item
      ? ` data-item="${escapeHtml(r._item)}" onclick="drillPeriodReportItem(this.dataset.item)" title="이 품목의 거래처 × 일자 피벗 보기" style="border-bottom:1px solid #f1f5f9; cursor:pointer;"`
      : table.drillPartner && r._partner
      ? ` data-partner="${escapeHtml(r._partner)}" onclick="drillPeriodReportPartner(this.dataset.partner)" title="이 거래처의 품목별 합계 피벗 보기" style="border-bottom:1px solid #f1f5f9; cursor:pointer;"`
      : ` style="border-bottom:1px solid #f1f5f9;${r._total ? ' font-weight:800; border-top:1.5px solid #94a3b8;' : ''}"`;
    return `<tr${trAttr}>` + table.columns.map(c => {
      const v = r[c.key];
      let text;
      if (c.num && typeof v !== 'string') {
        text = (Number(v) || (c.zero && v === 0)) ? prFmt(v) : '<span style="color:#cbd5e1;">-</span>';
      } else {
        text = escapeHtml(v == null ? '' : v);
      }
      return `<td style="padding:5px 8px; text-align:${c.num ? 'right' : 'left'}; white-space:nowrap; background:${c.bold && !r._total ? '#f8fafc' : bg};${c.bold ? ' font-weight:800;' : ''} ${stickyCss(c, bg)}">${text}</td>`;
    }).join('') + '</tr>';
  }).join('');
  const more = list.length > shown.length
    ? `<div style="padding:8px; font-size:8pt; color:#64748b; text-align:center;">상위 ${PR_MAX_TABLE_ROWS}행만 표시합니다 (전체 ${list.length.toLocaleString()}행은 엑셀에 들어갑니다).</div>`
    : '';
  tableEl.innerHTML = `<table style="width:100%; border-collapse:collapse; font-size:8.5pt;"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>${more}`;
}

async function downloadPeriodReportXlsx() {
  if (!prData || !prData.rows.length) {
    alert('내려받을 데이터가 없습니다. 먼저 조회하세요.');
    return;
  }
  let XLSX;
  try {
    XLSX = await import('xlsx');
  } catch (e) {
    alert('엑셀 모듈을 불러오지 못했습니다: ' + (e && e.message ? e.message : e));
    return;
  }
  const rows = prFilteredRows();
  const wh = (document.getElementById('prWh') || {}).value || '';
  const s = prSummary(rows);
  const wb = XLSX.utils.book_new();
  const r1 = prRound1;

  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
    ['기간 보고서'],
    ['기간', `${prData.from} ~ ${prData.to}`],
    ['창고', wh || '전체'],
    ['품목 필터', String((document.getElementById('prItem') || {}).value || '').trim() || '전체'],
    ['거래처 필터', prPartnerQuery() || '전체'],
    ['피벗 시트', (() => {
      const p = prPivotSettings();
      return `${PR_PIVOT_DIMS[p.row].label} × ${PR_PIVOT_DIMS[p.col].label} · ${PR_PIVOT_MEASURES[p.measure].label}`;
    })()],
    ['수량 단위', '상자 환산 (상자 + 낱개 ÷ 입수). 이동은 출고에 포함하지 않음. 반품은 입고에 포함하지 않고 따로 셈'],
    [],
    ['입고', r1(s.inAll)],
    ['└ 서브창고발 입고', r1(s.inFromSub)],
    ['출고', r1(s.outAll)],
    ['반품', r1(s.ret)],
    ['순출고 (출고 − 반품)', r1(s.netOut)],
    ['반품률 (출고 대비)', s.returnRate == null ? '' : `${(s.returnRate * 100).toFixed(1)}%`],
    ['반품 전표 수', s.retInvoiceCount],
    ['출고 거래처 수', s.outPartnerCount],
    ['일평균 순출고', r1(s.outPerDay)],
    ['창고 간 이동', r1(s.move)],
    ['전표 수', s.invoiceCount],
    ['출고 품목 수', s.outItemCount]
  ]), '요약');

  PR_TABS.forEach(t => {
    const table = t.analysis ? prAnalysisTable(t.key) : prBuildTable(t.key, rows);
    if (!table) return; // 현재 재고를 아직 못 불러왔으면 분석 시트는 뺀다
    const aoa = [table.columns.map(c => c.label)];
    table.rows.forEach(r => aoa.push(table.columns.map(c => {
      const v = r[c.key];
      if (c.num && typeof v !== 'string') return r1(v);
      return v == null ? '' : v;
    })));
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), t.key === 'pivot' ? '피벗' : t.label.replace(/[·]/g, ''));
  });

  const TYPE_LABEL = { INBOUND: '입고', OUTBOUND: '출고', RETURN: '반품', MOVE: '이동' };
  const ledger = [['날짜', '구분', '창고', '출발', '도착', '거래처', '담당자', '전표번호', '원 출고 전표', '품명', '컬러', '입수', '상자', '낱개', '상자 환산']];
  rows.forEach(r => ledger.push([
    r.date, TYPE_LABEL[r.type] || r.type, r.wh, r.src, r.dst, r.partner, r.handler, r.invoice, r.returnOf || '',
    r.name, r.color, r.pack, r.box, r.unit, r1(r.boxEq)
  ]));
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(ledger), '전표원장');

  XLSX.writeFile(wb, `기간보고서_${prData.from}_${prData.to}${wh ? '_' + wh : ''}.xlsx`);
}

window.openPeriodReportModal = openPeriodReportModal;
window.closePeriodReportModal = closePeriodReportModal;
window.setPeriodReportPreset = setPeriodReportPreset;
window.loadPeriodReport = loadPeriodReport;
window.setPeriodReportTab = setPeriodReportTab;
window.onPeriodReportFilterChange = onPeriodReportFilterChange;
window.downloadPeriodReportXlsx = downloadPeriodReportXlsx;
window.swapPeriodReportPivot = swapPeriodReportPivot;
window.clearPeriodReportItem = clearPeriodReportItem;
window.drillPeriodReportItem = drillPeriodReportItem;
window.onPeriodReportPartnerChange = onPeriodReportPartnerChange;
window.clearPeriodReportPartner = clearPeriodReportPartner;
window.drillPeriodReportPartner = drillPeriodReportPartner;
