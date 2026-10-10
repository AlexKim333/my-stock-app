/**
 * 품목 포장수량 변경(관리자) UI 컨트롤러
 * ---------------------------------------------------------------------------
 * index.html "시스템 설정" 모달의 "📦 품목 포장수량" 탭 전용 코드다. index.html에서만
 * 로드되며 그 페이지의 인라인 전역에 의존한다:
 *   - callServer(fnName, args, opt) : supabaseAdapter 브릿지 호출
 *   - escapeHtml(v), jsArg(v)       : HTML/속성 이스케이프 헬퍼
 *   - showAppToast(msg, duration)   : 토스트 알림 (typeof로 가드)
 *   - loadStockData(force)          : 재고 캐시 새로고침 (typeof로 가드)
 *   - typeConfig                    : 화면별 장바구니/보류 저장 키 (typeof로 가드)
 *
 * 서버(rpc_change_item_pack_qty)가 모든 안전 검사를 수행한다. 이 파일은 검토 결과를 보여주고
 * 이 브라우저에 남은 장바구니/보류가 옛 포장수량을 참조하는지만 추가로 확인한다.
 * HTML 속성이 호출하는 함수만 파일 하단에서 window에 노출한다.
 */

let packItemsCache = [];
let packSelected = null;
let packPreview = null;

const PACK_BLOCKER_TEXT = {
  DUPLICATE_ITEM: '같은 품명·색상·새 포장수량의 품목이 이미 있어 변경할 수 없습니다.',
  PENDING_ORDERS: '진행 중인 보류/이동 주문(서브창고 발주 등)이 있습니다. 완료 또는 취소한 뒤 다시 시도하세요.',
  OUTBOUND_HOLDS: '이 품목이 담긴 출고 보류가 있습니다(모든 기기 공유). 보류를 제출하거나 삭제한 뒤 다시 시도하세요.',
  UNIT_QTY_PRESENT: '낱개(개) 단위 수량이 남아 있어 자동 변경할 수 없습니다. 낱개를 상자로 정리(재고조정)한 뒤 다시 시도하세요.',
  CONFIRM_REQUIRED: '아래 확인 체크박스를 선택해야 변경할 수 있습니다.'
};

const PACK_WARNING_TEXT = {
  HAS_TRANSACTIONS: '거래내역이 있습니다. 과거 입출고의 상자 수량도 새 포장수량 기준 상자로 다시 해석됩니다.',
  OLD_PACK_NOT_1: '현재 포장수량이 1이 아닙니다. 기존 상자 수량의 개수 환산값이 달라집니다.'
};

function packFmt(n) {
  return Number(n || 0).toLocaleString();
}

/** 이 브라우저의 장바구니/보류 중 해당 품목(옛 박스당수량)을 담은 곳 */
function findLocalPackConflicts(item) {
  const found = [];
  if (!item || typeof typeConfig === 'undefined') return found;
  const name = String(item.name || '').trim().toUpperCase();
  const color = String(item.color || 'SURTIDO').trim().toUpperCase();
  const pack = Number(item.pack || 1);
  const matches = r => r
    && String(r.itemName || '').trim().toUpperCase() === name
    && String(r.color || 'SURTIDO').trim().toUpperCase() === color
    && Number(r.boxContent || 1) === pack;

  Object.keys(typeConfig).forEach(type => {
    const cfg = typeConfig[type] || {};
    const label = cfg.title || type;
    try {
      if (cfg.sessionStorageKey) {
        const cart = JSON.parse(localStorage.getItem(cfg.sessionStorageKey) || '[]');
        if (Array.isArray(cart) && cart.some(matches)) found.push(`${label} 장바구니`);
      }
    } catch (e) { /* 손상된 저장값은 무시 */ }
    try {
      if (cfg.pendingStorageKey) {
        const list = JSON.parse(localStorage.getItem(cfg.pendingStorageKey) || '[]');
        if (Array.isArray(list)) {
          const n = list.filter(p => p && Array.isArray(p.records) && p.records.some(matches)).length;
          if (n > 0) found.push(`${label} 보류 ${n}건`);
        }
      }
    } catch (e) { /* 손상된 저장값은 무시 */ }
  });
  return found;
}

function searchPackItems() {
  const input = document.getElementById('packSearchInput');
  const container = document.getElementById('packItemList');
  const q = input ? input.value.trim() : '';
  if (q.length < 2) {
    alert('품명을 2글자 이상 입력하세요.');
    return;
  }
  if (container) container.innerHTML = '<div style="padding:16px; text-align:center; color:#94a3b8; font-size:8.5pt;">⏳ 검색 중...</div>';
  callServer('searchItemsForPackChange', [q], {
    key: 'packSearch',
    mode: 'latest',
    onSuccess: list => {
      packItemsCache = list || [];
      renderPackItemList();
    },
    onError: err => {
      if (container) container.innerHTML = `<div style="padding:16px; text-align:center; color:#dc2626; font-size:8.5pt;">검색 실패: ${escapeHtml(err?.message || String(err))}</div>`;
    }
  });
}

function renderPackItemList() {
  const container = document.getElementById('packItemList');
  if (!container) return;
  if (packItemsCache.length === 0) {
    container.innerHTML = '<div style="padding:16px; text-align:center; color:#94a3b8; font-size:8.5pt;">검색 결과가 없습니다.</div>';
    return;
  }
  container.innerHTML = packItemsCache.map(it => {
    const stockText = it.stocks.length
      ? it.stocks.map(s => `${escapeHtml(s.warehouse)} ${packFmt(s.box)}상자${s.unit ? ' ' + packFmt(s.unit) + '개' : ''}`).join(' · ')
      : '재고 없음';
    const selected = packSelected && packSelected.id === it.id;
    return `
      <div style="display:flex; align-items:center; justify-content:space-between; gap:10px; padding:8px 12px; border-bottom:1px solid #f1f5f9; ${selected ? 'background:#eff6ff;' : ''} ${it.isActive ? '' : 'opacity:0.55;'}">
        <div style="min-width:0;">
          <div style="font-size:9pt; font-weight:700; color:#1e293b;">${escapeHtml(it.name)} <span style="font-weight:600; color:#64748b;">(${escapeHtml(it.color)})</span>
            <span style="margin-left:6px; padding:1px 7px; background:#f1f5f9; border-radius:10px; font-size:7.8pt; color:#334155;">포장 ${packFmt(it.pack)}개</span>
            ${it.isActive ? '' : '<span style="margin-left:4px; font-size:7.5pt; color:#dc2626;">● 비활성</span>'}
          </div>
          <div style="font-size:7.8pt; color:#64748b; margin-top:2px;">${stockText}</div>
        </div>
        <button type="button" onclick="selectPackItem(${jsArg(it.id)})" style="padding:4px 12px; background:#2563eb; color:#fff; border:none; border-radius:5px; cursor:pointer; font-size:7.8pt; font-weight:700; flex-shrink:0;">선택</button>
      </div>`;
  }).join('');
}

function selectPackItem(id) {
  const item = packItemsCache.find(i => i.id === id);
  if (!item) return;
  packSelected = item;
  packPreview = null;
  const form = document.getElementById('packChangeForm');
  if (form) form.style.display = 'block';
  const label = document.getElementById('packSelectedLabel');
  if (label) label.textContent = `${item.name} (${item.color}) — 현재 포장수량 ${packFmt(item.pack)}개`;
  const inp = document.getElementById('packNewValue');
  if (inp) { inp.value = ''; inp.focus(); }
  const reason = document.getElementById('packReason');
  if (reason) reason.value = '';
  resetPackPreview();
  renderPackItemList();
}

function resetPackPreview() {
  packPreview = null;
  const report = document.getElementById('packReport');
  if (report) report.innerHTML = '';
  const confirmRow = document.getElementById('packConfirmRow');
  if (confirmRow) confirmRow.style.display = 'none';
  const chk = document.getElementById('packConfirmBoxes');
  if (chk) chk.checked = false;
  const applyBtn = document.getElementById('packApplyBtn');
  if (applyBtn) applyBtn.disabled = true;
}

function readPackNewValue() {
  const inp = document.getElementById('packNewValue');
  const v = inp ? Number(inp.value) : NaN;
  if (!Number.isInteger(v) || v < 1 || v > 100000) {
    alert('새 포장수량은 1 이상의 정수로 입력하세요.');
    return null;
  }
  return v;
}

function previewPackChange() {
  if (!packSelected) { alert('먼저 품목을 선택하세요.'); return; }
  const newPack = readPackNewValue();
  if (newPack === null) return;
  if (newPack === packSelected.pack) { alert('현재 포장수량과 같습니다.'); return; }

  const btn = document.getElementById('packPreviewBtn');
  if (btn) { btn.disabled = true; btn.textContent = '검토 중...'; }
  resetPackPreview();

  callServer('changeItemPackQty', [{ itemId: packSelected.id, newPack, apply: false }], {
    key: 'packPreview',
    mode: 'latest',
    onSuccess: res => {
      packPreview = { res, newPack };
      renderPackReport();
    },
    onError: err => alert('검토 실패: ' + (err?.message || String(err))),
    onSettled: () => {
      if (btn) { btn.disabled = false; btn.textContent = '🔍 영향 검토'; }
    }
  });
}

function renderPackReport() {
  const report = document.getElementById('packReport');
  if (!report || !packPreview) return;
  const { res, newPack } = packPreview;
  const item = packSelected;
  const blockers = (res.blockers || []).filter(b => b !== 'CONFIRM_REQUIRED').map(b => PACK_BLOCKER_TEXT[b] || b);
  const warnings = (res.warnings || []).map(w => PACK_WARNING_TEXT[w] || w);
  const local = findLocalPackConflicts(item);
  if (local.length > 0) {
    blockers.push(`이 브라우저에 옛 박스당수량(${packFmt(item.pack)})으로 담긴 항목이 있습니다: ${local.join(', ')}. 먼저 제출하거나 삭제한 뒤 다시 검토하세요.`);
  }
  const imp = res.impact || {};
  const canApply = blockers.length === 0;

  report.innerHTML = `
    <div style="border:1px solid ${canApply ? '#bbf7d0' : '#fecaca'}; background:${canApply ? '#f0fdf4' : '#fef2f2'}; border-radius:8px; padding:10px 12px; margin-top:10px;">
      <div style="font-size:9pt; font-weight:800; color:${canApply ? '#166534' : '#b91c1c'}; margin-bottom:6px;">
        ${canApply ? '✅ 변경 가능' : '⛔ 변경할 수 없습니다'} — 포장수량 ${packFmt(item.pack)} → ${packFmt(newPack)}
      </div>
      <div style="font-size:8.2pt; color:#334155; line-height:1.6;">
        재고 행 ${packFmt(imp.stockRows)}개 · 거래내역 ${packFmt(imp.txCount)}건 · 진행 중 보류 ${packFmt(imp.pendingActive)}건<br>
        총 재고 개수: <b>${packFmt(imp.unitsBefore)}개</b> → <b>${packFmt(imp.unitsAfter)}개</b>
        <span style="color:#64748b;">(상자 수량은 그대로, 상자 1개당 개수가 ${packFmt(newPack)}개로 재해석됩니다)</span>
      </div>
      ${blockers.length ? `<ul style="margin:8px 0 0 0; padding-left:18px; font-size:8.2pt; color:#b91c1c;">${blockers.map(b => `<li>${escapeHtml(b)}</li>`).join('')}</ul>` : ''}
      ${warnings.length ? `<ul style="margin:8px 0 0 0; padding-left:18px; font-size:8.2pt; color:#b45309;">${warnings.map(w => `<li>${escapeHtml(w)}</li>`).join('')}</ul>` : ''}
    </div>`;

  const confirmRow = document.getElementById('packConfirmRow');
  if (confirmRow) confirmRow.style.display = (canApply && imp.needsConfirm) ? 'flex' : 'none';
  const applyBtn = document.getElementById('packApplyBtn');
  if (applyBtn) applyBtn.disabled = !canApply;
}

function applyPackChange() {
  if (!packSelected || !packPreview) { alert('먼저 [영향 검토]를 실행하세요.'); return; }
  const newPack = readPackNewValue();
  if (newPack === null) return;
  if (newPack !== packPreview.newPack) { alert('입력값이 바뀌었습니다. 다시 [영향 검토]를 실행하세요.'); return; }

  const imp = packPreview.res.impact || {};
  const chk = document.getElementById('packConfirmBoxes');
  if (imp.needsConfirm && !(chk && chk.checked)) {
    alert('확인 체크박스를 선택해야 변경할 수 있습니다.');
    return;
  }
  const item = packSelected;
  const local = findLocalPackConflicts(item);
  if (local.length > 0) { renderPackReport(); alert('이 브라우저에 옛 박스당수량으로 담긴 항목이 있어 변경할 수 없습니다.'); return; }

  if (!confirm(
    `⚠️ 프로덕션 데이터를 변경합니다.\n\n` +
    `품목: ${item.name} (${item.color})\n` +
    `포장수량: ${packFmt(item.pack)}개 → ${packFmt(newPack)}개\n` +
    `총 재고 개수: ${packFmt(imp.unitsBefore)}개 → ${packFmt(imp.unitsAfter)}개\n\n` +
    `변경 후에는 다른 PC의 화면을 새로고침해야 하며, 옛 박스당수량으로 담긴 장바구니/보류는 제출할 수 없습니다.\n` +
    `계속하시겠습니까?`
  )) return;

  const reason = (document.getElementById('packReason')?.value || '').trim();
  const btn = document.getElementById('packApplyBtn');
  if (btn) { btn.disabled = true; btn.textContent = '변경 중...'; }

  callServer('changeItemPackQty', [{
    itemId: item.id, newPack, apply: true, confirmBoxes: !!(chk && chk.checked), reason
  }], {
    key: 'packApply',
    onSuccess: res => {
      if (res && res.applied) {
        if (typeof showAppToast === 'function') showAppToast(`✅ ${item.name} 포장수량이 ${packFmt(newPack)}개로 변경되었습니다.`, 3500);
        if (typeof loadStockData === 'function') loadStockData(true);
        packSelected = null;
        const form = document.getElementById('packChangeForm');
        if (form) form.style.display = 'none';
        resetPackPreview();
        searchPackItems();
        loadPackChangeHistory();
      } else {
        packPreview = { res: res || {}, newPack };
        renderPackReport();
        alert('변경되지 않았습니다. 화면의 차단 사유를 확인하세요.');
      }
    },
    onError: err => alert('변경 실패: ' + (err?.message || String(err))),
    onSettled: () => {
      if (btn) { btn.textContent = '✅ 변경 적용'; btn.disabled = !packPreview; }
    }
  });
}

function loadPackChangeHistory() {
  const container = document.getElementById('packHistoryList');
  if (!container) return;
  callServer('listItemPackChanges', [20], {
    key: 'packHistory',
    mode: 'latest',
    onSuccess: list => {
      const rows = list || [];
      if (rows.length === 0) {
        container.innerHTML = '<div style="padding:14px; text-align:center; color:#94a3b8; font-size:8.3pt;">변경 이력이 없습니다.</div>';
        return;
      }
      container.innerHTML = rows.map(r => `
        <div style="display:flex; justify-content:space-between; gap:8px; padding:7px 12px; border-bottom:1px solid #f1f5f9; font-size:8.2pt;">
          <span style="font-weight:700; color:#1e293b;">${escapeHtml(r.item_name)} <span style="font-weight:600; color:#64748b;">(${escapeHtml(r.color)})</span>
            <span style="margin-left:6px; color:#334155;">${escapeHtml(r.old_value)} → ${escapeHtml(r.new_value)}</span></span>
          <span style="color:#64748b; white-space:nowrap;">${escapeHtml(r.changed_by || '-')} · ${escapeHtml(new Date(r.created_at).toLocaleString())}${r.reason ? ' · ' + escapeHtml(r.reason) : ''}</span>
        </div>`).join('');
    },
    onError: err => {
      container.innerHTML = `<div style="padding:14px; text-align:center; color:#dc2626; font-size:8.3pt;">이력을 불러오지 못했습니다: ${escapeHtml(err?.message || String(err))}</div>`;
    }
  });
}

/* HTML onclick/onchange가 호출하는 함수만 전역에 노출 */
window.searchPackItems = searchPackItems;
window.selectPackItem = selectPackItem;
window.previewPackChange = previewPackChange;
window.applyPackChange = applyPackChange;
window.loadPackChangeHistory = loadPackChangeHistory;
window.resetPackPreview = resetPackPreview;
