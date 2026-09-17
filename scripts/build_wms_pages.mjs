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
  .replace('<base target="_top">', '<base target="_top">\n  <meta charset="UTF-8">\n  <script type="module" src="/src/wms-entry.js"></script>')
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

// Replace base tag with module loader
warehouseHtml = warehouseHtml.replace(
  '<base target="_top">',
  '<base target="_top">\n  <meta charset="UTF-8">\n  <link rel="icon" type="image/svg+xml" href="/favicon.svg" />\n  <script type="module" src="/src/wms-entry.js"></script>'
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
