/**
 * 창고별 현재 재고 출력 UI 컨트롤러 — 창고를 골라 현재 실재고를 보고, 인쇄하거나 엑셀로 내려받는다.
 * ---------------------------------------------------------------------------
 * index.html의 "📦 창고별 재고" 모달 전용 코드다. index.html에서만 로드되며 그 페이지의 인라인 전역에 의존한다:
 *   - callServer(fnName, args, opt) : supabaseAdapter 브릿지 호출 (getWarehouseStockList)
 *   - escapeHtml(v)                 : HTML 이스케이프 헬퍼
 *
 * 옵션: 0 재고 포함(화면에서 거름), 숨김(비활성) 품목 포함(서버 조회 조건이라 바꾸면 다시 불러온다).
 * 창고를 '전체'로 고르면 창고마다 열을 하나씩 두고 합계를 붙인다. 수량은 장부상 실재고(상자 + 낱개)다.
 * HTML 속성이 호출하는 함수만 파일 하단에서 window에 노출한다.
 */

let wsData = null; // { warehouses, items, includeInactive }
let wsLoading = false;

function wsQty(box, unit) {
  if (!box && !unit) return '0';
  return unit ? `${box.toLocaleString()}+${unit.toLocaleString()}` : box.toLocaleString();
}

/** 낱개 합계를 상자 + 낱개로 (같은 품목이라 입수가 같다) */
function wsSplit(units, pack) {
  const sign = units < 0 ? -1 : 1;
  const abs = Math.abs(units);
  return { box: sign * Math.floor(abs / pack), unit: sign * (abs % pack) };
}

function wsOptions() {
  return {
    wh: (document.getElementById('wsWh') || {}).value || '',
    includeZero: !!(document.getElementById('wsIncludeZero') || {}).checked,
    includeInactive: !!(document.getElementById('wsIncludeInactive') || {}).checked,
    q: String((document.getElementById('wsSearch') || {}).value || '').trim().toUpperCase()
  };
}

function openWarehouseStockModal() {
  const modal = document.getElementById('warehouseStockModal');
  if (!modal) return;
  modal.style.display = 'flex';
  loadWarehouseStock();
}

function closeWarehouseStockModal() {
  const modal = document.getElementById('warehouseStockModal');
  if (modal) modal.style.display = 'none';
}

function wsSetStatus(text, isError) {
  const el = document.getElementById('wsStatus');
  if (!el) return;
  el.textContent = text || '';
  el.style.color = isError ? '#b91c1c' : '#64748b';
}

function loadWarehouseStock() {
  if (wsLoading) return;
  const { includeInactive } = wsOptions();
  wsLoading = true;
  wsSetStatus('⏳ 현재 재고를 불러오는 중...');
  callServer('getWarehouseStockList', [includeInactive], {
    key: 'getWarehouseStockList',
    mode: 'latest',
    onSuccess: res => {
      wsLoading = false;
      wsData = { warehouses: (res && res.warehouses) || [], items: (res && res.items) || [], includeInactive };
      wsFillWarehouseSelect();
      wsSetStatus(`조회 시각 ${new Date().toLocaleString()} · 장부상 실재고(상자+낱개)`);
      renderWarehouseStock();
    },
    onError: err => {
      wsLoading = false;
      wsSetStatus('조회 실패: ' + ((err && err.message) || err), true);
    }
  });
}

function wsFillWarehouseSelect() {
  const sel = document.getElementById('wsWh');
  if (!sel || !wsData) return;
  const cur = sel.value;
  sel.innerHTML = '<option value="">전체 (창고별 열)</option>' +
    wsData.warehouses.map(w => `<option value="${escapeHtml(w.code)}">${escapeHtml(w.code)}${w.name && w.name !== w.code ? ' · ' + escapeHtml(w.name) : ''}</option>`).join('');
  sel.value = wsData.warehouses.some(w => w.code === cur) ? cur : '';
}

function onWarehouseStockOptionChange() {
  // 숨김 품목 포함 여부는 서버 조회 조건이라 바뀌면 다시 불러온다.
  if (wsData && wsOptions().includeInactive !== wsData.includeInactive) {
    loadWarehouseStock();
    return;
  }
  renderWarehouseStock();
}

/** 화면·인쇄·엑셀이 같이 쓰는 표: { columns: [{ key, label, num }], rows, totals } */
function wsBuildTable() {
  if (!wsData) return null;
  const { wh, includeZero, q } = wsOptions();
  const whList = wh ? wsData.warehouses.filter(w => w.code === wh) : wsData.warehouses;
  const rows = [];
  const totalsByWh = {}; // 낱개 합계는 입수가 품목마다 달라 합칠 수 없으므로 상자·낱개를 따로 더한다
  whList.forEach(w => { totalsByWh[w.code] = { box: 0, unit: 0 }; });
  let totalBox = 0;
  let totalUnit = 0;

  wsData.items.forEach(it => {
    if (q && ![it.name, it.color].some(v => String(v || '').toUpperCase().includes(q))) return;
    let units = 0;
    const cells = {};
    whList.forEach(w => {
      const st = it.stocks[w.code] || { box: 0, unit: 0 };
      cells[w.code] = st;
      units += st.box * it.pack + st.unit;
    });
    const nonZero = whList.some(w => cells[w.code].box !== 0 || cells[w.code].unit !== 0);
    if (!nonZero && !includeZero) return;
    whList.forEach(w => {
      totalsByWh[w.code].box += cells[w.code].box;
      totalsByWh[w.code].unit += cells[w.code].unit;
    });
    const sum = wsSplit(units, it.pack);
    totalBox += sum.box;
    totalUnit += sum.unit;
    rows.push({ ...it, cells, sumBox: sum.box, sumUnit: sum.unit, sumUnits: units });
  });

  return { whList, rows, totalsByWh, totalBox, totalUnit, single: !!wh };
}

function renderWarehouseStock() {
  const tableEl = document.getElementById('wsTable');
  const summaryEl = document.getElementById('wsSummary');
  if (!tableEl) return;
  const t = wsBuildTable();
  if (!t) {
    tableEl.innerHTML = '';
    return;
  }
  const inactiveCount = t.rows.filter(r => !r.isActive).length;
  if (summaryEl) {
    summaryEl.textContent = `품목 ${t.rows.length.toLocaleString()}개${inactiveCount ? ` (숨김 ${inactiveCount}개 포함)` : ''} · ` +
      `합계 ${t.totalBox.toLocaleString()}상자 + ${t.totalUnit.toLocaleString()}개`;
  }
  if (!t.rows.length) {
    tableEl.innerHTML = '<div style="padding:24px; text-align:center; color:#94a3b8; font-size:9pt;">조건에 맞는 품목이 없습니다.</div>';
    return;
  }

  const th = (label, right) => `<th style="padding:6px 8px; text-align:${right ? 'right' : 'left'}; white-space:nowrap; position:sticky; top:0; background:#f1f5f9; border-bottom:1.5px solid #cbd5e1;">${escapeHtml(label)}</th>`;
  const td = (html, right, extra = '') => `<td style="padding:4px 8px; text-align:${right ? 'right' : 'left'}; white-space:nowrap;${extra}">${html}</td>`;
  const qtyCell = (box, unit) => {
    if (!box && !unit) return td('<span style="color:#cbd5e1;">0</span>', true);
    return td(escapeHtml(wsQty(box, unit)), true, box < 0 || unit < 0 ? ' color:#dc2626; font-weight:700;' : '');
  };
  const numCell = n => (n
    ? td(n.toLocaleString(), true, n < 0 ? ' color:#dc2626; font-weight:700;' : '')
    : td('<span style="color:#cbd5e1;">0</span>', true));
  const nameCell = r => td(`${escapeHtml(r.name)}${r.isActive ? '' : ' <span style="font-size:7pt; background:#e2e8f0; color:#475569; padding:0 4px; border-radius:3px;">숨김</span>'}`);

  let head;
  let body;
  let foot;
  if (t.single) {
    const w = t.whList[0];
    head = th('품명') + th('컬러') + th('입수', true) + th('상자', true) + th('낱개', true) + th('총 낱개', true);
    body = t.rows.map(r => {
      const c = r.cells[w.code];
      return `<tr style="border-bottom:1px solid #f1f5f9;">${nameCell(r)}${td(escapeHtml(r.color))}${td(r.pack, true)}${numCell(c.box)}${numCell(c.unit)}${td(r.sumUnits.toLocaleString(), true)}</tr>`;
    }).join('');
    const tw = t.totalsByWh[w.code];
    foot = `<tr style="background:#f8fafc; font-weight:800;">${td('합계')}${td('')}${td('')}${td(tw.box.toLocaleString(), true)}${td(tw.unit.toLocaleString(), true)}${td('')}</tr>`;
  } else {
    head = th('품명') + th('컬러') + th('입수', true) + t.whList.map(w => th(w.code, true)).join('') + th('합계', true);
    body = t.rows.map(r => `<tr style="border-bottom:1px solid #f1f5f9;">${nameCell(r)}${td(escapeHtml(r.color))}${td(r.pack, true)}` +
      t.whList.map(w => qtyCell(r.cells[w.code].box, r.cells[w.code].unit)).join('') +
      td(`<b>${escapeHtml(wsQty(r.sumBox, r.sumUnit))}</b>`, true) + '</tr>').join('');
    foot = `<tr style="background:#f8fafc; font-weight:800;">${td('합계')}${td('')}${td('')}` +
      t.whList.map(w => td(escapeHtml(wsQty(t.totalsByWh[w.code].box, t.totalsByWh[w.code].unit)), true)).join('') +
      td(escapeHtml(wsQty(t.totalBox, t.totalUnit)), true) + '</tr>';
  }
  tableEl.innerHTML = `<table style="width:100%; border-collapse:collapse; font-size:8.5pt;"><thead><tr>${head}</tr></thead><tbody>${body}</tbody><tfoot>${foot}</tfoot></table>`;
}

function wsOptionLabel() {
  const { wh, includeZero, includeInactive, q } = wsOptions();
  return [
    `창고: ${wh || '전체'}`,
    `0 재고 ${includeZero ? '포함' : '제외'}`,
    `숨김 품목 ${includeInactive ? '포함' : '제외'}`,
    q ? `검색: ${q}` : ''
  ].filter(Boolean).join(' · ');
}

function printWarehouseStock() {
  const t = wsBuildTable();
  if (!t || !t.rows.length) {
    alert('인쇄할 재고가 없습니다.');
    return;
  }
  const tableEl = document.getElementById('wsTable');
  const win = window.open('', '_blank');
  if (!win) {
    alert('팝업이 차단되어 인쇄 창을 열 수 없습니다. 브라우저에서 팝업을 허용해 주세요.');
    return;
  }
  const summary = (document.getElementById('wsSummary') || {}).textContent || '';
  win.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>창고별 현재 재고</title>
<style>
  body { font-family: 'Malgun Gothic', sans-serif; margin: 12mm; color: #0f172a; }
  h1 { font-size: 14pt; margin: 0 0 4px; }
  .meta { font-size: 8.5pt; color: #475569; margin-bottom: 8px; }
  table { width: 100%; border-collapse: collapse; font-size: 8pt; }
  th, td { border: 1px solid #cbd5e1; padding: 3px 5px; }
  th { background: #f1f5f9 !important; position: static !important; }
  thead { display: table-header-group; }
  tfoot { display: table-row-group; }
  tr { page-break-inside: avoid; }
  @page { size: ${t.single ? 'A4 portrait' : 'A4 landscape'}; margin: 10mm; }
</style></head><body>
<h1>📦 창고별 현재 재고</h1>
<div class="meta">${escapeHtml(wsOptionLabel())}<br>${escapeHtml(summary)} · 출력 ${escapeHtml(new Date().toLocaleString())}</div>
${tableEl ? tableEl.innerHTML : ''}
</body></html>`);
  win.document.close();
  win.focus();
  setTimeout(() => win.print(), 200);
}

async function downloadWarehouseStockXlsx() {
  const t = wsBuildTable();
  if (!t || !t.rows.length) {
    alert('내려받을 재고가 없습니다.');
    return;
  }
  let XLSX;
  try {
    XLSX = await import('xlsx');
  } catch (e) {
    alert('엑셀 모듈을 불러오지 못했습니다: ' + (e && e.message ? e.message : e));
    return;
  }
  // 엑셀은 계산하기 쉽게 창고마다 상자·낱개 열을 따로 둔다.
  const header = ['품명', '컬러', '입수', '상태'];
  t.whList.forEach(w => header.push(`${w.code} 상자`, `${w.code} 낱개`));
  header.push('합계 상자', '합계 낱개', '총 낱개');
  const aoa = [
    ['창고별 현재 재고'],
    [wsOptionLabel()],
    [`출력 ${new Date().toLocaleString()}`],
    [],
    header
  ];
  t.rows.forEach(r => {
    const row = [r.name, r.color, r.pack, r.isActive ? '' : '숨김'];
    t.whList.forEach(w => row.push(r.cells[w.code].box, r.cells[w.code].unit));
    row.push(r.sumBox, r.sumUnit, r.sumUnits);
    aoa.push(row);
  });
  const totalRow = ['합계', '', '', ''];
  t.whList.forEach(w => totalRow.push(t.totalsByWh[w.code].box, t.totalsByWh[w.code].unit));
  totalRow.push(t.totalBox, t.totalUnit, '');
  aoa.push(totalRow);

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), '창고별 재고');
  const { wh } = wsOptions();
  const stamp = new Date().toISOString().slice(0, 10);
  XLSX.writeFile(wb, `창고별재고_${wh || '전체'}_${stamp}.xlsx`);
}

window.openWarehouseStockModal = openWarehouseStockModal;
window.closeWarehouseStockModal = closeWarehouseStockModal;
window.loadWarehouseStock = loadWarehouseStock;
window.onWarehouseStockOptionChange = onWarehouseStockOptionChange;
window.printWarehouseStock = printWarehouseStock;
window.downloadWarehouseStockXlsx = downloadWarehouseStockXlsx;
