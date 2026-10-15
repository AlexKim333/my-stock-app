/**
 * 창고별 현재 재고 출력 UI 컨트롤러 — 창고를 골라 현재 실재고를 보고, 인쇄하거나 엑셀로 내려받는다.
 * ---------------------------------------------------------------------------
 * index.html의 "📦 창고별 재고" 모달 전용 코드다. index.html에서만 로드되며 그 페이지의 인라인 전역에 의존한다:
 *   - callServer(fnName, args, opt) : supabaseAdapter 브릿지 호출 (getWarehouseStockList)
 *   - escapeHtml(v)                 : HTML 이스케이프 헬퍼
 *
 * 옵션: 0 재고 포함(화면에서 거름), 숨김(비활성) 품목 포함(서버 조회 조건이라 바꾸면 다시 불러온다),
 * 제조사 필터(화면에서 거름, 제조사가 없는 품목은 '(미지정)').
 * 창고를 '전체'로 고르면 창고마다 열을 하나씩 두고 합계를 붙인다. 수량은 장부상 실재고(상자 + 낱개)다.
 *
 * 수정 모드:
 *   - 제조사: 목록에서 고르거나 새로 추가한다(setItemsBrand / createManufacturer). 자유 입력은 받지 않는다.
 *   - 수량: 창고를 하나 골랐을 때만. 퀵 재고조정과 같은 치환 전표(ADJUST)로 남는다(adjustWarehouseStock).
 *     보류 물건도 같은 선반에 보관하므로 입력값은 실재고(센 수량)다. 출고 보류·입고 예정 발주보다 적게는
 *     저장할 수 없고, 화면을 연 뒤 재고가 바뀌었으면 서버가 거절한다.
 * HTML 속성이 호출하는 함수만 파일 하단에서 window에 노출한다.
 */

let wsData = null; // { warehouses, items, brands, includeInactive }
let wsLoading = false;
let wsAdjust = null; // 수량 수정 대화상자 대상 { item, wh, cur, reserved }

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
    mfg: (document.getElementById('wsMfg') || {}).value || '',
    editMode: !!(document.getElementById('wsEditMode') || {}).checked,
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
      wsData = { warehouses: (res && res.warehouses) || [], items: (res && res.items) || [], brands: (res && res.brands) || [], includeInactive };
      wsFillWarehouseSelect();
      wsData.loadedStatus = `조회 시각 ${new Date().toLocaleString()} · 장부상 실재고(상자+낱개)`;
      wsSetStatus(wsData.loadedStatus);
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

  const mfgSel = document.getElementById('wsMfg');
  if (mfgSel) {
    const curMfg = mfgSel.value;
    const names = Array.from(new Set(wsData.items.map(it => it.manufacturer).filter(Boolean))).sort();
    const hasNone = wsData.items.some(it => !it.manufacturer);
    mfgSel.innerHTML = '<option value="">전체 제조사</option>' +
      names.map(n => `<option value="${escapeHtml(n)}">${escapeHtml(n)}</option>`).join('') +
      (hasNone ? '<option value="__NONE__">(미지정)</option>' : '');
    mfgSel.value = (curMfg === '__NONE__' && hasNone) || names.includes(curMfg) ? curMfg : '';
  }
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
  const { wh, includeZero, q, mfg } = wsOptions();
  const whList = wh ? wsData.warehouses.filter(w => w.code === wh) : wsData.warehouses;
  const rows = [];
  const totalsByWh = {}; // 낱개 합계는 입수가 품목마다 달라 합칠 수 없으므로 상자·낱개를 따로 더한다
  whList.forEach(w => { totalsByWh[w.code] = { box: 0, unit: 0 }; });
  let totalBox = 0;
  let totalUnit = 0;

  wsData.items.forEach(it => {
    if (mfg && (mfg === '__NONE__' ? !!it.manufacturer : it.manufacturer !== mfg)) return;
    if (q && ![it.name, it.color, it.manufacturer].some(v => String(v || '').toUpperCase().includes(q))) return;
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
  const { editMode } = wsOptions();
  if (editMode !== wsData.lastEditMode) {
    wsData.lastEditMode = editMode;
    wsSetStatus(!editMode ? wsData.loadedStatus : t.single
      ? '✏️ 수정 모드 · 제조사는 목록에서 고르고, 수량은 ✏️로 재고조정 전표를 남깁니다'
      : '✏️ 수정 모드 · 제조사는 목록에서 고르세요. 수량을 고치려면 창고를 하나 고르세요');
  }
  tableEl.innerHTML = wsTableHtml(t, editMode);
}

/** 예약 낱개(출고 보류 + 입고 예정 발주) */
function wsReserved(item, wh) {
  const r = (item.reserved && item.reserved[wh]) || { held: 0, committed: 0 };
  return { held: r.held || 0, committed: r.committed || 0, total: (r.held || 0) + (r.committed || 0) };
}

function wsUnitsLabel(units, pack) {
  const s = wsSplit(units, pack);
  if (pack <= 1 || (s.box === 0 && s.unit !== 0)) return `${units}개`;
  return `${s.box}상자${s.unit ? ` ${s.unit}개` : ''}`;
}

/** 표 HTML. editable = 수정 모드(제조사 선택·수량 수정 버튼). 인쇄는 항상 editable=false. */
function wsTableHtml(t, editable) {
  const th = (label, right) => `<th style="padding:6px 8px; text-align:${right ? 'right' : 'left'}; white-space:nowrap; position:sticky; top:0; background:#f1f5f9; border-bottom:1.5px solid #cbd5e1;">${escapeHtml(label)}</th>`;
  const td = (html, right, extra = '') => `<td style="padding:4px 8px; text-align:${right ? 'right' : 'left'}; white-space:nowrap;${extra}">${html}</td>`;
  const qtyCell = (box, unit) => {
    if (!box && !unit) return td('<span style="color:#cbd5e1;">0</span>', true);
    return td(escapeHtml(wsQty(box, unit)), true, box < 0 || unit < 0 ? ' color:#dc2626; font-weight:700;' : '');
  };
  const numCell = n => (n
    ? td(n.toLocaleString(), true, n < 0 ? ' color:#dc2626; font-weight:700;' : '')
    : td('<span style="color:#cbd5e1;">0</span>', true));
  const brandOptions = editable
    ? (wsData.brands || []).map(b => `<option value="${escapeHtml(b.id)}">${escapeHtml(b.name)}</option>`).join('')
    : '';
  const mfgCell = r => {
    if (!editable) return td(r.manufacturer ? escapeHtml(r.manufacturer) : '<span style="color:#cbd5e1;">-</span>');
    const opts = r.brandId ? brandOptions.replace(`value="${escapeHtml(r.brandId)}"`, `value="${escapeHtml(r.brandId)}" selected`) : brandOptions;
    return td(`<select data-ws-item="${escapeHtml(r.itemId)}" data-prev="${escapeHtml(r.brandId || '')}" onchange="onWsBrandChange(this)" style="padding:2px 4px; border:1px solid #fcd34d; border-radius:4px; font-size:8pt; max-width:150px;">` +
      `<option value="">(미지정)</option>${opts}<option value="__NEW__">＋ 새 제조사…</option></select>`);
  };
  const nameCell = r => td(`${escapeHtml(r.name)}${r.isActive ? '' : ' <span style="font-size:7pt; background:#e2e8f0; color:#475569; padding:0 4px; border-radius:3px;">숨김</span>'}`);

  let head;
  let body;
  let foot;
  if (t.single) {
    const w = t.whList[0];
    head = th('품명') + th('컬러') + th('제조사') + th('입수', true) + th('상자', true) + th('낱개', true) + th('총 낱개', true) +
      (editable ? th('보류·발주 예약', true) + th('수정') : '');
    body = t.rows.map(r => {
      const c = r.cells[w.code];
      let extra = '';
      if (editable) {
        const rs = wsReserved(r, w.code);
        extra = (rs.total
          ? td(escapeHtml(wsUnitsLabel(rs.total, r.pack)), true, ' color:#b45309; font-weight:700;')
          : td('<span style="color:#cbd5e1;">-</span>', true)) +
          td(`<button type="button" onclick="openWsAdjustDialog('${escapeHtml(r.itemId)}')" style="padding:1px 8px; background:#0f766e; color:#ffffff; border:none; border-radius:4px; font-size:8pt; cursor:pointer;">✏️ 수량</button>`);
      }
      return `<tr style="border-bottom:1px solid #f1f5f9;">${nameCell(r)}${td(escapeHtml(r.color))}${mfgCell(r)}${td(r.pack, true)}${numCell(c.box)}${numCell(c.unit)}${td(r.sumUnits.toLocaleString(), true)}${extra}</tr>`;
    }).join('');
    const tw = t.totalsByWh[w.code];
    foot = `<tr style="background:#f8fafc; font-weight:800;">${td('합계')}${td('')}${td('')}${td('')}${td(tw.box.toLocaleString(), true)}${td(tw.unit.toLocaleString(), true)}${td('')}${editable ? td('') + td('') : ''}</tr>`;
  } else {
    head = th('품명') + th('컬러') + th('제조사') + th('입수', true) + t.whList.map(w => th(w.code, true)).join('') + th('합계', true);
    body = t.rows.map(r => `<tr style="border-bottom:1px solid #f1f5f9;">${nameCell(r)}${td(escapeHtml(r.color))}${mfgCell(r)}${td(r.pack, true)}` +
      t.whList.map(w => qtyCell(r.cells[w.code].box, r.cells[w.code].unit)).join('') +
      td(`<b>${escapeHtml(wsQty(r.sumBox, r.sumUnit))}</b>`, true) + '</tr>').join('');
    foot = `<tr style="background:#f8fafc; font-weight:800;">${td('합계')}${td('')}${td('')}${td('')}` +
      t.whList.map(w => td(escapeHtml(wsQty(t.totalsByWh[w.code].box, t.totalsByWh[w.code].unit)), true)).join('') +
      td(escapeHtml(wsQty(t.totalBox, t.totalUnit)), true) + '</tr>';
  }
  return `<table style="width:100%; border-collapse:collapse; font-size:8.5pt;"><thead><tr>${head}</tr></thead><tbody>${body}</tbody><tfoot>${foot}</tfoot></table>`;
}

function wsOptionLabel() {
  const { wh, includeZero, includeInactive, q, mfg } = wsOptions();
  return [
    `창고: ${wh || '전체'}`,
    mfg ? `제조사: ${mfg === '__NONE__' ? '(미지정)' : mfg}` : '',
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
${wsTableHtml(t, false)}
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
  const header = ['품명', '컬러', '제조사', '입수', '상태'];
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
    const row = [r.name, r.color, r.manufacturer, r.pack, r.isActive ? '' : '숨김'];
    t.whList.forEach(w => row.push(r.cells[w.code].box, r.cells[w.code].unit));
    row.push(r.sumBox, r.sumUnit, r.sumUnits);
    aoa.push(row);
  });
  const totalRow = ['합계', '', '', '', ''];
  t.whList.forEach(w => totalRow.push(t.totalsByWh[w.code].box, t.totalsByWh[w.code].unit));
  totalRow.push(t.totalBox, t.totalUnit, '');
  aoa.push(totalRow);

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), '창고별 재고');
  const { wh } = wsOptions();
  const stamp = new Date().toISOString().slice(0, 10);
  XLSX.writeFile(wb, `창고별재고_${wh || '전체'}_${stamp}.xlsx`);
}

/* ───────── 수정 모드: 제조사 ───────── */

function onWsBrandChange(sel) {
  const item = wsData && wsData.items.find(it => it.itemId === sel.dataset.wsItem);
  if (!item) return;

  if (sel.value !== '__NEW__') {
    const brand = (wsData.brands || []).find(b => b.id === sel.value);
    wsApplyBrand(sel, item, sel.value, brand ? brand.name : '');
    return;
  }

  const name = String(prompt('새 제조사 이름을 입력하세요') || '').trim();
  if (!name) {
    sel.value = sel.dataset.prev || '';
    return;
  }
  // 대소문자만 다른 이름은 새로 만들지 않고 기존 제조사로 지정한다.
  const dup = (wsData.brands || []).find(b => String(b.name).trim().toUpperCase() === name.toUpperCase());
  if (dup) {
    sel.value = dup.id;
    wsApplyBrand(sel, item, dup.id, dup.name);
    return;
  }
  sel.disabled = true;
  callServer('createManufacturer', [name], {
    key: 'wsCreateBrand',
    onSuccess: res => {
      if (!res || !res.id) {
        sel.disabled = false;
        sel.value = sel.dataset.prev || '';
        alert('제조사는 추가되었지만 ID를 받지 못했습니다. 새로고침 후 목록에서 고르세요.');
        return;
      }
      if (!(wsData.brands || []).some(b => b.id === res.id)) {
        wsData.brands = [...(wsData.brands || []), { id: res.id, name: res.name || name }]
          .sort((a, b) => String(a.name).localeCompare(String(b.name)));
      }
      renderWarehouseStock(); // 모든 행의 목록에 새 제조사를 넣는다
      const fresh = document.querySelector(`#wsTable select[data-ws-item="${CSS.escape(item.itemId)}"]`) || sel;
      fresh.value = res.id;
      wsApplyBrand(fresh, item, res.id, res.name || name);
    },
    onError: err => {
      sel.disabled = false;
      sel.value = sel.dataset.prev || '';
      alert('제조사를 추가하지 못했습니다: ' + ((err && err.message) || err));
    }
  });
}

function wsApplyBrand(sel, item, brandId, brandName) {
  sel.disabled = true;
  callServer('setItemsBrand', [{ itemIds: [item.itemId], brandId: brandId || null }], {
    key: 'wsSetBrand_' + item.itemId,
    onSuccess: () => {
      item.brandId = brandId || '';
      item.manufacturer = brandName || '';
      sel.dataset.prev = item.brandId;
      sel.disabled = false;
      wsSetStatus(`✅ ${item.name} (${item.color}) 제조사 → ${brandName || '(미지정)'}`);
      wsFillWarehouseSelect(); // 제조사 필터 목록 갱신
    },
    onError: err => {
      sel.disabled = false;
      sel.value = sel.dataset.prev || '';
      alert('제조사를 바꾸지 못했습니다: ' + ((err && err.message) || err));
    }
  });
}

/* ───────── 수정 모드: 수량 (재고조정 전표) ───────── */

function openWsAdjustDialog(itemId) {
  const { wh } = wsOptions();
  const item = wsData && wsData.items.find(it => it.itemId === itemId);
  if (!item || !wh) return;
  const cur = item.stocks[wh] || { box: 0, unit: 0 };
  const curUnits = cur.box * item.pack + cur.unit;
  const rs = wsReserved(item, wh);
  wsAdjust = { item, wh, cur, curUnits, reserved: rs };

  document.getElementById('wsAdjTitle').textContent = `${item.name} (${item.color}) · 입수 ${item.pack} · 창고 ${wh}`;
  const line = (label, units, color) =>
    `<div style="display:flex; justify-content:space-between;"><span>${label}</span><b style="color:${color || '#0f172a'};">${escapeHtml(wsUnitsLabel(units, item.pack))}</b></div>`;
  document.getElementById('wsAdjInfo').innerHTML =
    line('현재 실재고 (장부)', curUnits) +
    (rs.held ? line('− 출고 보류', rs.held, '#b45309') : '') +
    (rs.committed ? line('− MAIN 입고 예정 발주', rs.committed, '#b45309') : '') +
    line('= 가용재고', curUnits - rs.total, '#0f766e') +
    (rs.total
      ? `<div style="margin-top:6px; color:#b45309; font-weight:700;">⚠️ 보류·발주가 ${escapeHtml(wsUnitsLabel(rs.total, item.pack))} 걸려 있어 그보다 적게는 저장할 수 없습니다. 보류 물건도 선반에 있으니 함께 센 수량을 넣으세요.</div>`
      : '<div style="margin-top:6px; color:#64748b;">걸려 있는 보류·발주가 없습니다.</div>');

  const boxEl = document.getElementById('wsAdjBox');
  const unitEl = document.getElementById('wsAdjUnit');
  boxEl.value = cur.box;
  unitEl.value = cur.unit;
  boxEl.disabled = item.pack <= 1;
  if (item.pack <= 1) { boxEl.value = 0; unitEl.value = curUnits; }
  document.getElementById('wsAdjReason').value = '';
  document.getElementById('wsAdjustDialog').style.display = 'flex';
  onWsAdjustInput();
  setTimeout(() => (item.pack > 1 ? boxEl : unitEl).focus(), 0);
}

function closeWsAdjustDialog() {
  document.getElementById('wsAdjustDialog').style.display = 'none';
  wsAdjust = null;
}

function wsAdjustTarget() {
  const int = id => Math.max(0, Math.trunc(Number((document.getElementById(id) || {}).value) || 0));
  const box = int('wsAdjBox');
  const unit = int('wsAdjUnit');
  return { box, unit, units: box * wsAdjust.item.pack + unit };
}

function onWsAdjustInput() {
  if (!wsAdjust) return;
  const t = wsAdjustTarget();
  const { item, curUnits, reserved } = wsAdjust;
  const status = document.getElementById('wsAdjStatus');
  const btn = document.getElementById('wsAdjSave');
  let ok = true;
  if (t.units < reserved.total) {
    ok = false;
    status.style.color = '#b91c1c';
    status.textContent = `보류·발주(${wsUnitsLabel(reserved.total, item.pack)})보다 적게 저장할 수 없습니다. 먼저 보류·발주를 줄이세요.`;
  } else if (t.units === curUnits) {
    ok = false;
    status.style.color = '#64748b';
    status.textContent = '현재 재고와 같습니다.';
  } else {
    const d = t.units - curUnits;
    status.style.color = '#475569';
    status.textContent = `${wsUnitsLabel(curUnits, item.pack)} → ${wsUnitsLabel(t.units, item.pack)} ` +
      `(${d > 0 ? '+' : '−'}${wsUnitsLabel(Math.abs(d), item.pack)}) · 가용 ${wsUnitsLabel(t.units - reserved.total, item.pack)}`;
  }
  btn.disabled = !ok;
  btn.style.opacity = ok ? '1' : '0.5';
}

function saveWsAdjust() {
  if (!wsAdjust) return;
  const { item, wh, cur, curUnits, reserved } = wsAdjust;
  const t = wsAdjustTarget();
  if (t.units < reserved.total || t.units === curUnits) return;
  const reason = document.getElementById('wsAdjReason').value.trim();
  if (!confirm(`${wh} 창고 ${item.name} (${item.color}) 재고를\n${wsUnitsLabel(curUnits, item.pack)} → ${wsUnitsLabel(t.units, item.pack)}로 조정합니다.\n재고조정 전표가 남습니다. 진행할까요?`)) return;

  const btn = document.getElementById('wsAdjSave');
  const status = document.getElementById('wsAdjStatus');
  btn.disabled = true;
  status.style.color = '#475569';
  status.textContent = '⏳ 저장 중...';
  // 상자·낱개를 입수로 정리해서 보낸다(예: 낱개 칸에 50, 입수 48 → 1상자 2개).
  const target = wsSplit(t.units, item.pack);
  callServer('adjustWarehouseStock', [{ itemId: item.itemId, warehouse: wh, expected: cur, target, reason }], {
    key: 'adjustWarehouseStock',
    timeout: 60000,
    onSuccess: res => {
      item.stocks[wh] = { box: Number(res && res.box_qty) || 0, unit: Number(res && res.unit_qty) || 0 };
      closeWsAdjustDialog();
      renderWarehouseStock();
      wsSetStatus(`✅ ${item.name} (${item.color}) ${wh} 재고 ${wsUnitsLabel(t.units, item.pack)} · 재고조정 전표 ${(res && res.invoice_no) || ''}`);
    },
    onLateSuccess: () => {
      alert('응답이 늦게 도착했지만 저장되었을 수 있습니다. 다시 누르지 말고 새로고침해서 확인하세요.');
    },
    onError: err => {
      btn.disabled = false;
      status.style.color = '#b91c1c';
      status.textContent = '저장 실패: ' + ((err && err.message) || err);
    }
  });
}

window.onWsBrandChange = onWsBrandChange;
window.openWsAdjustDialog = openWsAdjustDialog;
window.closeWsAdjustDialog = closeWsAdjustDialog;
window.onWsAdjustInput = onWsAdjustInput;
window.saveWsAdjust = saveWsAdjust;
window.openWarehouseStockModal = openWarehouseStockModal;
window.closeWarehouseStockModal = closeWarehouseStockModal;
window.loadWarehouseStock = loadWarehouseStock;
window.onWarehouseStockOptionChange = onWarehouseStockOptionChange;
window.printWarehouseStock = printWarehouseStock;
window.downloadWarehouseStockXlsx = downloadWarehouseStockXlsx;
