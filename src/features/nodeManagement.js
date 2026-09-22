/**
 * 노드 관리(거래처 / 서브창고 / 작업자) UI 컨트롤러
 * ---------------------------------------------------------------------------
 * index.html의 "시스템 설정" 모달 안 "서브창고 & 거래처" / "작업자 관리" 탭
 * 전용 코드다. index.html에서만 로드되며(searchmodify.html/product-ledger.html
 * 에는 없음), 그 페이지의 인라인 전역에 의존한다:
 *   - callServer(fnName, args, opt) : supabaseAdapter 브릿지 호출
 *   - escapeHtml(v), jsArg(v)       : HTML/속성 이스케이프 헬퍼
 *   - showAppToast(msg, duration)   : 토스트 알림 (선택적, typeof로 가드)
 *   - currentType, loadDropdowns()  : 입/출고 화면의 거래처 드롭다운 캐시 갱신용
 *   - partnersMasterCache/Map, inLocationsCache, outLocationsCache : 위 캐시 변수
 *
 * 이 파일이 정의하는 이름들(캐시 변수, 렌더 함수 등)은 모듈 스코프라 다른
 * 코드와 전역에서 충돌하지 않는다. 단, HTML의 onclick/onchange 속성(정적 마크업과
 * 이 파일이 생성하는 템플릿 문자열 양쪽 다)이 호출하는 함수들만 파일 하단에서
 * 명시적으로 window에 노출한다.
 */

/* ---------------- 🏢 서브창고(외부창고) 관리 컨트롤러 ---------------- */
let warehousesAdminCache = [];

function loadWarehousesAdminList() {
  const container = document.getElementById('warehousesListContainer');
  callServer('getWarehousesAdmin', [], {
    key: 'warehousesAdmin',
    mode: 'latest',
    onSuccess: list => {
      warehousesAdminCache = list || [];
      warehouseSelectCache = null; // 거래처 폼의 창고 선택 캐시도 최신화되도록 무효화
      renderWarehousesList();
    },
    onError: err => {
      if (container) container.innerHTML = `<div style="padding:20px; text-align:center; color:#dc2626; font-size:8.5pt;">서브창고 목록을 불러오지 못했습니다: ${escapeHtml(err?.message || String(err))}</div>`;
    }
  });
}

function renderWarehousesList() {
  const container = document.getElementById('warehousesListContainer');
  if (!container) return;
  const showInactive = !!document.getElementById('warehouseShowInactive')?.checked;

  let list = warehousesAdminCache.slice();
  if (!showInactive) list = list.filter(w => w.is_active !== false);

  if (list.length === 0) {
    container.innerHTML = '<div style="padding:24px; text-align:center; color:#94a3b8; font-size:8.5pt;">등록된 서브창고가 없습니다.</div>';
    return;
  }

  container.innerHTML = list.map(w => {
    const inactive = w.is_active === false;
    return `
      <div style="display:flex; align-items:center; justify-content:space-between; gap:10px; padding:9px 12px; border-bottom:1px solid #f1f5f9; ${inactive ? 'opacity:0.55; background:#f8fafc;' : ''}">
        <div style="display:flex; align-items:center; gap:8px; min-width:0; flex-wrap:wrap;">
          <span style="font-size:9pt; font-weight:700; color:#1e293b;">🏢 ${escapeHtml(w.name)}</span>
          <span style="font-size:7.5pt; color:#94a3b8;">(${escapeHtml(w.code)})</span>
          <span style="font-size:7.5pt; color:#64748b;">🚚 만차 ${escapeHtml(w.truck_capacity_boxes)}상자</span>
          ${inactive ? `<span style="font-size:7.5pt; font-weight:700; color:#dc2626;">● 비활성</span>` : ''}
        </div>
        <div style="display:flex; gap:6px; flex-shrink:0;">
          <button type="button" onclick="openWarehouseForm(${jsArg(w.code)})" style="padding:4px 10px; background:#f1f5f9; color:#334155; border:1px solid #e2e8f0; border-radius:5px; cursor:pointer; font-size:7.8pt; font-weight:700;">✏️ 수정</button>
          <button type="button" onclick="toggleWarehouseActive(${jsArg(w.code)}, ${inactive})" style="padding:4px 10px; background:${inactive ? '#f0fdf4' : '#fef2f2'}; color:${inactive ? '#15803d' : '#dc2626'}; border:1px solid ${inactive ? '#bbf7d0' : '#fecaca'}; border-radius:5px; cursor:pointer; font-size:7.8pt; font-weight:700;">${inactive ? '✅ 활성화' : '⛔ 비활성화'}</button>
        </div>
      </div>
    `;
  }).join('');
}

function openWarehouseForm(code) {
  const modal = document.getElementById('warehouseFormModal');
  if (!modal) return;
  const w = code ? warehousesAdminCache.find(x => x.code === code) : null;

  document.getElementById('warehouseFormTitle').textContent = w ? '서브창고 정보 수정' : '새 서브창고 등록';
  const codeInp = document.getElementById('warehouseFormCode');
  codeInp.value = w ? w.code : '';
  codeInp.disabled = !!w;
  codeInp.style.background = w ? '#f1f5f9' : '#ffffff';
  document.getElementById('warehouseFormName').value = w ? w.name : '';
  document.getElementById('warehouseFormCapacity').value = w ? (w.truck_capacity_boxes || 100) : 100;
  document.getElementById('warehouseFormSort').value = w ? (w.sort_order ?? '') : '';
  document.getElementById('warehouseFormActive').checked = w ? w.is_active !== false : true;

  modal.style.display = 'flex';
}

function closeWarehouseForm() {
  const modal = document.getElementById('warehouseFormModal');
  if (modal) modal.style.display = 'none';
}

function saveWarehouseForm() {
  const codeInp = document.getElementById('warehouseFormCode');
  const isEdit = codeInp.disabled;
  const code = codeInp.value.trim().toUpperCase();
  const name = document.getElementById('warehouseFormName').value.trim();
  const truckCapacityBoxes = document.getElementById('warehouseFormCapacity').value;
  const sortOrder = document.getElementById('warehouseFormSort').value;
  const isActive = document.getElementById('warehouseFormActive').checked;

  if (!code) { alert('창고 코드를 입력해주세요.'); return; }
  if (!/^[A-Z0-9_-]+$/.test(code)) { alert('창고 코드는 영문 대문자/숫자/-/_ 만 사용할 수 있습니다.'); return; }
  if (!name) { alert('창고 이름을 입력해주세요.'); return; }

  const btn = document.getElementById('warehouseFormSaveBtn');
  if (btn) { btn.disabled = true; btn.textContent = '저장 중...'; }

  callServer('upsertWarehouse', [{ code, name, truckCapacityBoxes, sortOrder, isActive }], {
    key: 'upsertWarehouse',
    onSuccess: () => {
      closeWarehouseForm();
      if (typeof showAppToast === 'function') showAppToast(`💾 서브창고 "${name}"${isEdit ? ' 정보가 수정' : '이 등록'}되었습니다.`, 2500);
      loadWarehousesAdminList();
    },
    onError: err => {
      alert('저장 실패: ' + (err?.message || String(err)));
    },
    onSettled: () => {
      if (btn) { btn.disabled = false; btn.textContent = '💾 저장'; }
    }
  });
}

function toggleWarehouseActive(code, makeActive) {
  const w = warehousesAdminCache.find(x => x.code === code);
  if (!w) return;
  if (!makeActive && !confirm(`"${w.name}"을(를) 비활성화하시겠습니까?\n서브창고 매트릭스/주문서 화면에서 더 이상 선택할 수 없게 되며, 기존 재고와 과거 전표는 그대로 유지됩니다.`)) return;

  callServer('upsertWarehouse', [{ code: w.code, name: w.name, truckCapacityBoxes: w.truck_capacity_boxes, sortOrder: w.sort_order, isActive: makeActive }], {
    key: 'toggleWarehouseActive_' + code,
    onSuccess: () => {
      if (typeof showAppToast === 'function') showAppToast(makeActive ? `✅ "${w.name}" 활성화되었습니다.` : `⛔ "${w.name}" 비활성화되었습니다.`, 2500);
      loadWarehousesAdminList();
    },
    onError: err => alert('처리 실패: ' + (err?.message || String(err)))
  });
}

/* ---------------- 🔐 작업자(관리자/직원) 관리 컨트롤러 ---------------- */
let membersAdminCache = [];

function currentSessionMemberId() {
  try {
    const raw = localStorage.getItem('wms_auth_user');
    return raw ? (JSON.parse(raw)?.id || null) : null;
  } catch (e) { return null; }
}

function loadMembersAdminList() {
  const container = document.getElementById('membersListContainer');
  callServer('getMembersAdmin', [], {
    key: 'membersAdmin',
    mode: 'latest',
    onSuccess: list => {
      membersAdminCache = list || [];
      renderMembersList();
    },
    onError: err => {
      if (container) container.innerHTML = `<div style="padding:20px; text-align:center; color:#dc2626; font-size:8.5pt;">작업자 목록을 불러오지 못했습니다: ${escapeHtml(err?.message || String(err))}</div>`;
    }
  });
}

function renderMembersList() {
  const container = document.getElementById('membersListContainer');
  if (!container) return;
  const showInactive = !!document.getElementById('memberShowInactive')?.checked;
  const selfId = currentSessionMemberId();

  let list = membersAdminCache.slice();
  if (!showInactive) list = list.filter(m => m.is_active !== false);

  if (list.length === 0) {
    container.innerHTML = '<div style="padding:24px; text-align:center; color:#94a3b8; font-size:8.5pt;">등록된 작업자가 없습니다.</div>';
    return;
  }

  container.innerHTML = list.map(m => {
    const inactive = m.is_active === false;
    const isAdmin = String(m.access_level || '').toLowerCase() === 'admin';
    const isSelf = !!(selfId && m.id === selfId);
    return `
      <div style="display:flex; align-items:center; justify-content:space-between; gap:10px; padding:9px 12px; border-bottom:1px solid #f1f5f9; ${inactive ? 'opacity:0.55; background:#f8fafc;' : ''}">
        <div style="display:flex; align-items:center; gap:8px; min-width:0; flex-wrap:wrap;">
          <span style="font-size:7.6pt; font-weight:800; padding:2px 7px; border-radius:10px; background:${isAdmin ? '#eef2ff' : '#f0fdf4'}; color:${isAdmin ? '#4338ca' : '#15803d'};">${isAdmin ? '🛡️ 관리자' : '👤 직원'}</span>
          <span style="font-size:9pt; font-weight:700; color:#1e293b;">${escapeHtml(m.member_name)}</span>
          ${m.branch_name ? `<span style="font-size:7.5pt; color:#94a3b8;">(${escapeHtml(m.branch_name)})</span>` : ''}
          ${isSelf ? `<span style="font-size:7.5pt; font-weight:700; color:#2563eb;">● 본인 계정</span>` : ''}
          ${inactive ? `<span style="font-size:7.5pt; font-weight:700; color:#dc2626;">● 비활성</span>` : ''}
        </div>
        <div style="display:flex; gap:6px; flex-shrink:0;">
          <button type="button" onclick="openMemberForm(${jsArg(m.id)})" style="padding:4px 10px; background:#f1f5f9; color:#334155; border:1px solid #e2e8f0; border-radius:5px; cursor:pointer; font-size:7.8pt; font-weight:700;">✏️ 수정</button>
          ${isSelf ? '' : `<button type="button" onclick="toggleMemberActive(${jsArg(m.id)}, ${inactive})" style="padding:4px 10px; background:${inactive ? '#f0fdf4' : '#fef2f2'}; color:${inactive ? '#15803d' : '#dc2626'}; border:1px solid ${inactive ? '#bbf7d0' : '#fecaca'}; border-radius:5px; cursor:pointer; font-size:7.8pt; font-weight:700;">${inactive ? '✅ 활성화' : '⛔ 비활성화'}</button>`}
        </div>
      </div>
    `;
  }).join('');
}

function openMemberForm(id) {
  const modal = document.getElementById('memberFormModal');
  if (!modal) return;
  const m = id ? membersAdminCache.find(x => x.id === id) : null;

  document.getElementById('memberFormTitle').textContent = m ? '작업자 정보 수정' : '새 작업자 등록';
  document.getElementById('memberFormId').value = m ? m.id : '';
  const nameInp = document.getElementById('memberFormName');
  nameInp.value = m ? m.member_name : '';
  nameInp.disabled = !!m;
  nameInp.style.background = m ? '#f1f5f9' : '#ffffff';
  document.getElementById('memberFormPassword').value = '';
  document.getElementById('memberFormPwHint').textContent = m ? '(변경 시에만 입력)' : '';
  document.getElementById('memberFormAccessLevel').value = m && String(m.access_level || '').toLowerCase() === 'admin' ? 'admin' : 'staff';
  document.getElementById('memberFormBranch').value = m ? (m.branch_name || '') : '';
  document.getElementById('memberFormActive').checked = m ? m.is_active !== false : true;
  // 신규 등록은 항상 활성 상태로 생성되므로(rpc_create_member) 체크박스는 수정 시에만 노출
  document.getElementById('memberFormActiveWrap').style.display = m ? 'block' : 'none';

  modal.style.display = 'flex';
}

function closeMemberForm() {
  const modal = document.getElementById('memberFormModal');
  if (modal) modal.style.display = 'none';
}

function saveMemberForm() {
  const id = document.getElementById('memberFormId').value || null;
  const memberName = document.getElementById('memberFormName').value.trim();
  const password = document.getElementById('memberFormPassword').value;
  const accessLevel = document.getElementById('memberFormAccessLevel').value;
  const branchName = document.getElementById('memberFormBranch').value.trim();
  const isActive = document.getElementById('memberFormActive').checked;

  const btn = document.getElementById('memberFormSaveBtn');

  if (id) {
    if (btn) { btn.disabled = true; btn.textContent = '저장 중...'; }
    callServer('updateMember', [{ id, branchName, accessLevel, password, isActive }], {
      key: 'updateMember',
      onSuccess: () => {
        closeMemberForm();
        if (typeof showAppToast === 'function') showAppToast(`💾 "${memberName}" 정보가 수정되었습니다.`, 2500);
        loadMembersAdminList();
      },
      onError: err => alert('저장 실패: ' + (err?.message || String(err))),
      onSettled: () => { if (btn) { btn.disabled = false; btn.textContent = '💾 저장'; } }
    });
    return;
  }

  if (!memberName) { alert('아이디를 입력해주세요.'); return; }
  if (!password) { alert('비밀번호를 입력해주세요.'); return; }

  if (btn) { btn.disabled = true; btn.textContent = '저장 중...'; }
  callServer('createMember', [{ memberName, password, accessLevel, branchName }], {
    key: 'createMember',
    onSuccess: () => {
      closeMemberForm();
      if (typeof showAppToast === 'function') showAppToast(`💾 작업자 "${memberName}"이(가) 등록되었습니다.`, 2500);
      loadMembersAdminList();
    },
    onError: err => alert('등록 실패: ' + (err?.message || String(err))),
    onSettled: () => { if (btn) { btn.disabled = false; btn.textContent = '💾 저장'; } }
  });
}

function toggleMemberActive(id, makeActive) {
  const m = membersAdminCache.find(x => x.id === id);
  if (!m) return;
  if (!makeActive && !confirm(`"${m.member_name}" 계정을 비활성화하시겠습니까?\n해당 계정은 더 이상 로그인할 수 없게 됩니다.`)) return;

  callServer('updateMember', [{ id: m.id, isActive: makeActive }], {
    key: 'toggleMemberActive_' + id,
    onSuccess: () => {
      if (typeof showAppToast === 'function') showAppToast(makeActive ? `✅ "${m.member_name}" 활성화되었습니다.` : `⛔ "${m.member_name}" 비활성화되었습니다.`, 2500);
      loadMembersAdminList();
    },
    onError: err => alert('처리 실패: ' + (err?.message || String(err)))
  });
}

/* ---------------- 🤝 거래처(입고처/출고처/지점) 관리 컨트롤러 ---------------- */
let partnersAdminCache = [];
let partnersAdminFilterRole = 'ALL';
let warehouseSelectCache = null;

function loadPartnersAdminList() {
  const container = document.getElementById('partnersListContainer');
  callServer('getPartnersMasterAdmin', [], {
    key: 'partnersAdmin',
    mode: 'latest',
    onSuccess: list => {
      partnersAdminCache = list || [];
      renderPartnersList();
    },
    onError: err => {
      if (container) container.innerHTML = `<div style="padding:20px; text-align:center; color:#dc2626; font-size:8.5pt;">거래처 목록을 불러오지 못했습니다: ${escapeHtml(err?.message || String(err))}</div>`;
    }
  });
}

function setPartnerFilter(role, btn) {
  partnersAdminFilterRole = role;
  const wrap = btn ? btn.closest('div') : null;
  (wrap || document).querySelectorAll('.loc-filter-chip').forEach(el => el.classList.remove('active'));
  if (btn) btn.classList.add('active');
  renderPartnersList();
}

function partnerRoleLabel(p) {
  if (p.is_branch) return { text: '🏢 지점', color: '#4338ca', bg: '#eef2ff' };
  if (p.is_supplier && p.is_customer) return { text: '🤝 입고+출고', color: '#b45309', bg: '#fffbeb' };
  if (p.is_supplier) return { text: '📥 입고처', color: '#0369a1', bg: '#e0f2fe' };
  if (p.is_customer) return { text: '📤 출고처', color: '#15803d', bg: '#f0fdf4' };
  return { text: '기타', color: '#64748b', bg: '#f1f5f9' };
}

function renderPartnersList() {
  const container = document.getElementById('partnersListContainer');
  if (!container) return;
  const keyword = (document.getElementById('partnerSearchInput')?.value || '').trim().toLowerCase();
  const showInactive = !!document.getElementById('partnerShowInactive')?.checked;

  let list = partnersAdminCache.slice();
  if (!showInactive) list = list.filter(p => p.is_active !== false);
  if (partnersAdminFilterRole === 'INBOUND') list = list.filter(p => p.is_supplier);
  else if (partnersAdminFilterRole === 'OUTBOUND') list = list.filter(p => p.is_customer && !p.is_branch);
  else if (partnersAdminFilterRole === 'BRANCH') list = list.filter(p => p.is_branch);
  if (keyword) list = list.filter(p => (p.name || '').toLowerCase().includes(keyword));

  if (list.length === 0) {
    container.innerHTML = '<div style="padding:24px; text-align:center; color:#94a3b8; font-size:8.5pt;">일치하는 거래처가 없습니다.</div>';
    return;
  }

  container.innerHTML = list.map(p => {
    const role = partnerRoleLabel(p);
    const inactive = p.is_active === false;
    return `
      <div style="display:flex; align-items:center; justify-content:space-between; gap:10px; padding:9px 12px; border-bottom:1px solid #f1f5f9; ${inactive ? 'opacity:0.55; background:#f8fafc;' : ''}">
        <div style="display:flex; align-items:center; gap:8px; min-width:0; flex-wrap:wrap;">
          <span style="font-size:7.6pt; font-weight:800; padding:2px 7px; border-radius:10px; background:${role.bg}; color:${role.color}; white-space:nowrap;">${role.text}</span>
          <span style="font-size:9pt; font-weight:700; color:#1e293b;">${escapeHtml(p.name)}</span>
          ${p.warehouse_code ? `<span style="font-size:7.5pt; color:#94a3b8;">(${escapeHtml(p.warehouse_code)})</span>` : ''}
          ${inactive ? `<span style="font-size:7.5pt; font-weight:700; color:#dc2626;">● 비활성</span>` : ''}
        </div>
        <div style="display:flex; gap:6px; flex-shrink:0;">
          <button type="button" onclick="openPartnerHistory(${jsArg(p.id)})" style="padding:4px 10px; background:#eef2ff; color:#4338ca; border:1px solid #c7d2fe; border-radius:5px; cursor:pointer; font-size:7.8pt; font-weight:700;">📜 내역</button>
          <button type="button" onclick="openPartnerForm(${jsArg(p.id)})" style="padding:4px 10px; background:#f1f5f9; color:#334155; border:1px solid #e2e8f0; border-radius:5px; cursor:pointer; font-size:7.8pt; font-weight:700;">✏️ 수정</button>
          <button type="button" onclick="togglePartnerActive(${jsArg(p.id)}, ${inactive})" style="padding:4px 10px; background:${inactive ? '#f0fdf4' : '#fef2f2'}; color:${inactive ? '#15803d' : '#dc2626'}; border:1px solid ${inactive ? '#bbf7d0' : '#fecaca'}; border-radius:5px; cursor:pointer; font-size:7.8pt; font-weight:700;">${inactive ? '✅ 활성화' : '⛔ 비활성화'}</button>
        </div>
      </div>
    `;
  }).join('');
}

function openPartnerForm(partnerId) {
  const modal = document.getElementById('partnerFormModal');
  if (!modal) return;
  const p = partnerId ? partnersAdminCache.find(x => x.id === partnerId) : null;

  document.getElementById('partnerFormTitle').textContent = p ? '거래처 정보 수정' : '새 거래처 등록';
  document.getElementById('partnerFormId').value = p ? p.id : '';
  document.getElementById('partnerFormName').value = p ? p.name : '';
  document.getElementById('partnerFormActive').checked = p ? p.is_active !== false : true;

  let roleVal = 'OUTBOUND';
  if (p) {
    if (p.is_branch) roleVal = 'BRANCH';
    else if (p.is_supplier && p.is_customer) roleVal = 'BOTH';
    else if (p.is_supplier) roleVal = 'INBOUND';
  }
  document.getElementById('partnerFormRole').value = roleVal;
  togglePartnerWarehouseField();
  populateWarehouseSelect(p ? p.warehouse_code : '');

  modal.style.display = 'flex';
}

function closePartnerForm() {
  const modal = document.getElementById('partnerFormModal');
  if (modal) modal.style.display = 'none';
}

function togglePartnerWarehouseField() {
  const wrap = document.getElementById('partnerFormWhWrap');
  const role = document.getElementById('partnerFormRole')?.value;
  if (wrap) wrap.style.display = role === 'BRANCH' ? 'block' : 'none';
}

function populateWarehouseSelect(selectedCode) {
  const sel = document.getElementById('partnerFormWh');
  if (!sel) return;
  const fill = (whs) => {
    sel.innerHTML = '<option value="">선택 안 함</option>' + (whs || [])
      .filter(w => !w.is_hub)
      .map(w => `<option value="${escapeHtml(w.code)}" ${w.code === selectedCode ? 'selected' : ''}>${escapeHtml(w.name)} (${escapeHtml(w.code)})</option>`)
      .join('');
  };
  if (warehouseSelectCache) { fill(warehouseSelectCache); return; }
  callServer('getWarehouses', [], {
    key: 'warehousesForPartnerForm',
    mode: 'latest',
    onSuccess: whs => { warehouseSelectCache = whs || []; fill(warehouseSelectCache); }
  });
}

function savePartnerForm() {
  const id = document.getElementById('partnerFormId').value || null;
  const name = document.getElementById('partnerFormName').value.trim();
  const role = document.getElementById('partnerFormRole').value;
  const wh = document.getElementById('partnerFormWh')?.value || null;
  const isActive = document.getElementById('partnerFormActive').checked;

  if (!name) {
    alert('거래처명을 입력해주세요.');
    return;
  }

  const btn = document.getElementById('partnerFormSaveBtn');
  if (btn) { btn.disabled = true; btn.textContent = '저장 중...'; }

  callServer('upsertPartner', [{ id, name, role, warehouseCode: wh, isActive }], {
    key: 'upsertPartner',
    onSuccess: () => {
      closePartnerForm();
      if (typeof showAppToast === 'function') showAppToast(`💾 거래처 "${name}" 정보가 저장되었습니다.`, 2500);
      invalidatePartnerCaches();
      loadPartnersAdminList();
    },
    onError: err => {
      alert('저장 실패: ' + (err?.message || String(err)));
    },
    onSettled: () => {
      if (btn) { btn.disabled = false; btn.textContent = '💾 저장'; }
    }
  });
}

function togglePartnerActive(partnerId, makeActive) {
  const p = partnersAdminCache.find(x => x.id === partnerId);
  if (!p) return;
  if (!makeActive && !confirm(`"${p.name}"을(를) 비활성화하시겠습니까?\n입출고 화면에서 더 이상 선택할 수 없게 되며, 과거 전표는 그대로 유지됩니다.`)) return;

  let role = 'OUTBOUND';
  if (p.is_branch) role = 'BRANCH';
  else if (p.is_supplier && p.is_customer) role = 'BOTH';
  else if (p.is_supplier) role = 'INBOUND';

  callServer('upsertPartner', [{ id: p.id, name: p.name, role, warehouseCode: p.warehouse_code, isActive: makeActive }], {
    key: 'togglePartnerActive_' + partnerId,
    onSuccess: () => {
      if (typeof showAppToast === 'function') showAppToast(makeActive ? `✅ "${p.name}" 활성화되었습니다.` : `⛔ "${p.name}" 비활성화되었습니다.`, 2500);
      invalidatePartnerCaches();
      loadPartnersAdminList();
    },
    onError: err => alert('처리 실패: ' + (err?.message || String(err)))
  });
}

function invalidatePartnerCaches() {
  partnersMasterCache = [];
  partnersMasterMap = new Map();
  inLocationsCache = [];
  outLocationsCache = [];
  if (currentType === 'in' || currentType === 'out') loadDropdowns();
}

/* ---------------- 📜 거래처별 전체 거래내역 조회 ---------------- */
const PARTNER_HISTORY_TYPE_LABEL = {
  INBOUND: '📥 입고',
  OUTBOUND: '📤 출고',
  MOVE: '🔀 이동',
  ADJUST: '⚖️ 조정'
};

function openPartnerHistory(partnerId) {
  const p = partnersAdminCache.find(x => x.id === partnerId);
  if (!p) return;

  const modal = document.getElementById('partnerHistoryModal');
  if (!modal) return;
  document.getElementById('partnerHistoryTitle').textContent = `📜 ${p.name} 전체 거래내역`;
  document.getElementById('partnerHistorySummary').textContent = '불러오는 중...';
  document.getElementById('partnerHistoryTableBody').innerHTML = '<tr><td colspan="8" style="padding:24px; text-align:center; color:#94a3b8;">⏳ 불러오는 중...</td></tr>';
  modal.style.display = 'flex';

  callServer('getPartnerTransactionHistory', [partnerId, { limit: 300 }], {
    key: 'partnerHistory',
    mode: 'latest',
    onSuccess: rows => renderPartnerHistory(p, rows || []),
    onError: err => {
      document.getElementById('partnerHistoryTableBody').innerHTML = `<tr><td colspan="8" style="padding:24px; text-align:center; color:#dc2626;">불러오지 못했습니다: ${escapeHtml(err?.message || String(err))}</td></tr>`;
      document.getElementById('partnerHistorySummary').textContent = '';
    }
  });
}

function closePartnerHistory() {
  const modal = document.getElementById('partnerHistoryModal');
  if (modal) modal.style.display = 'none';
}

function renderPartnerHistory(partner, rows) {
  const tbody = document.getElementById('partnerHistoryTableBody');
  const summary = document.getElementById('partnerHistorySummary');
  if (!tbody) return;

  if (rows.length === 0) {
    tbody.innerHTML = '<tr><td colspan="8" style="padding:24px; text-align:center; color:#94a3b8;">거래내역이 없습니다.</td></tr>';
    if (summary) summary.textContent = '총 0건';
    return;
  }

  let totalBoxes = 0;
  rows.forEach(r => { totalBoxes += Math.abs(Number(r.box_qty || 0)); });
  if (summary) summary.textContent = `최근 ${rows.length}건 · 박스 합계 ${totalBoxes.toLocaleString()}개`;

  tbody.innerHTML = rows.map(r => {
    const typeLabel = PARTNER_HISTORY_TYPE_LABEL[r.transaction_type] || escapeHtml(r.transaction_type || '-');
    const itemLabel = r.items
      ? `${escapeHtml(r.items.item_name)} <span style="color:#94a3b8;">(${escapeHtml(r.items.color || 'SURTIDO')})</span>`
      : '-';
    const whLabel = r.transaction_type === 'MOVE'
      ? `${escapeHtml(r.source_warehouse || '-')} → ${escapeHtml(r.target_warehouse || '-')}`
      : escapeHtml(r.warehouse_code || '-');
    const dateStr = r.created_at
      ? new Date(r.created_at).toLocaleString('ko-KR', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
      : '-';
    return `
      <tr style="border-bottom:1px solid #f1f5f9;">
        <td style="padding:6px 10px; white-space:nowrap; color:#64748b;">${dateStr}</td>
        <td style="padding:6px 10px; white-space:nowrap;">${typeLabel}</td>
        <td style="padding:6px 10px;">${itemLabel}</td>
        <td style="padding:6px 10px; text-align:right;">${Number(r.box_qty || 0).toLocaleString()}</td>
        <td style="padding:6px 10px; text-align:right;">${Number(r.unit_qty || 0).toLocaleString()}</td>
        <td style="padding:6px 10px; white-space:nowrap;">${whLabel}</td>
        <td style="padding:6px 10px; white-space:nowrap;">${escapeHtml(r.handler_name || '-')}</td>
        <td style="padding:6px 10px; white-space:nowrap; color:#94a3b8;">${escapeHtml(r.invoice_no || '-')}</td>
      </tr>
    `;
  }).join('');
}

/* ---------------------------------------------------------------------------
 * window 노출: HTML의 onclick/onchange/oninput 속성(정적 마크업 + 이 파일이
 * 생성하는 템플릿 문자열)과 index.html 인라인 스크립트(openSettingsModal)에서
 * 이름으로 호출하는 함수만 노출한다. 모듈 스코프라 여기 없는 나머지 함수·
 * 변수는 이 파일 밖에서 이름이 겹쳐도 더 이상 충돌하지 않는다.
 * --------------------------------------------------------------------------- */
window.loadWarehousesAdminList = loadWarehousesAdminList;
window.renderWarehousesList = renderWarehousesList;
window.openWarehouseForm = openWarehouseForm;
window.closeWarehouseForm = closeWarehouseForm;
window.saveWarehouseForm = saveWarehouseForm;
window.toggleWarehouseActive = toggleWarehouseActive;

window.loadMembersAdminList = loadMembersAdminList;
window.renderMembersList = renderMembersList;
window.openMemberForm = openMemberForm;
window.closeMemberForm = closeMemberForm;
window.saveMemberForm = saveMemberForm;
window.toggleMemberActive = toggleMemberActive;

window.loadPartnersAdminList = loadPartnersAdminList;
window.setPartnerFilter = setPartnerFilter;
window.renderPartnersList = renderPartnersList;
window.openPartnerForm = openPartnerForm;
window.closePartnerForm = closePartnerForm;
window.togglePartnerWarehouseField = togglePartnerWarehouseField;
window.savePartnerForm = savePartnerForm;
window.togglePartnerActive = togglePartnerActive;

window.openPartnerHistory = openPartnerHistory;
window.closePartnerHistory = closePartnerHistory;
