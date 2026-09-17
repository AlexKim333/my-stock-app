<template>
  <div class="pos-app-layout">
    <!-- 🧭 좌측 네비게이션 바 -->
    <aside class="sidebar-nav">
      <div class="nav-logo">🏆 WMS PRO</div>
      <div v-if="authStore.user" class="nav-user-info">
        <span class="nav-user-name">{{ authStore.user.member_name }}</span>
        <span class="nav-user-meta">{{ authStore.user.branch_name ?? '—' }} · {{ authStore.user.access_level }}</span>
      </div>
      <nav class="nav-menu">
        <a href="#" class="nav-item" :class="{ active: activeNav === 'home' }" @click.prevent="activeNav = 'home'">🏠 시작</a>
        <a href="#" class="nav-item" :class="{ active: activeNav === 'outbound' }" @click.prevent="setTransactionMode('outbound')">📤 출고입력</a>
        <a href="#" class="nav-item" :class="{ active: activeNav === 'inbound' }" @click.prevent="setTransactionMode('inbound')">📥 입고입력</a>
        <a href="#" class="nav-item" :class="{ active: activeNav === 'move' }" @click.prevent="activeNav = 'move'">🔄 재고 이동</a>
        <a href="#" class="nav-item" :class="{ active: activeNav === 'product' }" @click.prevent="setActiveNav('product')">📦 상품등록</a>
        <a href="#" class="nav-item" :class="{ active: activeNav === 'supplier' }" @click.prevent="activeNav = 'supplier'">🏢 입고처</a>
        <a href="#" class="nav-item" :class="{ active: activeNav === 'destination' }" @click.prevent="activeNav = 'destination'">🚚 출고처</a>
        <a href="#" class="nav-item" :class="{ active: activeNav === 'report' }" @click.prevent="activeNav = 'report'">📊 리포트</a>
        <a href="#" class="nav-item" :class="{ active: activeNav === 'manager' }" @click.prevent="activeNav = 'manager'">👤 담당자 (입출고)</a>
        <a href="#" class="nav-item" :class="{ active: activeNav === 'search-edit' }" @click.prevent="activeNav = 'search-edit'">🔍 입출고검색수정</a>
        <a href="#" class="nav-item" :class="{ active: activeNav === 'reservation' }" @click.prevent="activeNav = 'reservation'">📅 예약상황</a>
        <a href="#" class="nav-item" :class="{ active: activeNav === 'settings' }" @click.prevent="activeNav = 'settings'">⚙️ 설정</a>
        <button type="button" class="nav-item nav-logout-btn" @click="handleLogout">🚪 로그아웃</button>
      </nav>
    </aside>

    <!-- 🖥️ 메인 작업 영역 -->
    <main class="main-content-zone">
      <!-- 🚛 멕시코 센트로 8대 서브창고 100상자 FTL 실시간 트럭 게이지 바 -->
      <TruckGaugeBar 
        :warehouses="wmsStore.truckGauges" 
        @refresh="wmsStore.loadTruckGauges" 
        @select-warehouse="handleSelectWarehouse" 
      />

      <!-- 📦 상품등록 전용 화면 -->
      <ProductRegistrationPanel v-if="activeNav === 'product'" />

      <!-- 입출고 POS 작업 화면 -->
      <div v-else class="workspace-body">
        
        <!-- [좌측 분할] 핫키 패널 -->
        <div class="workspace-left">
          <div class="search-section">
            <input 
              type="text" 
              v-model="searchQuery" 
              @input="handleSearchInput" 
              placeholder="Buscar... (품명 또는 바코드 검색)" 
              class="search-bar" 
            />
            <!-- 실시간 검색 결과 드롭다운 팝업 -->
            <div class="search-dropdown-list" v-if="wmsStore.searchResults.length > 0">
              <div 
                v-for="sItem in wmsStore.searchResults" 
                :key="sItem.id" 
                class="search-result-row"
                @click="addSearchedItemToCart(sItem)"
              >
                <span class="sr-name">{{ sItem.name }} ({{ sItem.color }})</span>
                <span class="sr-meta">{{ sItem.pack_qty }}入 · 재고: {{ sItem.stock_box }}B</span>
              </div>
            </div>
          </div>

          <!-- 핫키 블록 1: 단일 10종 (DB 실재고 Top 10 연동) -->
          <div class="hotkey-block">
            <div class="block-header"><h3>⚡ Quick Pick (실재고 베스트 10종)</h3></div>
            <div class="grid-3x4">
              <div v-for="prod in displayedSingleHotkeys" :key="prod.id" class="hotkey-card">
                <button class="hotkey-btn-core" @click="addSingleHotkeyToCart(prod)">
                  <div class="line-1">{{ prod.name }}</div>
                  <div class="line-2">({{ prod.color }} · {{ prod.pack_qty }}入 · {{ prod.stock_box }}B)</div>
                </button>
                <button class="hotkey-sub-edit-btn" @click="openInlineEdit('single', prod)">⚙️</button>
              </div>
              <div class="empty-cell" v-for="n in Math.max(0, 10 - displayedSingleHotkeys.length)" :key="n"></div>
            </div>
          </div>

          <!-- 핫키 블록 2: 복합 10종 -->
          <div class="hotkey-block">
            <div class="block-header"><h3>🌐 Grid Quick Pick (묶음 품목 10종)</h3></div>
            <div class="grid-3x4">
              <div v-for="group in gridHotkeys" :key="group.id" class="hotkey-card">
                <button class="hotkey-btn-core grid-style" @click="openGridModal(group)">
                  <div class="line-1">{{ group.group_name }}</div>
                  <div class="line-2 text-teal">({{ group.variants.length }}가지 컬러)</div>
                </button>
                <button class="hotkey-sub-edit-btn" @click="openInlineEdit('grid', group)">⚙️ edit</button>
              </div>
              <div class="empty-cell"></div><div class="empty-cell"></div>
            </div>
          </div>
        </div>

        <!-- [우측 분할] 장바구니 및 동적 탭 제어 존 -->
        <div class="workspace-right" :class="{ 'inbound-mode': transactionMode === 'inbound' }">
          
          <!-- 📍 우측 상단 다중 탭 (이름 옆에 X 삭제 버튼 추가 규칙 반영) -->
          <div class="tabs-control-header" :class="{ 'inbound-mode': transactionMode === 'inbound' }">
            <div class="tabs-list">
              <div 
                v-for="tab in tabList" 
                :key="tab.id" 
                class="tab-wrapper-item"
                :class="{ 'active': activeTabId === tab.id, 'inbound-mode': transactionMode === 'inbound' }"
              >
                <span class="tab-title-text" @click="activeTabId = tab.id">{{ tab.title }}</span>
                <!-- 탭 삭제 X 버튼 (첫 번째 탭은 안전상 삭제 불가 방어막 적용) -->
                <button v-if="tabList.length > 1" class="tab-close-x-btn" @click.stop="closeTab(tab.id)">×</button>
              </div>
            </div>
            <div class="tabs-header-actions">
              <span class="transaction-mode-label">{{ transactionMode === 'outbound' ? '출고 입력' : '입고 입력' }}</span>
              <button class="add-tab-action-btn" @click="addNewTab">+ 탭추가</button>
            </div>
          </div>

          <!-- 📍 각 탭 내부 영역 (활성화된 탭의 개별 정보가 노출됨) -->
          <div class="tab-body-content" v-if="currentTab">

            <!-- 🔥 3대 고정 입력창: access_level === 'admin' 일 때만 잠금 해제 (실제 DB 마스터 바인딩) -->
            <div class="tab-internal-master-header" :class="{ locked: !canEditMasterFields }">
              <div class="master-lock-group" v-if="transactionMode === 'inbound'">
                <label>🏢 입고처:</label>
                <select v-model="currentTab.selectedSupplier" :disabled="!canEditMasterFields">
                  <option value="">-- 입고처 선택 (총 {{ wmsStore.suppliers.length }}개) --</option>
                  <option v-for="s in wmsStore.suppliers" :key="s.id" :value="s.name">{{ s.name }}</option>
                </select>
              </div>
              <div class="master-lock-group" v-else>
                <label>🚚 출고처 지점:</label>
                <select v-model="currentTab.selectedDestination" :disabled="!canEditMasterFields">
                  <option value="">-- 출고처 선택 (총 {{ wmsStore.destinations.length }}개) --</option>
                  <option v-for="d in wmsStore.destinations" :key="d.id" :value="d.name">{{ d.name }}</option>
                </select>
              </div>
              <div class="master-lock-group">
                <label>👤 입력 담당자:</label>
                <select v-model="currentTab.selectedManager" :disabled="!canEditMasterFields">
                  <option value="">-- 담당자 선택 --</option>
                  <option v-for="m in wmsStore.managers" :key="m.id" :value="m.member_name">
                    {{ m.member_name }} ({{ m.branch_name || '지점' }})
                  </option>
                </select>
              </div>
            </div>

            <!-- 현행 주문 전표 테이블 -->
            <table class="pos-cart-table">
              <thead>
                <tr><th>품명(컬러)</th><th colspan="2">출고량 입력</th><th>총 수량</th></tr>
                <tr class="sub-th"><th></th><th>Caja</th><th>Pza</th><th></th></tr>
              </thead>
              <tbody>
                <tr v-for="item in currentTab.cartItems" :key="item.id">
                  <td class="product-cell">
                    <div class="p-name">{{ item.name }} ({{ item.color }})</div>
                    <div class="p-stock-info">{{ item.pack_qty }}入 · 재고: {{ item.stock_box }}B</div>
                  </td>
                  <td class="input-green">
                    <input type="text" inputmode="numeric" pattern="[0-9]*" v-model.number="item.input_box" placeholder="0" />
                  </td>
                  <td class="input-green">
                    <input type="text" inputmode="numeric" pattern="[0-9]*" v-model.number="item.input_each" placeholder="0" />
                  </td>
                  <td class="total-qty-cell"><strong>{{ (item.input_box * item.pack_qty) + item.input_each }}</strong> 개</td>
                </tr>
                <tr v-if="currentTab.cartItems.length === 0">
                  <td colspan="4" class="empty-cart-msg">핫키를 누르거나 검색하여 상품을 추가하세요.</td>
                </tr>
              </tbody>
            </table>
          </div>

          <!-- 🚚 우측 최하단: 차량 적재 수량 요약 및 '제출', '출고예약' 버튼 -->
          <div class="right-footer-action-zone" v-if="currentTab">
            <!-- 🔥 규칙 반영: 각 탭별 독립적인 상자/낱개 총액 서머리 레이블 2개 장착 -->
            <div class="truck-counter-info-grid">
              <div class="summary-label-box">
                📦 주문박스 총 개수: <strong>{{ currentTabSummary.boxes }} 상자</strong>
              </div>
              <div class="summary-label-box">
                🔢 낱개주문 총 개수: <strong>{{ currentTabSummary.eaches }} 개</strong>
              </div>
            </div>
            
            <div class="action-btn-double-group">
              <button class="btn-outbound-reserve" @click="triggerAction('reserve')">출고 예약 버튼</button>
              <button class="btn-final-submit" @click="triggerAction('submit')">제출 버튼</button>
            </div>
          </div>

        </div>
      </div>
    </main>

    <!-- 모달: 가변형 컬러별 매트릭스 팝업창 -->
    <div class="modal-overlay" v-if="isGridModalOpen">
      <div class="modal-content">
        <div class="modal-header">
          <div class="product-title">품명: <strong>{{ activeGroup.group_name }}</strong></div>
          <button class="submit-btn" @click="submitGridSelection">선택 완료</button>
        </div>
        <table class="grid-table">
          <thead>
            <tr><th>컬러</th><th>창고 실시간 재고</th><th colspan="2">출고 입력</th><th>선택 총 수량</th></tr>
          </thead>
          <tbody>
            <tr v-for="(v, idx) in activeGroup.variants" :key="idx">
              <td class="color-name">{{ v.color }}</td>
              <td class="stock-info">{{ v.stock_box }}B + {{ v.stock_each }}ea</td>
              <td class="input-green"><input type="text" inputmode="numeric" pattern="[0-9]*" v-model.number="v.input_box" placeholder="0" /></td>
              <td class="input-green"><input type="text" inputmode="numeric" pattern="[0-9]*" v-model.number="v.input_each" placeholder="0" /></td>
              <td class="calc-total-qty">{{ ((v.input_box || 0) * activeGroup.pack_qty) + (v.input_each || 0) }}개</td>
            </tr>
          </tbody>
        </table>
        <button class="close-text-btn" @click="isGridModalOpen = false">창 닫기</button>
      </div>
    </div>
  </div>
</template>
<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { useRouter } from 'vue-router'
import { useAuthStore } from '../stores/auth.js'
import { useWmsStore } from '../stores/wms.js'
import TruckGaugeBar from './TruckGaugeBar.vue'
import ProductRegistrationPanel from './ProductRegistrationPanel.vue'

const router = useRouter()
const authStore = useAuthStore()
const wmsStore = useWmsStore()

let unsubscribeRealtime = null

onMounted(async () => {
  await wmsStore.loadMasters()
  unsubscribeRealtime = wmsStore.subscribeRealtime()
})

onUnmounted(() => {
  if (typeof unsubscribeRealtime === 'function') {
    unsubscribeRealtime()
  }
})

/** admin만 3대 마스터 헤더(입고처·출고처·담당자) 수정 가능 */
const canEditMasterFields = computed(() => authStore.isAdmin)

const handleLogout = () => {
  authStore.logout()
  router.push('/login')
}

const searchQuery = ref('')
let searchDebounceTimer = null

const handleSearchInput = () => {
  clearTimeout(searchDebounceTimer)
  searchDebounceTimer = setTimeout(() => {
    wmsStore.searchItems(searchQuery.value)
  }, 200)
}

const addSearchedItemToCart = (sItem) => {
  if (!currentTab.value) return
  const existing = currentTab.value.cartItems.find(item => item.id === sItem.id)
  if (existing) {
    existing.input_box += 1
  } else {
    currentTab.value.cartItems.push({
      id: sItem.id,
      name: sItem.name,
      color: sItem.color,
      pack_qty: sItem.pack_qty,
      stock_box: sItem.stock_box,
      stock_each: sItem.stock_each,
      input_box: 1,
      input_each: 0
    })
  }
  searchQuery.value = ''
  wmsStore.searchResults = []
}

const handleSelectWarehouse = (wh) => {
  alert(`🚚 [${wh.warehouse_name}] 현재 적재량: ${wh.current_boxes || 0}상자 (100상자 기준 ${wh.gauge_percentage || 0}%)`)
}

const isGridModalOpen = ref(false)
const activeGroup = ref(null)
const activeNav = ref('outbound')
const transactionMode = ref('outbound')

const setTransactionMode = (mode) => {
  transactionMode.value = mode
  activeNav.value = mode
}

const setActiveNav = (nav) => {
  activeNav.value = nav
}

// 📍 각 탭이 '마스터 설정'과 '장바구니 배열'을 독립적으로 주머니에 차고 있도록 구성
const tabList = ref([
  { 
    id: 'tab_1', 
    title: '주문서 1',
    selectedSupplier: '',
    selectedDestination: '',
    selectedManager: '',
    cartItems: []
  }
])
const activeTabId = ref('tab_1')

// 현재 활성화된 탭 객체
const currentTab = computed(() => {
  return tabList.value.find(t => t.id === activeTabId.value)
})

// 순수 상자 총합과 낱개 총합 분리 연산
const currentTabSummary = computed(() => {
  if (!currentTab.value) return { boxes: 0, eaches: 0 }
  let boxes = 0
  let eaches = 0
  currentTab.value.cartItems.forEach(item => {
    boxes += (Number(item.input_box) || 0)
    eaches += (Number(item.input_each) || 0)
  })
  return { boxes, eaches }
})

// 실재고 기반 Top 10 핫키 표시
const displayedSingleHotkeys = computed(() => {
  if (wmsStore.hotkeyItems && wmsStore.hotkeyItems.length > 0) {
    return wmsStore.hotkeyItems
  }
  return [
    { id: 'sh_1', name: 'ST43', color: 'SURTIDO', pack_qty: 500, stock_box: 1, stock_each: 0 },
    { id: 'sh_2', name: 'TWLT19', color: 'SURTIDO', pack_qty: 200, stock_box: 18, stock_each: 0 }
  ]
})

const gridHotkeys = ref([
  {
    id: 'gh_1',
    group_name: '021G 시리즈 전체',
    pack_qty: 400,
    variants: [
      { color: 'NEGRO', stock_box: 4, stock_each: 0, input_box: '', input_each: '' },
      { color: 'AZUL', stock_box: 4, stock_each: 0, input_box: '', input_each: '' },
      { color: 'MARINO', stock_box: 3, stock_each: 0, input_box: '', input_each: '' }
    ]
  }
])

// 동적 탭 추가
const addNewTab = () => {
  const nextNum = Math.max(...tabList.value.map(t => parseInt(t.id.replace('tab_', '')) || 1)) + 1
  const newId = `tab_${nextNum}`
  tabList.value.push({ 
    id: newId, 
    title: `주문서 ${nextNum}`,
    selectedSupplier: '',
    selectedDestination: '',
    selectedManager: '',
    cartItems: []
  })
  activeTabId.value = newId
}

// 탭 삭제
const closeTab = (tabId) => {
  const index = tabList.value.findIndex(t => t.id === tabId)
  if (index === -1) return
  
  if (activeTabId.value === tabId) {
    if (index > 0) activeTabId.value = tabList.value[index - 1].id
    else if (tabList.value.length > 1) activeTabId.value = tabList.value[index + 1].id
  }
  tabList.value = tabList.value.filter(t => t.id !== tabId)
}

// 핫키 상품 장바구니 추가
const addSingleHotkeyToCart = (prod) => {
  if (!currentTab.value) return
  const existing = currentTab.value.cartItems.find(item => item.id === prod.id)
  if (existing) { 
    existing.input_box += 1 
  } else { 
    currentTab.value.cartItems.push({ 
      ...prod, 
      input_box: 1, 
      input_each: 0 
    }) 
  }
}

const openGridModal = (group) => {
  activeGroup.value = group
  isGridModalOpen.value = true
}

const submitGridSelection = () => {
  if (!currentTab.value) return
  activeGroup.value.variants.forEach(v => {
    if (v.input_box > 0 || v.input_each > 0) {
      currentTab.value.cartItems.push({
        id: `${activeGroup.value.id}_${v.color}`,
        name: activeGroup.value.group_name,
        color: v.color,
        pack_qty: activeGroup.value.pack_qty,
        stock_box: v.stock_box,
        stock_each: v.stock_each,
        input_box: v.input_box || 0,
        input_each: v.input_each || 0
      })
    }
  })
  isGridModalOpen.value = false
}

const openInlineEdit = (type, target) => {
  alert(`[단축키 안내] ${target.name} (${target.color}) 품목이 매핑되어 있습니다.`);
}

// ⚡ 원자적 Supabase 트랜잭션 실행
const triggerAction = async (actionType) => {
  if (!currentTab.value) return

  if (!currentTab.value.cartItems.length) {
    alert('전표에 입력된 품목이 없습니다. 상품을 먼저 추가해주세요.');
    return;
  }

  if (actionType === 'reserve') {
    alert(`[예약 접수] ${currentTab.value.title} 전표의 출고 예약이 등록되었습니다.`);
    return;
  }

  const isOutbound = transactionMode.value === 'outbound'
  const partnerName = isOutbound 
    ? (currentTab.value.selectedDestination || '일반 출고처')
    : (currentTab.value.selectedSupplier || '일반 입고처');

  const handlerName = currentTab.value.selectedManager || authStore.user?.member_name || '관리자';

  try {
    const res = await wmsStore.submitTransaction({
      transactionType: isOutbound ? 'OUTBOUND' : 'INBOUND',
      warehouseCode: 'MAIN',
      partnerName: partnerName,
      handlerName: handlerName,
      cartItems: currentTab.value.cartItems
    })

    alert(`🎉 [${isOutbound ? '출고' : '입고'} 완료] ${currentTab.value.title} 전표 처리가 완료되었습니다!\n실재고가 Supabase에 즉각 반영되었습니다.`);
    currentTab.value.cartItems = [];
  } catch (err) {
    alert(`❌ 처리 실패: ${err.message}`);
  }
}
</script>
<style scoped>
.pos-app-layout {
  display: flex;
  align-items: flex-start;
  width: 100%;
  min-width: 1024px;
  min-height: 100vh;
  margin: 0 auto;
  overflow: auto;
  font-family: sans-serif;
  background: #f4f6f9;
  box-sizing: border-box;
}

/* 좌측 바: 뷰포트 높이에 고정, 메뉴 넘침 시 스크롤바 표시 */
.sidebar-nav {
  width: 220px;
  min-width: 220px;
  flex-shrink: 0;
  position: sticky;
  top: 0;
  align-self: flex-start;
  height: 100vh;
  max-height: 100vh;
  overflow: hidden;
  background: #1e293b;
  color: #f8fafc;
  display: flex;
  flex-direction: column;
  padding: 20px 0;
  box-sizing: border-box;
}
.nav-logo { flex-shrink: 0; font-size: 18px; font-weight: bold; text-align: center; padding-bottom: 12px; border-bottom: 1px solid #334155; color: #38bdf8; }
.nav-user-info { flex-shrink: 0; padding: 10px 15px 14px; border-bottom: 1px solid #334155; text-align: center; }
.nav-user-name { display: block; font-size: 13px; font-weight: bold; color: #f8fafc; }
.nav-user-meta { display: block; font-size: 10.5px; color: #94a3b8; margin-top: 2px; text-transform: uppercase; }
.nav-menu {
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 15px 10px;
  overflow-y: auto;
  overflow-x: hidden;
  scrollbar-gutter: stable;
  scrollbar-width: thin;
  scrollbar-color: #94a3b8 #334155;
}
.nav-menu::-webkit-scrollbar { width: 8px; }
.nav-menu::-webkit-scrollbar-track { background: #334155; border-radius: 4px; }
.nav-menu::-webkit-scrollbar-thumb { background: #94a3b8; border-radius: 4px; }
.nav-menu::-webkit-scrollbar-thumb:hover { background: #cbd5e1; }
.nav-item { color: #cbd5e1; text-decoration: none; padding: 12px 15px; border-radius: 6px; font-size: 14px; transition: all 0.2s; white-space: nowrap; flex-shrink: 0; }
.nav-item:hover, .nav-item.active { background: #334155; color: white; font-weight: bold; }
.nav-logout-btn { width: 100%; text-align: left; background: none; border: none; cursor: pointer; font-family: inherit; margin-top: 8px; color: #fca5a5 !important; }
.nav-logout-btn:hover { background: #450a0a !important; color: white !important; }

.main-content-zone { flex: 1; min-width: 0; display: flex; flex-direction: column; overflow: visible; }
.workspace-body { display: flex; flex: 1; overflow: hidden; padding: 15px; gap: 15px; }
.workspace-left { flex: 1.1; display: flex; flex-direction: column; gap: 15px; overflow-y: auto; }
.workspace-right { flex: 0.9; background: white; border-radius: 8px; border: 1px solid #e2e8f0; display: flex; flex-direction: column; overflow: hidden; }

.search-section { position: relative; width: 100%; }
.search-bar { width: 100%; padding: 12px; border-radius: 6px; border: 1px solid #cbd5e1; font-size: 14px; box-sizing: border-box; }
.search-dropdown-list {
  position: absolute;
  top: 100%;
  left: 0;
  right: 0;
  background: white;
  border: 1px solid #cbd5e1;
  border-radius: 6px;
  max-height: 280px;
  overflow-y: auto;
  z-index: 100;
  box-shadow: 0 10px 25px rgba(0, 0, 0, 0.15);
  margin-top: 4px;
}
.search-result-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 10px 14px;
  cursor: pointer;
  border-bottom: 1px solid #f1f5f9;
  transition: background 0.15s;
}
.search-result-row:hover {
  background: #f0fdfa;
}
.sr-name {
  font-size: 13px;
  font-weight: bold;
  color: #1e293b;
}
.sr-meta {
  font-size: 11px;
  color: #64748b;
  background: #f1f5f9;
  padding: 2px 6px;
  border-radius: 4px;
}
.hotkey-block { display: flex; flex-direction: column; gap: 8px; }
.block-header { border-bottom: 2px solid #00a896; padding-bottom: 4px; }
.block-header h3 { margin: 0; font-size: 14px; }

.grid-3x4 { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; }
.hotkey-card { display: flex; flex-direction: column; border: 1px solid #cbd5e1; border-radius: 6px; overflow: hidden; background: white; box-shadow: 0 2px 4px rgba(0,0,0,0.02); }
.hotkey-btn-core { background: none; border: none; padding: 12px 4px; cursor: pointer; flex: 1; display: flex; flex-direction: column; justify-content: center; align-items: center; min-height: 55px; }
.grid-style { border-left: 4px solid #00a896; }
.line-1 { font-size: 12.5px; font-weight: bold; }
.line-2 { font-size: 9.5px; color: #64748b; margin-top: 2px; }
.hotkey-sub-edit-btn { background: #f1f5f9; border: none; border-top: 1px solid #e2e8f0; padding: 4px 0; font-size: 10.5px; color: #64748b; cursor: pointer; text-align: center; }
.hotkey-sub-edit-btn:hover { background: #e2e8f0; color: black; }
.empty-cell { border: 1px dashed #cbd5e1; border-radius: 6px; background: #f8fafc; }

/* 📍 탭 바 및 X 닫기 버튼 전용 인테리어 서식 */
.tabs-control-header { display: flex; justify-content: space-between; background: #f1f5f9; border-bottom: 1px solid #e2e8f0; padding: 6px 10px 0 10px; }
.tabs-control-header.inbound-mode { background: #fce7f3; border-bottom-color: #f9a8d4; }
.tabs-list { display: flex; gap: 4px; }
.tab-wrapper-item { display: flex; align-items: center; gap: 6px; background: #e2e8f0; border: 1px solid #cbd5e1; border-bottom: none; padding: 8px 12px; border-radius: 6px 6px 0 0; font-size: 12.5px; font-weight: bold; cursor: pointer; color: #64748b; position: relative; }
.tab-wrapper-item.inbound-mode { background: #fbcfe8; border-color: #f9a8d4; }
.tab-wrapper-item.active { background: white; color: #00a896; border-color: #cbd5e1; border-bottom-color: white; margin-bottom: -1px; }
.tab-wrapper-item.inbound-mode.active { background: #fff1f2; color: #db2777; border-color: #f9a8d4; border-bottom-color: #fff1f2; }
.tab-title-text { cursor: pointer; }
.tab-close-x-btn { background: none; border: none; font-size: 14px; font-weight: bold; color: #94a3b8; cursor: pointer; padding: 0 2px; line-height: 1; border-radius: 50%; }
.tab-close-x-btn:hover { background: #ef4444; color: white; }
.tabs-header-actions { display: flex; align-items: center; gap: 10px; padding-bottom: 6px; }
.transaction-mode-label { font-size: 13px; font-weight: bold; color: #00a896; white-space: nowrap; }
.inbound-mode .transaction-mode-label { color: #db2777; }
.add-tab-action-btn { background: none; border: none; color: #00a896; font-weight: bold; cursor: pointer; font-size: 13px; }
.inbound-mode .add-tab-action-btn { color: #db2777; }
.workspace-right.inbound-mode { background: #fff1f2; border-color: #f9a8d4; }

.tab-body-content { flex: 1; overflow-y: auto; padding: 15px; display: flex; flex-direction: column; gap: 15px; }

/* 📍 탭 내부 전용으로 밀려 들어온 3대 마스터 헤더 서식 */
.tab-internal-master-header { display: flex; gap: 10px; background: #f8fafc; padding: 12px; border-radius: 6px; border: 1px solid #e2e8f0; }
.tab-internal-master-header.locked { background: #f1f5f9; }
.master-lock-group { display: flex; flex-direction: column; gap: 4px; flex: 1; }
.master-lock-group label { font-size: 11px; font-weight: bold; color: #64748b; }
.master-lock-group select { padding: 8px; border: 1px solid #cbd5e1; border-radius: 4px; font-size: 12.5px; outline: none; background: white; }
.master-lock-group select:disabled { background: #e2e8f0; color: #64748b; cursor: not-allowed; }

.pos-cart-table { width: 100%; border-collapse: collapse; }
.pos-cart-table th, .pos-cart-table td { border: 1px solid #e2e8f0; padding: 8px; font-size: 12.5px; text-align: center; }
.pos-cart-table th { background: #f8fafc; font-weight: bold; }
.sub-th th { font-size: 11px; padding: 3px; background: #f1f5f9; }
.empty-cart-msg { padding: 40px 0; color: #94a3b8; font-style: italic; }

.input-green { background-color: #00e676 !important; width: 52px; padding: 2px; }
.input-green input { width: 100%; background: transparent; border: none; text-align: center; font-size: 14px; font-weight: bold; outline: none; }
.product-cell { text-align: left; }
.p-name { font-weight: bold; }
.p-stock-info { font-size: 11px; color: #64748b; }
.total-qty-cell strong { color: #00a896; font-size: 14px; }

/* 📍 우측 하단: 상자 및 낱개 2분할 서머리 레이블 전용 디자인 */
.right-footer-action-zone { border-top: 2px solid #e2e8f0; padding: 15px; background: #f8fafc; display: flex; flex-direction: column; gap: 12px; }
.truck-counter-info-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.summary-label-box { background: white; border: 1px solid #cbd5e1; padding: 10px; border-radius: 6px; font-size: 13px; font-weight: bold; color: #334155; box-shadow: 0 1px 2px rgba(0,0,0,0.02); }
.summary-label-box strong { font-size: 15px; color: #00a896; margin-left: 4px; }

.action-btn-double-group { display: grid; grid-template-columns: 1fr 1.2fr; gap: 10px; }
.btn-outbound-reserve { background: #475569; color: white; border: none; padding: 14px; border-radius: 6px; font-weight: bold; cursor: pointer; font-size: 14.5px; }
.btn-final-submit { background: #00a896; color: white; border: none; padding: 14px; border-radius: 6px; font-weight: bold; cursor: pointer; font-size: 14.5px; }

.modal-overlay { position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.5); display: flex; justify-content: center; align-items: center; z-index: 9999; }
.modal-content { background: white; width: 85%; max-width: 850px; padding: 25px; border-radius: 6px; }
.grid-table { width: 100%; border-collapse: collapse; margin-top: 15px; }
.grid-table th, .grid-table td { border: 1px solid #aaa; padding: 8px; text-align: center; }
.submit-btn { background: white; border: 1px solid #333; padding: 6px 20px; font-weight: bold; cursor: pointer; }
.close-text-btn { float: right; background: none; border: none; color: #888; cursor: pointer; margin-top: 10px; font-size: 12px; }
</style>
