/**
 * 상품관리(관리자) UI 컨트롤러 — 오래된/단종/중복 등록 품목을 "숨김" 처리해 검색 대상에서 제외
 * ---------------------------------------------------------------------------
 * index.html 왼쪽 메뉴의 "🗂️ 상품관리" 모달 전용 코드다. index.html에서만 로드되며
 * 그 페이지의 인라인 전역에 의존한다:
 *   - callServer(fnName, args, opt) : supabaseAdapter 브릿지 호출
 *   - escapeHtml(v), jsArg(v)       : HTML/속성 이스케이프 헬퍼
 *   - showAppToast(msg, duration)   : 토스트 알림 (typeof로 가드)
 *   - loadStockData(force)          : 재고 캐시·검색 색인 새로고침 (typeof로 가드)
 *   - openProductLedgerModal(name)  : 수불원장 열기 (typeof로 가드)
 *
 * 숨김 = items.is_active=false. 서버(rpc_set_items_active)가 재고·진행 중 발주·출고 보류를 검사해
 * 막힌 품목은 건너뛴다. 이 파일은 같은 조건을 미리 보여 주고(체크 불가), 결과를 알린다.
 * HTML 속성이 호출하는 함수만 파일 하단에서 window에 노출한다.
 */

const CATALOG_STALE_DAYS = 180;
const CATALOG_BLOCKER_TEXT = {
  STOCK_REMAINING: '재고 남음',
  PENDING_ORDERS: '진행 중 이동/발주',
  OUTBOUND_HOLDS: '출고 보류에 담김'
};

let catalogItems = [];
let catalogSelected = new Set();
let catalogDupKeys = new Map(); // dupKey -> 같은 키 품목 수
let catalogVisibleIds = [];

function catalogFmt(n) {
  return Number(n || 0).toLocaleString();
}

/** 표기 차이(하이픈·공백·점 등)를 무시한 품명 키 — 중복 등록 의심 판별용 */
function catalogNormName(name) {
  return String(name || '').toUpperCase().replace(/[^A-Z0-9가-힣]/g, '');
}

function catalogDupKey(it) {
  return `${catalogNormName(it.name)}|${catalogNormName(it.color || 'SURTIDO')}`;
}

function catalogBlockers(it) {
  const b = [];
  if (it.stocks.length > 0) b.push('STOCK_REMAINING');
  if (it.pendingActive > 0) b.push('PENDING_ORDERS');
  if (it.holdCount > 0) b.push('OUTBOUND_HOLDS');
  return b;
}

function catalogDaysSince(iso) {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return null;
  return Math.floor((Date.now() - t) / 86400000);
}

function catalogDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return '';
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function openItemCatalogModal() {
  const modal = document.getElementById('itemCatalogModal');
  if (!modal) return;
  modal.style.display = 'flex';
  loadItemCatalog();
  loadItemVisibilityHistory();
  const input = document.getElementById('catalogSearchInput');
  if (input) setTimeout(() => input.focus(), 50);
}

function closeItemCatalogModal() {
  const modal = document.getElementById('itemCatalogModal');
  if (modal) modal.style.display = 'none';
}

function loadItemCatalog() {
  const body = document.getElementById('catalogTableBody');
  if (body && catalogItems.length === 0) {
    body.innerHTML = '<tr><td colspan="9" style="padding:24px; text-align:center; color:#94a3b8;">⏳ 상품 목록을 불러오는 중...</td></tr>';
  }
  callServer('listItemCatalog', [], {
    key: 'itemCatalogLoad',
    mode: 'latest',
    timeout: 60000,
    onSuccess: list => {
      catalogItems = list || [];
      catalogDupKeys = new Map();
      catalogItems.forEach(it => {
        const k = catalogDupKey(it);
        catalogDupKeys.set(k, (catalogDupKeys.get(k) || 0) + 1);
      });
      const known = new Set(catalogItems.map(it => it.id));
      catalogSelected = new Set([...catalogSelected].filter(id => known.has(id)));
      renderItemCatalog();
    },
    onError: err => {
      if (body) body.innerHTML = `<tr><td colspan="9" style="padding:24px; text-align:center; color:#dc2626;">불러오기 실패: ${escapeHtml(err?.message || String(err))}</td></tr>`;
    }
  });
}

function readCatalogFilters() {
  const val = id => (document.getElementById(id)?.value || '');
  return {
    q: catalogNormName(val('catalogSearchInput')),
    status: val('catalogStatusFilter') || 'active',
    view: val('catalogViewFilter') || 'all',
    sort: val('catalogSortSelect') || 'name'
  };
}

function filterCatalogItems() {
  const f = readCatalogFilters();
  let list = catalogItems.filter(it => {
    if (f.status === 'active' && !it.active) return false;
    if (f.status === 'hidden' && it.active) return false;
    if (f.q && !catalogNormName(`${it.name} ${it.color}`).includes(f.q)) return false;
    if (f.view === 'hideable') return it.active && catalogBlockers(it).length === 0;
    if (f.view === 'dup') return (catalogDupKeys.get(catalogDupKey(it)) || 0) > 1;
    if (f.view === 'notx') return it.txCount === 0;
    if (f.view === 'stale') {
      const d = catalogDaysSince(it.lastTxAt);
      return d === null || d >= CATALOG_STALE_DAYS;
    }
    return true;
  });

  const byName = (a, b) => a.name.localeCompare(b.name) || a.color.localeCompare(b.color) || a.pack - b.pack;
  if (f.view === 'dup') {
    // 같은 그룹이 붙어 보이도록 정규화 키로 정렬
    list.sort((a, b) => catalogDupKey(a).localeCompare(catalogDupKey(b)) || byName(a, b));
  } else if (f.sort === 'lastTx') {
    // 오래 거래가 없는 것부터 (거래 없음이 맨 앞)
    list.sort((a, b) => (a.lastTxAt ? new Date(a.lastTxAt).getTime() : 0) - (b.lastTxAt ? new Date(b.lastTxAt).getTime() : 0) || byName(a, b));
  } else if (f.sort === 'created') {
    list.sort((a, b) => new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime() || byName(a, b));
  } else {
    list.sort(byName);
  }
  return list;
}

function renderItemCatalog() {
  const body = document.getElementById('catalogTableBody');
  if (!body) return;
  const list = filterCatalogItems();
  catalogVisibleIds = list.filter(isCatalogSelectable).map(it => it.id);

  const activeCount = catalogItems.filter(it => it.active).length;
  const summary = document.getElementById('catalogSummary');
  if (summary) {
    const dupItems = catalogItems.filter(it => (catalogDupKeys.get(catalogDupKey(it)) || 0) > 1).length;
    summary.innerHTML =
      `전체 <b>${catalogFmt(catalogItems.length)}</b> · 활성 <b>${catalogFmt(activeCount)}</b> · ` +
      `숨김 <b style="color:#b91c1c;">${catalogFmt(catalogItems.length - activeCount)}</b> · ` +
      `중복 의심 <b style="color:#b45309;">${catalogFmt(dupItems)}</b> · 표시 <b>${catalogFmt(list.length)}</b>`;
  }

  if (list.length === 0) {
    body.innerHTML = '<tr><td colspan="9" style="padding:24px; text-align:center; color:#94a3b8;">조건에 맞는 상품이 없습니다.</td></tr>';
  } else {
    body.innerHTML = list.map(renderCatalogRow).join('');
  }
  updateCatalogActionBar();
}

function isCatalogSelectable(it) {
  return !it.active || catalogBlockers(it).length === 0;
}

function renderCatalogRow(it) {
  const blockers = it.active ? catalogBlockers(it) : [];
  const selectable = isCatalogSelectable(it);
  const checked = catalogSelected.has(it.id);
  const dupN = catalogDupKeys.get(catalogDupKey(it)) || 0;
  const days = catalogDaysSince(it.lastTxAt);

  const stockText = it.stocks.length
    ? it.stocks.map(s => `${escapeHtml(s.warehouse)} ${catalogFmt(s.box)}${s.unit ? '+' + catalogFmt(s.unit) + '개' : ''}`).join(' · ')
    : '<span style="color:#94a3b8;">0</span>';
  const lastTx = it.lastTxAt
    ? `${escapeHtml(catalogDate(it.lastTxAt))}<div style="font-size:7.3pt; color:${days >= CATALOG_STALE_DAYS ? '#b45309' : '#94a3b8'};">${catalogFmt(days)}일 전</div>`
    : '<span style="color:#94a3b8;">거래 없음</span>';

  const badges = [];
  if (!it.active) badges.push('<span class="catalog-badge" style="background:#fee2e2; color:#b91c1c;">숨김</span>');
  if (dupN > 1) badges.push(`<span class="catalog-badge" style="background:#fef3c7; color:#92400e;" title="표기만 다른 같은 품명·색상이 ${dupN}개 있습니다">중복의심 ${dupN}</span>`);
  blockers.forEach(b => badges.push(`<span class="catalog-badge" style="background:#f1f5f9; color:#475569;">${escapeHtml(CATALOG_BLOCKER_TEXT[b] || b)}</span>`));

  const ledgerBtn = `<button type="button" onclick="openCatalogLedger(${jsArg(it.name)})" title="수불원장 보기" style="border:none; background:none; cursor:pointer; padding:0 2px; font-size:9pt;">📜</button>`;

  return `
    <tr style="${checked ? 'background:#eff6ff;' : ''} ${it.active ? '' : 'color:#94a3b8;'}">
      <td style="text-align:center;">
        <input type="checkbox" ${checked ? 'checked' : ''} ${selectable ? '' : 'disabled title="재고·진행 중 발주·출고 보류를 먼저 정리해야 숨길 수 있습니다"'}
          onchange="toggleCatalogItem(${jsArg(it.id)}, this.checked)" style="cursor:${selectable ? 'pointer' : 'not-allowed'};">
      </td>
      <td style="font-weight:700; color:${it.active ? '#1e293b' : '#94a3b8'};">${escapeHtml(it.name)} ${ledgerBtn}</td>
      <td>${escapeHtml(it.color)}</td>
      <td style="text-align:right;">${catalogFmt(it.pack)}</td>
      <td style="text-align:right;">${catalogFmt(it.mainBox)}${it.mainUnit ? '<span style="color:#64748b;">+' + catalogFmt(it.mainUnit) + '개</span>' : ''}</td>
      <td style="font-size:7.8pt;">${stockText}</td>
      <td style="text-align:right;">${catalogFmt(it.txCount)}</td>
      <td style="font-size:7.8pt; white-space:nowrap;">${lastTx}</td>
      <td>${badges.join(' ')}</td>
    </tr>`;
}

function toggleCatalogItem(id, on) {
  if (on) catalogSelected.add(id);
  else catalogSelected.delete(id);
  renderItemCatalog();
}

function toggleCatalogSelectAll(on) {
  catalogVisibleIds.forEach(id => {
    if (on) catalogSelected.add(id);
    else catalogSelected.delete(id);
  });
  renderItemCatalog();
}

function clearCatalogSelection() {
  catalogSelected = new Set();
  renderItemCatalog();
}

function selectedCatalogItems() {
  return catalogItems.filter(it => catalogSelected.has(it.id));
}

function updateCatalogActionBar() {
  const sel = selectedCatalogItems();
  const toHide = sel.filter(it => it.active);
  const toShow = sel.filter(it => !it.active);
  const label = document.getElementById('catalogSelectedCount');
  if (label) {
    label.textContent = sel.length
      ? `선택 ${catalogFmt(sel.length)}개 (활성 ${catalogFmt(toHide.length)} · 숨김 ${catalogFmt(toShow.length)})`
      : '선택한 상품 없음';
  }
  const hideBtn = document.getElementById('catalogHideBtn');
  if (hideBtn) hideBtn.disabled = toHide.length === 0;
  const showBtn = document.getElementById('catalogShowBtn');
  if (showBtn) showBtn.disabled = toShow.length === 0;
  const all = document.getElementById('catalogSelectAll');
  if (all) {
    const n = catalogVisibleIds.filter(id => catalogSelected.has(id)).length;
    all.checked = catalogVisibleIds.length > 0 && n === catalogVisibleIds.length;
    all.indeterminate = n > 0 && n < catalogVisibleIds.length;
  }
}

function applyCatalogVisibility(active) {
  const targets = selectedCatalogItems().filter(it => it.active !== active);
  if (targets.length === 0) return;
  const reason = (document.getElementById('catalogReason')?.value || '').trim();
  const preview = targets.slice(0, 12).map(it => `  · ${it.name} (${it.color}, ${it.pack}개입)`).join('\n')
    + (targets.length > 12 ? `\n  … 외 ${targets.length - 12}개` : '');

  const msg = active
    ? `숨김 상품 ${targets.length}개를 다시 활성화합니다.\n검색·재고 목록에 다시 나타나고 입출고할 수 있게 됩니다.\n\n${preview}\n\n계속하시겠습니까?`
    : `⚠️ 상품 ${targets.length}개를 숨깁니다(검색 대상에서 제외).\n` +
      `숨긴 상품은 검색·재고 목록·주문서에서 빠지고 입출고·발주가 차단됩니다.\n` +
      `과거 전표와 수불원장은 그대로 남고, 언제든 다시 활성화할 수 있습니다.\n\n${preview}\n\n계속하시겠습니까?`;
  if (!confirm(msg)) return;

  const btn = document.getElementById(active ? 'catalogShowBtn' : 'catalogHideBtn');
  const oldText = btn ? btn.textContent : '';
  if (btn) { btn.disabled = true; btn.textContent = '처리 중...'; }

  callServer('setItemsActive', [{ itemIds: targets.map(it => it.id), active, reason }], {
    key: 'itemCatalogApply',
    timeout: 60000,
    onSuccess: res => {
      const changed = (res && res.changed) || [];
      const skipped = (res && res.skipped) || [];
      changed.forEach(c => catalogSelected.delete(c.id));
      if (changed.length && typeof showAppToast === 'function') {
        showAppToast(`✅ ${changed.length}개 상품을 ${active ? '다시 활성화' : '숨김 처리'}했습니다.`, 3500);
      }
      if (skipped.length) {
        alert(
          `${skipped.length}개는 처리하지 못했습니다(다른 사용자가 방금 재고를 바꿨을 수 있습니다):\n\n` +
          skipped.slice(0, 15).map(s => `· ${s.name} (${s.color}) — ${(s.blockers || []).map(b => CATALOG_BLOCKER_TEXT[b] || b).join(', ')}`).join('\n') +
          (skipped.length > 15 ? `\n… 외 ${skipped.length - 15}개` : '')
        );
      }
      const reasonEl = document.getElementById('catalogReason');
      if (reasonEl && changed.length) reasonEl.value = '';
      if (changed.length && typeof loadStockData === 'function') loadStockData(true);
      loadItemCatalog();
      loadItemVisibilityHistory();
    },
    onError: err => alert('처리 실패: ' + (err?.message || String(err))),
    onSettled: () => {
      if (btn) btn.textContent = oldText;
      updateCatalogActionBar();
    }
  });
}

function hideSelectedCatalogItems() {
  applyCatalogVisibility(false);
}

function restoreSelectedCatalogItems() {
  applyCatalogVisibility(true);
}

function openCatalogLedger(name) {
  if (typeof openProductLedgerModal === 'function') openProductLedgerModal(name);
}

function loadItemVisibilityHistory() {
  const container = document.getElementById('catalogHistoryList');
  if (!container) return;
  callServer('listItemVisibilityChanges', [30], {
    key: 'itemCatalogHistory',
    mode: 'latest',
    onSuccess: list => {
      const rows = list || [];
      if (rows.length === 0) {
        container.innerHTML = '<div style="padding:12px; text-align:center; color:#94a3b8; font-size:8.2pt;">숨김/복구 이력이 없습니다.</div>';
        return;
      }
      container.innerHTML = rows.map(r => {
        const hidden = String(r.new_value) === 'false';
        return `
        <div style="display:flex; justify-content:space-between; gap:8px; padding:6px 12px; border-bottom:1px solid #f1f5f9; font-size:8pt;">
          <span><b style="color:${hidden ? '#b91c1c' : '#15803d'};">${hidden ? '숨김' : '복구'}</b>
            <span style="font-weight:700; color:#1e293b; margin-left:4px;">${escapeHtml(r.item_name)}</span>
            <span style="color:#64748b;">(${escapeHtml(r.color)})</span></span>
          <span style="color:#64748b; white-space:nowrap;">${escapeHtml(r.changed_by || '-')} · ${escapeHtml(new Date(r.created_at).toLocaleString())}${r.reason ? ' · ' + escapeHtml(r.reason) : ''}</span>
        </div>`;
      }).join('');
    },
    onError: err => {
      container.innerHTML = `<div style="padding:12px; text-align:center; color:#dc2626; font-size:8.2pt;">이력을 불러오지 못했습니다: ${escapeHtml(err?.message || String(err))}</div>`;
    }
  });
}

let catalogSearchTimer = null;
function onCatalogSearchInput() {
  clearTimeout(catalogSearchTimer);
  catalogSearchTimer = setTimeout(renderItemCatalog, 120);
}

/* HTML onclick/onchange가 호출하는 함수만 전역에 노출 */
window.openItemCatalogModal = openItemCatalogModal;
window.closeItemCatalogModal = closeItemCatalogModal;
window.loadItemCatalog = loadItemCatalog;
window.renderItemCatalog = renderItemCatalog;
window.onCatalogSearchInput = onCatalogSearchInput;
window.toggleCatalogItem = toggleCatalogItem;
window.toggleCatalogSelectAll = toggleCatalogSelectAll;
window.clearCatalogSelection = clearCatalogSelection;
window.hideSelectedCatalogItems = hideSelectedCatalogItems;
window.restoreSelectedCatalogItems = restoreSelectedCatalogItems;
window.openCatalogLedger = openCatalogLedger;
