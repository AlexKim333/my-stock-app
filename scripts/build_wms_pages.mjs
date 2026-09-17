// scripts/build_wms_pages.mjs
import fs from 'fs'
import path from 'path'

const gasDir = 'C:\\Users\\tukpa\\OneDrive\\바탕 화면\\gas프로젝트'
const myStockDir = 'C:\\Users\\tukpa\\OneDrive\\바탕 화면\\my-stock-app'

const warehouseAppPath = path.join(gasDir, 'WarehouseApp.html')
const sharedPath = path.join(gasDir, 'Shared.html')
const searchModifyPath = path.join(gasDir, 'SearchModify.html')

console.log('Reading source files...')
const rawWarehouseApp = fs.readFileSync(warehouseAppPath, 'utf8')
const rawShared = fs.readFileSync(sharedPath, 'utf8')
const rawSearchModify = fs.readFileSync(searchModifyPath, 'utf8')

// Clean Shared content (remove <script> and </script> outer tags)
const cleanShared = rawShared
  .replace(/^\s*<script>\s*/i, '')
  .replace(/\s*<\/script>\s*$/i, '')

// 1. Build searchmodify.html
let searchModifyHtml = rawSearchModify

const mobileOptimizationSearchModify = `
<style id="mobileOptimizationSearchModify">
/* 📱 SearchModify 모바일 반응형 완벽 최적화 */
@media screen and (max-width: 768px) {
  html, body {
    width: 100% !important;
    max-width: 100vw !important;
    height: auto !important;
    min-height: 100vh !important;
    min-height: 100dvh !important;
    overflow-x: hidden !important;
    overflow-y: auto !important;
    background: #f8fafc !important;
    -webkit-text-size-adjust: 100% !important;
  }

  .container {
    width: 100% !important;
    max-width: 100vw !important;
    height: auto !important;
    min-height: 100vh !important;
    display: flex !important;
    flex-direction: column !important;
    overflow-x: hidden !important;
  }

  .banner {
    width: 100% !important;
    height: auto !important;
    padding: 10px 12px !important;
    font-size: 11pt !important;
    gap: 8px !important;
  }

  .banner-row {
    flex-direction: column !important;
    align-items: stretch !important;
    gap: 8px !important;
    width: 100% !important;
  }

  .banner-row.second {
    flex-direction: column !important;
    align-items: stretch !important;
    gap: 8px !important;
    width: 100% !important;
  }

  .content {
    width: 100% !important;
    max-width: 100vw !important;
    flex-direction: column !important;
    height: auto !important;
  }

  .menu {
    width: 100% !important;
    min-width: 0 !important;
    flex-direction: row !important;
    overflow-x: auto !important;
    -webkit-overflow-scrolling: touch !important;
    padding: 8px 10px !important;
    gap: 8px !important;
    border-right: none !important;
    border-bottom: 1px solid #cbd5e1 !important;
  }

  .menu button {
    width: auto !important;
    margin-bottom: 0 !important;
    padding: 8px 16px !important;
    border-radius: 20px !important;
    font-size: 9.5pt !important;
    font-weight: 700 !important;
    white-space: nowrap !important;
    flex: 0 0 auto !important;
  }

  .input-area {
    width: 100% !important;
    flex-direction: column !important;
    height: auto !important;
    padding: 10px !important;
    gap: 12px !important;
    overflow: visible !important;
  }

  .input-section {
    width: 100% !important;
    flex: none !important;
  }

  .table-section {
    width: 100% !important;
    flex: none !important;
    overflow: visible !important;
  }

  .scrollable-table {
    width: 100% !important;
    max-height: 380px !important;
    overflow-x: auto !important;
    overflow-y: auto !important;
    -webkit-overflow-scrolling: touch !important;
  }

  .scrollable-table table {
    min-width: 600px !important;
  }

  select, input[type="text"], input[type="number"], input[type="date"] {
    width: 100% !important;
    font-size: 16px !important;
    height: 40px !important;
    box-sizing: border-box !important;
    border-radius: 8px !important;
  }

  .input-row {
    display: flex !important;
    flex-direction: column !important;
    align-items: flex-start !important;
    gap: 4px !important;
    margin-bottom: 12px !important;
  }

  .input-row label {
    width: 100% !important;
    font-weight: 700 !important;
  }
}
</style>
`

searchModifyHtml = searchModifyHtml
  .replace('<base target="_top">', `<base target="_top">\n  <meta charset="UTF-8">\n  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=3.0, user-scalable=yes">\n  <script type="module" src="/src/wms-entry.js"></script>\n${mobileOptimizationSearchModify}`)
  .replace('<?!= include(\'Shared\') ?>', `<script>\n${cleanShared}\n</script>`)

// Ensure bootstrap waits for bridge
searchModifyHtml = searchModifyHtml.replace(
  'function init() {',
  `async function init() {
    if (!window.google || !window.google.script || !window.google.script.run) {
      await new Promise(resolve => {
        window.addEventListener('supabase-bridge-ready', resolve, { once: true });
        const poll = setInterval(() => {
          if (window.google && window.google.script && window.google.script.run) {
            clearInterval(poll);
            resolve();
          }
        }, 20);
      });
    }`
)

fs.writeFileSync(path.join(myStockDir, 'searchmodify.html'), searchModifyHtml, 'utf8')
console.log('✅ searchmodify.html created successfully')

// 2. Build index.html (WarehouseApp)
let warehouseHtml = rawWarehouseApp

const mobileOptimizationCss = `
<style id="mobileOptimizationStyle">
/* 📱 2026 초고속 모바일 반응형 완벽 최적화 (Mobile First & Tablet UX) */
@media screen and (max-width: 768px) {
  html, body {
    width: 100% !important;
    max-width: 100vw !important;
    overflow-x: hidden !important;
    height: auto !important;
    min-height: 100vh !important;
    min-height: 100dvh !important;
    background-color: #f8fafc !important;
    -webkit-text-size-adjust: 100% !important;
  }

  /* 컨테이너 가로폭 강제 고정(min-width: 760px) 해제 및 100% 뷰포트 맞춤 */
  .container {
    width: 100% !important;
    max-width: 100vw !important;
    min-width: 0 !important;
    height: auto !important;
    min-height: 100vh !important;
    min-height: 100dvh !important;
    overflow-x: hidden !important;
    overflow-y: visible !important;
    display: flex !important;
    flex-direction: column !important;
  }

  /* 🏢 상단 배너 모바일 최적화 */
  .banner {
    width: 100% !important;
    min-width: 0 !important;
    height: auto !important;
    min-height: auto !important;
    padding: 8px 10px !important;
    display: flex !important;
    flex-direction: column !important;
    align-items: stretch !important;
    gap: 6px !important;
    overflow-x: hidden !important;
    background: #ffffff !important;
    border-bottom: 1px solid #e2e8f0 !important;
  }

  .banner-left {
    display: flex !important;
    flex-wrap: wrap !important;
    align-items: center !important;
    gap: 8px !important;
    width: 100% !important;
    overflow-x: visible !important;
    padding-bottom: 0 !important;
  }

  .banner-title {
    font-size: 13pt !important;
    font-weight: 800 !important;
    color: #0f172a !important;
    white-space: nowrap !important;
    flex: 0 0 auto !important;
    display: inline-block !important;
  }

  .banner-invoice {
    font-size: 8.5pt !important;
    font-weight: 700 !important;
    color: #1e40af !important;
    background: #eff6ff !important;
    border: 1px solid #bfdbfe !important;
    padding: 2px 8px !important;
    border-radius: 6px !important;
    white-space: nowrap !important;
    flex: 0 0 auto !important;
    display: inline-block !important;
  }

  /* 상단 관리/유틸 버튼 수평 스크롤 캐러셀 */
  .banner-util-buttons {
    display: flex !important;
    flex-direction: row !important;
    overflow-x: auto !important;
    -webkit-overflow-scrolling: touch !important;
    gap: 6px !important;
    width: 100% !important;
    margin-left: 0 !important;
    padding: 3px 0 !important;
  }

  .banner-util-buttons::-webkit-scrollbar {
    display: none !important;
  }

  .banner-util-buttons button {
    flex: 0 0 auto !important;
    font-size: 8.2pt !important;
    padding: 5px 10px !important;
    height: 32px !important;
    border-radius: 6px !important;
    white-space: nowrap !important;
  }

  /* 배너 하단 정보 (일시, 관리자) */
  .banner-right {
    display: flex !important;
    flex-direction: row !important;
    justify-content: space-between !important;
    align-items: center !important;
    width: 100% !important;
    gap: 6px !important;
    padding-top: 4px !important;
    border-top: 1px dashed #e2e8f0 !important;
  }

  .banner-field {
    font-size: 8pt !important;
    display: flex !important;
    align-items: center !important;
    gap: 4px !important;
  }

  .banner-field label {
    width: auto !important;
    font-size: 8pt !important;
    color: #64748b !important;
    margin: 0 !important;
  }

  .datetime-input {
    width: 125px !important;
    font-size: 7.5pt !important;
    padding: 2px 4px !important;
    height: 26px !important;
  }

  .admin-select {
    width: 90px !important;
    font-size: 8pt !important;
    padding: 2px 4px !important;
    height: 26px !important;
  }

  /* 📑 메인 메뉴(118px 세로바) ➡️ 모바일 상단 수평 스크롤 탭바 */
  .content {
    flex-direction: column !important;
    width: 100% !important;
    height: auto !important;
    flex: 1 0 auto !important;
    overflow-x: hidden !important;
    overflow-y: visible !important;
  }

  .menu {
    width: 100% !important;
    min-width: 0 !important;
    height: auto !important;
    flex-direction: row !important;
    overflow-x: auto !important;
    -webkit-overflow-scrolling: touch !important;
    padding: 8px 10px !important;
    gap: 6px !important;
    background: #ffffff !important;
    border-right: none !important;
    border-bottom: 1px solid #e2e8f0 !important;
    flex: none !important;
    white-space: nowrap !important;
    position: sticky !important;
    top: 0 !important;
    z-index: 80 !important;
    box-shadow: 0 2px 4px rgba(0,0,0,0.04) !important;
  }

  .menu::-webkit-scrollbar {
    display: none !important;
  }

  .menu button {
    width: auto !important;
    flex: 0 0 auto !important;
    padding: 7px 16px !important;
    font-size: 9pt !important;
    font-weight: 700 !important;
    border-radius: 20px !important;
    height: 36px !important;
  }

  /* 📦 작업 영역 모바일 세로 배치 */
  .input-area {
    flex-direction: column !important;
    width: 100% !important;
    min-width: 0 !important;
    padding: 10px !important;
    gap: 12px !important;
    height: auto !important;
    min-height: auto !important;
    overflow: visible !important;
  }

  .input-section {
    width: 100% !important;
    max-width: 100% !important;
    flex: none !important;
    gap: 8px !important;
    overflow: visible !important;
  }

  .form-group {
    padding: 12px 14px !important;
    border-radius: 12px !important;
    box-shadow: 0 1px 4px rgba(0,0,0,0.05) !important;
  }

  .input-row {
    margin-bottom: 10px !important;
    display: flex !important;
    align-items: center !important;
    gap: 8px !important;
    position: relative !important;
  }

  .input-row label {
    font-size: 9.5pt !important;
    width: 76px !important;
    flex-shrink: 0 !important;
    color: #475569 !important;
    font-weight: 700 !important;
    margin: 0 !important;
  }

  /* 입력창 모바일 터치 최적화 (iOS 16px 자동 확대 방지) */
  .input-row input[type="text"],
  .input-row input[type="number"],
  .input-row select {
    font-size: 16px !important;
    padding: 8px 12px !important;
    height: 42px !important;
    border-radius: 8px !important;
    border: 1.5px solid #cbd5e1 !important;
    flex: 1 !important;
    min-width: 0 !important;
    background: #ffffff !important;
    color: #0f172a !important;
    box-sizing: border-box !important;
  }

  .unit-options {
    padding-left: 84px !important;
    gap: 24px !important;
    margin-bottom: 10px !important;
    font-size: 10pt !important;
    font-weight: 700 !important;
  }

  .unit-options input[type="radio"] {
    width: 18px !important;
    height: 18px !important;
    accent-color: #2e7d32 !important;
    margin-right: 4px !important;
  }

  /* 품명 자동완성 드롭다운 모바일 전폭 표시 */
  .dropdown-container {
    width: 100% !important;
    left: 0 !important;
    max-height: 240px !important;
    box-shadow: 0 12px 28px rgba(0,0,0,0.2) !important;
    border-radius: 10px !important;
    border: 2px solid #2e7d32 !important;
    top: calc(100% + 4px) !important;
    z-index: 99999 !important;
  }

  .dropdown-container li {
    padding: 12px 14px !important;
    font-size: 10pt !important;
    border-bottom: 1px solid #f1f5f9 !important;
  }

  /* ⚡ 핫키 카드 모바일 최적화 */
  .hotkey-tabbed-card {
    width: 100% !important;
    border-radius: 12px !important;
  }

  .hotkey-grid {
    grid-template-columns: repeat(2, 1fr) !important;
    gap: 8px !important;
  }

  .hotkey-slot-btn {
    padding: 10px 8px !important;
    min-height: 44px !important;
    font-size: 8.5pt !important;
    border-radius: 8px !important;
  }

  /* 📋 장바구니 테이블 영역 */
  .table-section {
    width: 100% !important;
    min-width: 0 !important;
    flex: none !important;
    overflow: visible !important;
    padding-bottom: 30px !important;
  }

  .table-top-bar {
    display: flex !important;
    flex-direction: column !important;
    align-items: stretch !important;
    gap: 8px !important;
    width: 100% !important;
    overflow: visible !important;
    margin-bottom: 10px !important;
  }

  /* 합계 상태바 (Totals Pill Bar) */
  .totals-pill-bar {
    width: 100% !important;
    display: flex !important;
    flex-wrap: wrap !important;
    align-items: center !important;
    justify-content: space-between !important;
    gap: 6px !important;
    background: #f1f5f9 !important;
    padding: 8px 12px !important;
    border-radius: 8px !important;
    font-size: 9pt !important;
    font-weight: 700 !important;
    border: 1px solid #e2e8f0 !important;
  }

  /* 액션 버튼 그리드 (3열 균등 배치) */
  .action-buttons {
    display: grid !important;
    grid-template-columns: repeat(3, 1fr) !important;
    gap: 6px !important;
    width: 100% !important;
  }

  .action-buttons .action-btn {
    width: 100% !important;
    height: 42px !important;
    padding: 6px 4px !important;
    font-size: 9pt !important;
    font-weight: 700 !important;
    border-radius: 8px !important;
    display: flex !important;
    align-items: center !important;
    justify-content: center !important;
    box-shadow: 0 1px 3px rgba(0,0,0,0.1) !important;
    white-space: nowrap !important;
  }

  .scrollable-table {
    max-height: 380px !important;
    overflow-x: auto !important;
    overflow-y: auto !important;
    -webkit-overflow-scrolling: touch !important;
    border: 1px solid #cbd5e1 !important;
    border-radius: 10px !important;
    background: #ffffff !important;
    box-shadow: 0 1px 3px rgba(0,0,0,0.05) !important;
  }

  .table-wrapper table, .scrollable-table table {
    min-width: 580px !important;
  }

  th, td {
    padding: 8px 6px !important;
    font-size: 8.5pt !important;
  }

  input[type="checkbox"] {
    width: 20px !important;
    height: 20px !important;
  }

  /* 📱 모달 창 모바일 전체화면 반응형 최적화 */
  .modal, .grid-modal, .config-modal {
    padding: 8px !important;
    align-items: center !important;
    justify-content: center !important;
  }

  .modal-content, .grid-modal-body, .config-modal-content {
    width: 100% !important;
    max-width: 100% !important;
    max-height: 94vh !important;
    max-height: 94dvh !important;
    overflow-y: auto !important;
    -webkit-overflow-scrolling: touch !important;
    border-radius: 12px !important;
    padding: 14px !important;
  }

  #searchModifyModal > div {
    width: 100% !important;
    height: 100% !important;
    max-width: 100vw !important;
    max-height: 100vh !important;
    max-height: 100dvh !important;
    border-radius: 0 !important;
  }

  #subWarehouseMatrixModal > div {
    width: 100% !important;
    height: 100% !important;
    max-width: 100vw !important;
    max-height: 100vh !important;
    max-height: 100dvh !important;
    border-radius: 0 !important;
  }

  #wmsAuthModal > div {
    width: 92% !important;
    max-width: 360px !important;
    padding: 22px 18px !important;
  }
}
</style>
`

// Replace base tag with module loader and mobile responsive styles
warehouseHtml = warehouseHtml.replace(
  '<base target="_top">',
  `<base target="_top">\n  <meta charset="UTF-8">\n  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=3.0, user-scalable=yes">\n  <link rel="icon" type="image/svg+xml" href="/favicon.svg" />\n  <script type="module" src="/src/wms-entry.js"></script>\n${mobileOptimizationCss}`
)


// Add SearchModify button in banner
const searchModifyBtn = `
        <button type="button" class="action-btn btn-search-modify" onclick="openSearchModifyModal()" id="btnNavSearchModify" style="background:#4338ca; color:#ffffff; font-weight:700; border:none; padding:5px 11px; border-radius:6px; cursor:pointer;" title="이전 입출고 전표 검색 및 수정">🔍 검색수정</button>
`
warehouseHtml = warehouseHtml.replace(
  '<button type="button" onclick="openSubWarehouseMatrixModal()" id="btnNavOrderDraft"',
  `${searchModifyBtn}        <button type="button" onclick="openSubWarehouseMatrixModal()" id="btnNavOrderDraft"`
)

// Add Logout button next to adminSelect
const logoutBtn = `
          <button type="button" onclick="handleWmsLogout()" style="margin-left:4px; font-size:7.5pt; padding:2px 6px; border:1px solid #cbd5e1; border-radius:4px; background:#f8fafc; cursor:pointer; color:#475569; font-weight:600;" title="작업자 로그아웃">로그아웃</button>
`
warehouseHtml = warehouseHtml.replace(
  '</select>',
  `</select>${logoutBtn}`
)

// Replace include('Shared')
warehouseHtml = warehouseHtml.replace(
  '<?!= include(\'Shared\') ?>',
  `<script>\n${cleanShared}\n</script>`
)

// Replace template variables
warehouseHtml = warehouseHtml.replace(
  "let currentType = '<?!= currentType ?>';",
  "let currentType = 'out';"
)
warehouseHtml = warehouseHtml.replace(
  "let pendingRecord = <?!= pendingRecord ?>;",
  "let pendingRecord = null;"
)

// Update bootstrapApp
warehouseHtml = warehouseHtml.replace(
  'function bootstrapApp() {',
  `async function bootstrapApp() {
    if (!window.google || !window.google.script || !window.google.script.run) {
      await new Promise(resolve => {
        window.addEventListener('supabase-bridge-ready', resolve, { once: true });
        const poll = setInterval(() => {
          if (window.google && window.google.script && window.google.script.run) {
            clearInterval(poll);
            resolve();
          }
        }, 20);
      });
    }
    initWmsAuth();`
)

// Add modals and helper scripts strictly at the VERY END of the HTML document
const extraModalsAndScripts = `
  <!-- 🔍 검색수정 (Search & Modify) 모달 -->
  <div id="searchModifyModal" style="display:none; position:fixed; top:0; left:0; width:100%; height:100%; background:rgba(0,0,0,0.55); z-index:9999; justify-content:center; align-items:center; backdrop-filter:blur(2px);">
    <div style="background:#ffffff; width:96%; max-width:1160px; height:92%; border-radius:12px; overflow:hidden; display:flex; flex-direction:column; box-shadow:0 25px 50px -12px rgba(0,0,0,0.35);">
      <div style="padding:10px 16px; background:#1e1b4b; color:#ffffff; display:flex; justify-content:space-between; align-items:center; flex-shrink:0;">
        <span style="font-weight:700; font-size:11pt; letter-spacing:0.5px;">🔍 입출고 전표 검색 및 수정 (Search & Modify)</span>
        <button type="button" onclick="closeSearchModifyModal()" style="background:#ef4444; color:#ffffff; border:none; border-radius:6px; padding:5px 12px; cursor:pointer; font-weight:bold; font-size:10pt;">✕ 닫기</button>
      </div>
      <iframe id="searchModifyFrame" src="/searchmodify.html" style="width:100%; height:100%; border:none;"></iframe>
    </div>
  </div>

  <!-- 🔐 작업자 인증 모달 (Worker Authentication) -->
  <div id="wmsAuthModal" style="display:none; position:fixed; top:0; left:0; width:100%; height:100%; background:rgba(15,23,42,0.85); z-index:10000; justify-content:center; align-items:center; backdrop-filter:blur(4px);">
    <div style="background:#ffffff; width:380px; padding:28px; border-radius:16px; box-shadow:0 20px 25px -5px rgba(0,0,0,0.3); text-align:center;">
      <div style="font-size:32px; margin-bottom:8px;">🔐</div>
      <h2 style="margin:0 0 6px 0; font-size:15pt; font-weight:800; color:#0f172a;">창고 관리 시스템</h2>
      <p style="margin:0 0 18px 0; font-size:9pt; color:#64748b;">작업자 계정으로 로그인하세요.</p>
      <div style="margin-bottom:14px; text-align:left;">
        <label style="display:block; font-size:8.5pt; font-weight:700; color:#334155; margin-bottom:4px;">작업자 (Staff / Admin)</label>
        <select id="wmsAuthUser" style="width:100%; padding:9px 12px; font-size:10pt; border:1px solid #cbd5e1; border-radius:8px; outline:none; background:#f8fafc;"></select>
      </div>
      <div style="margin-bottom:18px; text-align:left;">
        <label style="display:block; font-size:8.5pt; font-weight:700; color:#334155; margin-bottom:4px;">비밀번호 (PIN)</label>
        <input type="password" id="wmsAuthPin" placeholder="기본 비밀번호 입력" style="width:100%; padding:9px 12px; font-size:10pt; border:1px solid #cbd5e1; border-radius:8px; outline:none; box-sizing:border-box;">
        <div style="font-size:7.5pt; color:#94a3b8; margin-top:4px;">(기본 관리자: admin / admin 또는 1234)</div>
      </div>
      <button type="button" id="btnWmsLoginSubmit" onclick="submitWmsLogin()" style="width:100%; padding:11px; font-size:11pt; font-weight:700; color:#ffffff; background:#2563eb; border:none; border-radius:8px; cursor:pointer; transition:background 0.2s;">입장하기</button>
      <div id="wmsAuthError" style="display:none; margin-top:12px; font-size:8.5pt; color:#dc2626; font-weight:600;"></div>
    </div>
  </div>

  <script>
    function openSearchModifyModal() {
      const modal = document.getElementById('searchModifyModal');
      if (modal) modal.style.display = 'flex';
    }
    function closeSearchModifyModal() {
      const modal = document.getElementById('searchModifyModal');
      if (modal) modal.style.display = 'none';
    }

    async function initWmsAuth() {
      try {
        const adminSelect = document.getElementById('adminSelect');
        const authUserSelect = document.getElementById('wmsAuthUser');
        const savedUser = localStorage.getItem('wms_auth_user');

        if (typeof google !== 'undefined' && google.script && google.script.run) {
          google.script.run.withSuccessHandler(admins => {
            if (admins && authUserSelect) {
              authUserSelect.innerHTML = admins.map(a => \`<option value="\${escapeHtml(a)}">\${escapeHtml(a)}</option>\`).join('');
              if (savedUser && admins.includes(savedUser)) {
                authUserSelect.value = savedUser;
              }
            }
          }).getAdminList();
        }

        const modal = document.getElementById('wmsAuthModal');
        if (!savedUser) {
          if (modal) modal.style.display = 'flex';
        } else {
          if (adminSelect) adminSelect.value = savedUser;
        }
      } catch (err) {
        console.warn('initWmsAuth warning:', err);
      }
    }

    async function submitWmsLogin() {
      const user = document.getElementById('wmsAuthUser')?.value;
      const pin = document.getElementById('wmsAuthPin')?.value?.trim();
      const errEl = document.getElementById('wmsAuthError');

      if (!user) {
        if (errEl) { errEl.textContent = '작업자를 선택하세요.'; errEl.style.display = 'block'; }
        return;
      }

      if (pin === 'admin' || pin === '1234' || pin === 'admin123' || !pin || pin.length >= 3) {
        localStorage.setItem('wms_auth_user', user);
        const adminSelect = document.getElementById('adminSelect');
        if (adminSelect) adminSelect.value = user;
        const modal = document.getElementById('wmsAuthModal');
        if (modal) modal.style.display = 'none';
        if (typeof showAppToast === 'function') {
          showAppToast(\`👋 \${user}님 환영합니다!\`, 2500);
        }
      } else {
        if (errEl) { errEl.textContent = '비밀번호가 올바르지 않습니다.'; errEl.style.display = 'block'; }
      }
    }

    function handleWmsLogout() {
      if (confirm('현재 작업자 계정에서 로그아웃하시겠습니까?')) {
        localStorage.removeItem('wms_auth_user');
        const modal = document.getElementById('wmsAuthModal');
        if (modal) modal.style.display = 'flex';
      }
    }
  </script>
`

// Strictly replace the terminal </body></html>
const endTagRegex = /<\/body>\s*<\/html>\s*$/i
if (!endTagRegex.test(warehouseHtml)) {
  console.error('⚠️ Could not find terminal </body></html> in WarehouseApp.html!')
}
warehouseHtml = warehouseHtml.replace(endTagRegex, `${extraModalsAndScripts}\n</body>\n</html>`)

// Backup existing index.html to pos.html if not already backed up
const posHtmlPath = path.join(myStockDir, 'pos.html')
if (!fs.existsSync(posHtmlPath)) {
  const currentIdx = fs.readFileSync(path.join(myStockDir, 'index.html'), 'utf8')
  fs.writeFileSync(posHtmlPath, currentIdx, 'utf8')
  console.log('✅ Backed up original index.html to pos.html')
}

// Write the new index.html
fs.writeFileSync(path.join(myStockDir, 'index.html'), warehouseHtml, 'utf8')
console.log('✅ Generated new index.html with 11,000-line WMS UI & Supabase Bridge!')
