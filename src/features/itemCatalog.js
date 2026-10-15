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
 *   - createManufacturerInteractive(onCreated) : 새 제조사 추가 (typeof로 가드)
 *
 * 숨김 = items.is_active=false. 서버(rpc_set_items_active)가 재고·진행 중 발주·출고 보류를 검사해
 * 막힌 품목은 건너뛴다. 이 파일은 같은 조건을 미리 보여 주고(체크 불가), 결과를 알린다.
 * 제조사(items.brand_id)도 여기서 여러 품목을 골라 한 번에 지정한다(rpc_set_items_brand).
 * 제조사 지정은 재고와 무관하므로 모든 품목을 선택할 수 있고, 숨김만 차단 사유가 없는 품목에 적용된다.
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
let catalogBrands = []; // [{ id, name }]
const CATALOG_COLS = 10;

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
  loadCatalogBrands();
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
    body.innerHTML = `<tr><td colspan="${CATALOG_COLS}" style="padding:24px; text-align:center; color:#94a3b8;">⏳ 상품 목록을 불러오는 중...</td></tr>`;
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
      if (body) body.innerHTML = `<tr><td colspan="${CATALOG_COLS}" style="padding:24px; text-align:center; color:#dc2626;">불러오기 실패: ${escapeHtml(err?.message || String(err))}</td></tr>`;
    }
  });
}

function readCatalogFilters() {
  const val = id => (document.getElementById(id)?.value || '');
  return {
    q: catalogNormName(val('catalogSearchInput')),
    status: val('catalogStatusFilter') || 'active',
    view: val('catalogViewFilter') || 'all',
    brand: val('catalogBrandFilter'),
    sort: val('catalogSortSelect') || 'name'
  };
}

function filterCatalogItems() {
  const f = readCatalogFilters();
  let list = catalogItems.filter(it => {
    if (f.status === 'active' && !it.active) return false;
    if (f.status === 'hidden' && it.active) return false;
    if (f.q && !catalogNormName(`${it.name} ${it.color}`).includes(f.q)) return false;
    if (f.brand === '__none__' && it.brandId) return false;
    if (f.brand && f.brand !== '__none__' && it.brandId !== f.brand) return false;
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
  catalogVisibleIds = list.map(it => it.id);

  const activeCount = catalogItems.filter(it => it.active).length;
  const summary = document.getElementById('catalogSummary');
  if (summary) {
    const dupItems = catalogItems.filter(it => (catalogDupKeys.get(catalogDupKey(it)) || 0) > 1).length;
    const noBrand = catalogItems.filter(it => it.active && !it.brandId).length;
    summary.innerHTML =
      `전체 <b>${catalogFmt(catalogItems.length)}</b> · 활성 <b>${catalogFmt(activeCount)}</b> · ` +
      `숨김 <b style="color:#b91c1c;">${catalogFmt(catalogItems.length - activeCount)}</b> · ` +
      `중복 의심 <b style="color:#b45309;">${catalogFmt(dupItems)}</b> · ` +
      `제조사 미지정(활성) <b style="color:#7c3aed;">${catalogFmt(noBrand)}</b> · 표시 <b>${catalogFmt(list.length)}</b>`;
  }

  if (list.length === 0) {
    body.innerHTML = `<tr><td colspan="${CATALOG_COLS}" style="padding:24px; text-align:center; color:#94a3b8;">조건에 맞는 상품이 없습니다.</td></tr>`;
  } else {
    body.innerHTML = list.map(renderCatalogRow).join('');
  }
  updateCatalogActionBar();
}

/** 숨김 버튼의 대상이 될 수 있는지 — 활성이고 재고·진행 중 발주·보류가 없을 때만 */
function isCatalogHideable(it) {
  return it.active && catalogBlockers(it).length === 0;
}

function renderCatalogRow(it) {
  const blockers = it.active ? catalogBlockers(it) : [];
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
        <input type="checkbox" ${checked ? 'checked' : ''}
          onchange="toggleCatalogItem(${jsArg(it.id)}, this.checked)" style="cursor:pointer;">
      </td>
      <td style="font-weight:700; color:${it.active ? '#1e293b' : '#94a3b8'};">${escapeHtml(it.name)} ${ledgerBtn}</td>
      <td>${escapeHtml(it.color)}</td>
      <td>${it.brand ? escapeHtml(it.brand) : '<span style="color:#a78bfa;">(미지정)</span>'}</td>
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
  const active = sel.filter(it => it.active);
  const toHide = active.filter(isCatalogHideable);
  const toShow = sel.filter(it => !it.active);
  const label = document.getElementById('catalogSelectedCount');
  if (label) {
    label.textContent = sel.length
      ? `선택 ${catalogFmt(sel.length)}개 (활성 ${catalogFmt(active.length)}, 그중 숨김 가능 ${catalogFmt(toHide.length)} · 숨김 ${catalogFmt(toShow.length)})`
      : '선택한 상품 없음';
  }
  const brandBtn = document.getElementById('catalogBrandBtn');
  if (brandBtn) brandBtn.disabled = sel.length === 0 || !document.getElementById('catalogBrandSelect')?.value;
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
  const candidates = selectedCatalogItems().filter(it => it.active !== active);
  // 숨김은 재고·진행 중 발주·보류가 없는 품목만. 나머지는 선택돼 있어도 건너뛴다(서버도 다시 검사).
  const targets = active ? candidates : candidates.filter(isCatalogHideable);
  const blockedN = candidates.length - targets.length;
  if (targets.length === 0) return;
  const reason = (document.getElementById('catalogReason')?.value || '').trim();
  const preview = targets.slice(0, 12).map(it => `  · ${it.name} (${it.color}, ${it.pack}개입)`).join('\n')
    + (targets.length > 12 ? `\n  … 외 ${targets.length - 12}개` : '');

  const msg = active
    ? `숨김 상품 ${targets.length}개를 다시 활성화합니다.\n검색·재고 목록에 다시 나타나고 입출고할 수 있게 됩니다.\n\n${preview}\n\n계속하시겠습니까?`
    : `⚠️ 상품 ${targets.length}개를 숨깁니다(검색 대상에서 제외).\n` +
      `숨긴 상품은 검색·재고 목록·주문서에서 빠지고 입출고·발주가 차단됩니다.\n` +
      `과거 전표와 수불원장은 그대로 남고, 언제든 다시 활성화할 수 있습니다.\n` +
      (blockedN ? `(재고·진행 중 발주·보류가 있는 ${blockedN}개는 숨기지 않고 건너뜁니다.)\n` : '') +
      `\n${preview}\n\n계속하시겠습니까?`;
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

function loadCatalogBrands(selectId) {
  callServer('listBrands', [], {
    key: 'itemCatalogBrands',
    mode: 'latest',
    onSuccess: list => {
      catalogBrands = list || [];
      const opts = catalogBrands.map(b => `<option value="${escapeHtml(b.id)}">${escapeHtml(b.name)}</option>`).join('');
      const filter = document.getElementById('catalogBrandFilter');
      if (filter) {
        const cur = filter.value;
        filter.innerHTML = '<option value="">모든 제조사</option><option value="__none__">제조사 미지정만</option>' + opts;
        filter.value = [...filter.options].some(o => o.value === cur) ? cur : '';
      }
      const pick = document.getElementById('catalogBrandSelect');
      if (pick) {
        const cur = selectId || pick.value;
        pick.innerHTML = '<option value="">제조사 선택…</option>' + opts + '<option value="__none__">(미지정으로 되돌리기)</option>';
        pick.value = [...pick.options].some(o => o.value === cur) ? cur : '';
      }
      updateCatalogActionBar();
    },
    onError: err => {
      if (typeof showAppToast === 'function') showAppToast('제조사 목록을 불러오지 못했습니다: ' + (err?.message || String(err)), 4000);
    }
  });
}

/** "➕ 새 제조사": 추가 후 목록을 다시 불러와 지정할 제조사로 바로 선택해 둔다. */
function createCatalogBrand() {
  if (typeof createManufacturerInteractive !== 'function') return;
  createManufacturerInteractive(brand => loadCatalogBrands(brand.id));
}

function applyCatalogBrand() {
  const value = document.getElementById('catalogBrandSelect')?.value || '';
  if (!value) return;
  const brandId = value === '__none__' ? null : value;
  const brandName = brandId ? (catalogBrands.find(b => b.id === brandId)?.name || '') : '(미지정)';
  const targets = selectedCatalogItems().filter(it => (it.brandId || null) !== brandId);
  if (targets.length === 0) {
    alert(`선택한 상품이 이미 모두 ${brandName}입니다.`);
    return;
  }
  const preview = targets.slice(0, 12).map(it => `  · ${it.name} (${it.color}) ${it.brand || '(미지정)'} → ${brandName}`).join('\n')
    + (targets.length > 12 ? `\n  … 외 ${targets.length - 12}개` : '');
  if (!confirm(`상품 ${targets.length}개의 제조사를 "${brandName}"(으)로 지정합니다.\n\n${preview}\n\n계속하시겠습니까?`)) return;

  const btn = document.getElementById('catalogBrandBtn');
  const oldText = btn ? btn.textContent : '';
  if (btn) { btn.disabled = true; btn.textContent = '처리 중...'; }

  callServer('setItemsBrand', [{ itemIds: targets.map(it => it.id), brandId }], {
    key: 'itemCatalogBrandApply',
    timeout: 60000,
    onSuccess: res => {
      if (typeof showAppToast === 'function') {
        showAppToast(`✅ ${Number(res?.changed || 0)}개 상품의 제조사를 ${brandName}(으)로 지정했습니다.`, 3500);
      }
      // 지정한 품목은 선택에서 빼서, 이어서 다른 제조사 품목을 고르기 쉽게 한다.
      targets.forEach(it => catalogSelected.delete(it.id));
      loadItemCatalog();
    },
    onError: err => alert('제조사 지정 실패: ' + (err?.message || String(err))),
    onSettled: () => {
      if (btn) btn.textContent = oldText;
      updateCatalogActionBar();
    }
  });
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
window.applyCatalogBrand = applyCatalogBrand;
window.createCatalogBrand = createCatalogBrand;
window.updateCatalogActionBar = updateCatalogActionBar;
