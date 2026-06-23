<template>
  <div class="pos-app-layout">
    <!-- 🧭 좌측 네비게이션 바 (10개 필수 항목) -->
    <aside class="sidebar-nav">
      <div class="nav-logo">🏆 WMS PRO</div>
      <nav class="nav-menu">
        <a href="#" class="nav-item active">🏠 시작</a>
        <a href="#" class="nav-item">📤 출고입력</a>
        <a href="#" class="nav-item">📥 입고입력</a>
        <a href="#" class="nav-item">🔄 재고 이동</a>
        <a href="#" class="nav-item">📦 상품등록</a>
        <a href="#" class="nav-item">🏢 입고처</a>
        <a href="#" class="nav-item">🚚 출고처</a>
        <a href="#" class="nav-item">📊 리포트</a>
        <a href="#" class="nav-item">👤 담당자 (입출고)</a>
        <a href="#" class="nav-item">⚙️ 설정</a>
      </nav>
    </aside>

    <!-- 🖥️ 메인 작업 영역 -->
    <main class="main-content-zone">
      <div class="workspace-body">
        
        <!-- [좌측 분할] 핫키 패널 -->
        <div class="workspace-left">
          <div class="search-section">
            <input type="text" v-model="searchQuery" placeholder="Buscar... (숫자패드로 상품 코드 검색)" class="search-bar" />
          </div>

          <!-- 핫키 블록 1: 단일 10종 -->
          <div class="hotkey-block">
            <div class="block-header"><h3>⚡ Quick Pick (단일 베스트 10종)</h3></div>
            <div class="grid-3x4">
              <div v-for="prod in singleHotkeys" :key="prod.id" class="hotkey-card">
                <button class="hotkey-btn-core" @click="addSingleHotkeyToCart(prod)">
                  <div class="line-1">{{ prod.name }}</div>
                  <div class="line-2">({{ prod.color }} · {{ prod.pack_qty }}入)</div>
                </button>
                <button class="hotkey-sub-edit-btn" @click="openInlineEdit('single', prod)">⚙️ edit</button>
              </div>
              <div class="empty-cell"></div><div class="empty-cell"></div>
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
        <div class="workspace-right">
          
          <!-- 📍 우측 상단 다중 탭 (이름 옆에 X 삭제 버튼 추가 규칙 반영) -->
          <div class="tabs-control-header">
            <div class="tabs-list">
              <div 
                v-for="tab in tabList" 
                :key="tab.id" 
                class="tab-wrapper-item"
                :class="{ 'active': activeTabId === tab.id }"
              >
                <span class="tab-title-text" @click="activeTabId = tab.id">{{ tab.title }}</span>
                <!-- 탭 삭제 X 버튼 (첫 번째 탭은 안전상 삭제 불가 방어막 적용) -->
                <button v-if="tabList.length > 1" class="tab-close-x-btn" @click.stop="closeTab(tab.id)">×</button>
              </div>
            </div>
            <button class="add-tab-action-btn" @click="addNewTab">+ 탭추가</button>
          </div>

          <!-- 📍 각 탭 내부 영역 (활성화된 탭의 개별 정보가 노출됨) -->
          <div class="tab-body-content" v-if="currentTab">
            
            <!-- 🔥 3대 고정 입력창이 각 주문 탭 내부 상단으로 이사 완료 -->
            <div class="tab-internal-master-header">
              <div class="master-lock-group">
                <label>🏢 입고처:</label>
                <select v-model="currentTab.selectedSupplier">
                  <option value="sup_1">중국 산동 무역 공장</option>
                  <option value="sup_2">광저우 물류 제조사</option>
                </select>
              </div>
              <div class="master-lock-group">
                <label>🚚 출고처 지점:</label>
                <select v-model="currentTab.selectedDestination">
                  <option value="dest_1">센트로 1호 본점</option>
                  <option value="dest_2">산 안토니오 2호 분점</option>
                </select>
              </div>
              <div class="master-lock-group">
                <label>👤 입력 담당자:</label>
                <select v-model="currentTab.selectedManager">
                  <option value="m_1">Juan (주간)</option>
                  <option value="m_2">Carlos (야간)</option>
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
import { ref, computed } from 'vue'

const searchQuery = ref('')
const isGridModalOpen = ref(false)
const activeGroup = ref(null)

// 📍 각 탭이 '마스터 설정'과 '장바구니 배열'을 독립적으로 주머니에 차고 있도록 데이터 구조 전면 갈아엎기
const tabList = ref([
  { 
    id: 'tab_1', 
    title: '주문서 1',
    selectedSupplier: 'sup_1',
    selectedDestination: 'dest_1',
    selectedManager: 'm_1',
    cartItems: []
  }
])
const activeTabId = ref('tab_1')

// 현재 활성화된 탭 객체를 실시간 조명하는 계산식 규칙
const currentTab = computed(() => {
  return tabList.value.find(t => t.id === activeTabId.value)
})

// 📍 규칙 반영: 현재 선택된 탭 내부의 순수 상자 총합과 낱개 총합을 실시간 분리 연산하는 엔진
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

const singleHotkeys = ref([
  { id: 'sh_1', name: 'P-160', color: 'NEGRO', pack_qty: 50, stock_box: 120, stock_each: 5 },
  { id: 'sh_2', name: 'L-160', color: 'BLANCO', pack_qty: 40, stock_box: 85, stock_each: 12 }
])

const gridHotkeys = ref([
  {
    id: 'gh_1',
    group_name: 'P-150 시리즈 전체',
    pack_qty: 50,
    variants: [
      { color: '검정', stock_box: 12, stock_each: 5, input_box: '', input_each: '' },
      { color: '흰색', stock_box: 0,  stock_each: 0, input_box: '', input_each: '' }
    ]
  }
])

// 동적 탭 추가 시, 독립된 빈 설정 주머니를 채워서 생성하는 규칙
const addNewTab = () => {
  const nextNum = Math.max(...tabList.value.map(t => parseInt(t.id.replace('tab_', '')) || 1)) + 1
  const newId = `tab_${nextNum}`
  tabList.value.push({ 
    id: newId, 
    title: `주문서 ${nextNum}`,
    selectedSupplier: 'sup_1',
    selectedDestination: 'dest_1',
    selectedManager: 'm_1',
    cartItems: []
  })
  activeTabId.value = newId
}

// 📍 규칙 반영: 탭 이름 옆 X를 눌렀을 때 해당 전표를 파괴하고 이웃 탭으로 포커스를 옮기는 삭제 엔진
const closeTab = (tabId) => {
  const index = tabList.value.findIndex(t => t.id === tabId)
  if (index === -1) return
  
  // 삭제하려는 탭이 현재 보고 있는 활성화 탭이라면 이웃 탭으로 주소 이동 안전장치 가동
  if (activeTabId.value === tabId) {
    if (index > 0) activeTabId.value = tabList.value[index - 1].id
    else if (tabList.value.length > 1) activeTabId.value = tabList.value[index + 1].id
  }
  tabList.value = tabList.value.filter(t => t.id !== tabId)
}

// 활성화된 탭의 독립 주머니에 핫키 상품을 꽂아 넣는 로직 규칙
const addSingleHotkeyToCart = (prod) => {
  if (!currentTab.value) return
  const existing = currentTab.value.cartItems.find(item => item.id === prod.id)
  if (existing) { existing.input_box += 1 } 
  else { currentTab.value.cartItems.push({ ...prod, input_box: 1, input_each: 0 }) }
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
  alert(`[단축키 수정] 기어 단추를 클릭하여 ${target.name} 단축 아이템 매핑을 변경합니다.`);
}

const triggerAction = (actionType) => {
  if (!currentTab.value) return
  if (actionType === 'reserve') {
    alert(`[예약 완료] ${currentTab.value.title} 전표의 수량이 가상 물류 대장에 임시 세이브되었습니다.`);
  } else {
    alert(`[최종 제출] ${currentTab.value.title} 전표 발행이 승인되어 데이터가 처리되고 해당 탭이 클리어됩니다.`);
    currentTab.value.cartItems = [];
  }
}
</script>
<style scoped>
.pos-app-layout { display: flex; width: 100vw; height: 100vh; overflow: hidden; font-family: sans-serif; background: #f4f6f9; }

/* 좌측 바 고정 */
.sidebar-nav { width: 220px; background: #1e293b; color: #f8fafc; display: flex; flex-direction: column; padding: 20px 0; }
.nav-logo { font-size: 18px; font-weight: bold; text-align: center; padding-bottom: 20px; border-bottom: 1px solid #334155; color: #38bdf8; }
.nav-menu { display: flex; flex-direction: column; gap: 4px; padding: 15px 10px; }
.nav-item { color: #cbd5e1; text-decoration: none; padding: 12px 15px; border-radius: 6px; font-size: 14px; transition: all 0.2s; }
.nav-item:hover, .nav-item.active { background: #334155; color: white; font-weight: bold; }

.main-content-zone { flex: 1; display: flex; flex-direction: column; overflow: hidden; }
.workspace-body { display: flex; flex: 1; overflow: hidden; padding: 15px; gap: 15px; }
.workspace-left { flex: 1.1; display: flex; flex-direction: column; gap: 15px; overflow-y: auto; }
.workspace-right { flex: 0.9; background: white; border-radius: 8px; border: 1px solid #e2e8f0; display: flex; flex-direction: column; overflow: hidden; }

.search-bar { width: 100%; padding: 12px; border-radius: 6px; border: 1px solid #cbd5e1; font-size: 14px; }
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
.tabs-list { display: flex; gap: 4px; }
.tab-wrapper-item { display: flex; align-items: center; gap: 6px; background: #e2e8f0; border: 1px solid #cbd5e1; border-bottom: none; padding: 8px 12px; border-radius: 6px 6px 0 0; font-size: 12.5px; font-weight: bold; cursor: pointer; color: #64748b; position: relative; }
.tab-wrapper-item.active { background: white; color: #00a896; border-color: #cbd5e1; border-bottom-color: white; margin-bottom: -1px; }
.tab-title-text { cursor: pointer; }
.tab-close-x-btn { background: none; border: none; font-size: 14px; font-weight: bold; color: #94a3b8; cursor: pointer; padding: 0 2px; line-height: 1; border-radius: 50%; }
.tab-close-x-btn:hover { background: #ef4444; color: white; }
.add-tab-action-btn { background: none; border: none; color: #00a896; font-weight: bold; cursor: pointer; font-size: 13px; padding-bottom: 6px; }

.tab-body-content { flex: 1; overflow-y: auto; padding: 15px; display: flex; flex-direction: column; gap: 15px; }

/* 📍 탭 내부 전용으로 밀려 들어온 3대 마스터 헤더 서식 */
.tab-internal-master-header { display: flex; gap: 10px; background: #f8fafc; padding: 12px; border-radius: 6px; border: 1px solid #e2e8f0; }
.master-lock-group { display: flex; flex-direction: column; gap: 4px; flex: 1; }
.master-lock-group label { font-size: 11px; font-weight: bold; color: #64748b; }
.master-lock-group select { padding: 8px; border: 1px solid #cbd5e1; border-radius: 4px; font-size: 12.5px; outline: none; background: white; }

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
