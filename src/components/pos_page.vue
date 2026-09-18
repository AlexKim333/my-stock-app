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
        <a href="#" class="nav-item" :class="{ active: activeNav === 'home' }" @click.prevent="setTransactionMode('home')">🏠 시작</a>
        <a href="#" class="nav-item" :class="{ active: activeNav === 'outbound' }" @click.prevent="setTransactionMode('outbound')">📤 출고입력</a>
        <a href="#" class="nav-item" :class="{ active: activeNav === 'inbound' }" @click.prevent="setTransactionMode('inbound')">📥 입고입력</a>
        <a href="#" class="nav-item" :class="{ active: activeNav === 'move' }" @click.prevent="setTransactionMode('move')">🔄 재고 이동</a>
        <a href="#" class="nav-item" :class="{ active: activeNav === 'product' }" @click.prevent="setActiveNav('product')">📦 상품등록</a>
        <a href="#" class="nav-item" :class="{ active: activeNav === 'supplier' }" @click.prevent="setActiveNav('supplier')">🏢 입고처</a>
        <a href="#" class="nav-item" :class="{ active: activeNav === 'destination' }" @click.prevent="setActiveNav('destination')">🚚 출고처</a>
        <a href="#" class="nav-item" :class="{ active: activeNav === 'report' }" @click.prevent="setActiveNav('report')">📊 리포트</a>
        <a href="#" class="nav-item" :class="{ active: activeNav === 'manager' }" @click.prevent="setActiveNav('manager')">👤 담당자 (입출고)</a>
        <a href="#" class="nav-item" :class="{ active: activeNav === 'search-edit' }" @click.prevent="setActiveNav('search-edit')">🔍 입출고검색수정</a>
        <a href="#" class="nav-item" :class="{ active: activeNav === 'reservation' }" @click.prevent="setActiveNav('reservation')">📅 예약상황</a>
        <a href="#" class="nav-item" :class="{ active: activeNav === 'settings' }" @click.prevent="setActiveNav('settings')">⚙️ 설정</a>
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

      <section v-else-if="!isPosWorkspace" class="master-panel">
        <header class="master-panel-header">
          <h2>{{ masterPanelTitle }}</h2>
          <p>{{ masterPanelHint }}</p>
        </header>

        <div v-if="activeNav === 'supplier'" class="master-table-wrap">
          <form v-if="authStore.isAdmin" class="master-add-form" @submit.prevent="addPartner('INBOUND')">
            <input v-model="newPartnerName" type="text" placeholder="입고처 이름" />
            <button type="submit" :disabled="wmsStore.isSubmitting">추가</button>
          </form>
          <table class="master-table">
            <thead><tr><th>입고처</th><th>유형</th><th>상태</th><th v-if="authStore.isAdmin">관리</th></tr></thead>
            <tbody>
              <tr v-for="s in wmsStore.suppliers" :key="s.id">
                <template v-if="editingPartnerId === s.id">
                  <td><input v-model="editPartnerName" type="text" /></td>
                  <td>INBOUND</td>
                  <td>
                    <button type="button" class="row-mini" @click="savePartnerEdit('INBOUND')">저장</button>
                    <button type="button" class="row-mini ghost" @click="cancelPartnerEdit">취소</button>
                  </td>
                  <td></td>
                </template>
                <template v-else>
                  <td>{{ s.name }}</td>
                  <td>{{ s.partner_type || (s.is_supplier ? 'INBOUND' : '—') }}</td>
                  <td>{{ s.is_active === false ? '비활성' : '활성' }}</td>
                  <td v-if="authStore.isAdmin">
                    <button type="button" class="row-mini" @click="startPartnerEdit(s, 'INBOUND')">수정</button>
                    <button type="button" class="row-mini ghost" @click="togglePartnerActive(s, 'INBOUND')">
                      {{ s.is_active === false ? '활성화' : '비활성' }}
                    </button>
                  </td>
                </template>
              </tr>
              <tr v-if="!wmsStore.suppliers.length"><td :colspan="authStore.isAdmin ? 4 : 3">등록된 입고처가 없습니다.</td></tr>
            </tbody>
          </table>
        </div>

        <div v-else-if="activeNav === 'destination'" class="master-table-wrap">
          <form v-if="authStore.isAdmin" class="master-add-form" @submit.prevent="addPartner('OUTBOUND')">
            <input v-model="newPartnerName" type="text" placeholder="출고처 / 지점 이름" />
            <select v-model="newPartnerWarehouse">
              <option value="">창고코드 없음</option>
              <option v-for="w in wmsStore.warehouses" :key="w.code" :value="w.code">{{ w.code }}</option>
            </select>
            <label class="master-check"><input type="checkbox" v-model="newPartnerIsBranch" /> 지점</label>
            <button type="submit" :disabled="wmsStore.isSubmitting">추가</button>
          </form>
          <table class="master-table">
            <thead><tr><th>출고처 / 지점</th><th>창고코드</th><th>유형</th><th v-if="authStore.isAdmin">관리</th></tr></thead>
            <tbody>
              <tr v-for="d in wmsStore.destinations" :key="d.id">
                <template v-if="editingPartnerId === d.id">
                  <td><input v-model="editPartnerName" type="text" /></td>
                  <td>
                    <select v-model="editPartnerWarehouse">
                      <option value="">창고코드 없음</option>
                      <option v-for="w in wmsStore.warehouses" :key="w.code" :value="w.code">{{ w.code }}</option>
                    </select>
                  </td>
                  <td>
                    <label class="master-check"><input type="checkbox" v-model="editPartnerIsBranch" /> 지점</label>
                    <button type="button" class="row-mini" @click="savePartnerEdit('OUTBOUND')">저장</button>
                    <button type="button" class="row-mini ghost" @click="cancelPartnerEdit">취소</button>
                  </td>
                  <td></td>
                </template>
                <template v-else>
                  <td>{{ d.name }}</td>
                  <td>{{ d.warehouse_code || '—' }}</td>
                  <td>{{ d.is_branch ? '지점' : (d.partner_type || 'OUTBOUND') }}{{ d.is_active === false ? ' · 비활성' : '' }}</td>
                  <td v-if="authStore.isAdmin">
                    <button type="button" class="row-mini" @click="startPartnerEdit(d, 'OUTBOUND')">수정</button>
                    <button type="button" class="row-mini ghost" @click="togglePartnerActive(d, 'OUTBOUND')">
                      {{ d.is_active === false ? '활성화' : '비활성' }}
                    </button>
                  </td>
                </template>
              </tr>
              <tr v-if="!wmsStore.destinations.length"><td :colspan="authStore.isAdmin ? 4 : 3">등록된 출고처가 없습니다.</td></tr>
            </tbody>
          </table>
        </div>

        <div v-else-if="activeNav === 'manager'" class="master-table-wrap">
          <form v-if="authStore.isAdmin" class="master-add-form" @submit.prevent="addMember">
            <input v-model="newMemberName" type="text" placeholder="아이디" />
            <input v-model="newMemberPassword" type="password" placeholder="비밀번호" />
            <input v-model="newMemberBranch" type="text" placeholder="지점" />
            <select v-model="newMemberLevel">
              <option value="staff">staff</option>
              <option value="admin">admin</option>
            </select>
            <button type="submit" :disabled="wmsStore.isSubmitting">추가</button>
          </form>
          <table class="master-table">
            <thead><tr><th>담당자</th><th>지점</th><th>권한</th><th v-if="authStore.isAdmin">관리</th></tr></thead>
            <tbody>
              <tr v-for="m in wmsStore.managers" :key="m.id">
                <template v-if="editingMemberId === m.id">
                  <td>{{ m.member_name }}</td>
                  <td><input v-model="editMemberBranch" type="text" /></td>
                  <td>
                    <select v-model="editMemberLevel">
                      <option value="staff">staff</option>
                      <option value="admin">admin</option>
                    </select>
                    <input v-model="editMemberPassword" type="password" placeholder="새 비밀번호(선택)" />
                    <button type="button" class="row-mini" @click="saveMemberEdit">저장</button>
                    <button type="button" class="row-mini ghost" @click="cancelMemberEdit">취소</button>
                  </td>
                  <td></td>
                </template>
                <template v-else>
                  <td>{{ m.member_name }}</td>
                  <td>{{ m.branch_name || '—' }}</td>
                  <td>{{ m.access_level }}{{ m.is_active === false ? ' · 비활성' : '' }}</td>
                  <td v-if="authStore.isAdmin">
                    <button type="button" class="row-mini" @click="startMemberEdit(m)">수정</button>
                    <button type="button" class="row-mini ghost" @click="toggleMemberActive(m)">
                      {{ m.is_active === false ? '활성화' : '비활성' }}
                    </button>
                  </td>
                </template>
              </tr>
              <tr v-if="!wmsStore.managers.length"><td :colspan="authStore.isAdmin ? 4 : 3">등록된 담당자가 없습니다.</td></tr>
            </tbody>
          </table>
        </div>

        <div v-else-if="activeNav === 'reservation'" class="master-table-wrap">
          <p v-if="wmsStore.isLoading">예약 목록을 불러오는 중…</p>
          <table v-else class="master-table">
            <thead><tr><th>상태</th><th>출발</th><th>도착</th><th>상자</th><th>낱개</th><th>요청자</th><th>메모</th></tr></thead>
            <tbody>
              <tr v-for="p in wmsStore.pendingOrders" :key="p.id">
                <td>{{ p.status }}</td>
                <td>{{ p.from_warehouse }}</td>
                <td>{{ p.to_warehouse || '—' }}</td>
                <td>{{ p.box_qty }}</td>
                <td>{{ p.unit_qty }}</td>
                <td>{{ p.requested_by || '—' }}</td>
                <td>{{ p.memo || '' }}</td>
              </tr>
              <tr v-if="!wmsStore.pendingOrders.length"><td colspan="7">진행 중인 예약이 없습니다.</td></tr>
            </tbody>
          </table>
        </div>

        <div v-else-if="activeNav === 'report'" class="report-panel">
          <p v-if="!wmsStore.dashboard">리포트를 불러오는 중…</p>
          <template v-else>
            <div class="master-stats">
              <div class="stat-card"><span>메인 재고</span><strong>{{ wmsStore.dashboard.kpi.totalMainBoxes }} 상자</strong></div>
              <div class="stat-card"><span>오늘 입고</span><strong>{{ wmsStore.dashboard.kpi.todayInBoxes }}</strong></div>
              <div class="stat-card"><span>오늘 출고</span><strong>{{ wmsStore.dashboard.kpi.todayOutBoxes }}</strong></div>
              <div class="stat-card"><span>오늘 이동</span><strong>{{ wmsStore.dashboard.kpi.todayMoveBoxes }}</strong></div>
              <div class="stat-card"><span>이동중</span><strong>{{ wmsStore.dashboard.kpi.totalInTransitBoxes }}</strong></div>
              <div class="stat-card"><span>안전재고 미달</span><strong>{{ wmsStore.dashboard.kpi.lowStockCount }}</strong></div>
            </div>
            <h3 class="report-sub">안전재고 미달</h3>
            <table class="master-table">
              <thead><tr><th>품목</th><th>유효</th><th>안전</th><th>부족</th></tr></thead>
              <tbody>
                <tr v-for="item in wmsStore.dashboard.lowStockItems" :key="item.item_id">
                  <td>{{ item.itemName }} ({{ item.color }})</td>
                  <td>{{ item.effectiveStock }}</td>
                  <td>{{ item.safeStock }}</td>
                  <td>{{ item.shortage }}</td>
                </tr>
                <tr v-if="!wmsStore.dashboard.lowStockItems?.length"><td colspan="4">미달 품목이 없습니다.</td></tr>
              </tbody>
            </table>
            <h3 class="report-sub">최근 출고 Top 5</h3>
            <table class="master-table">
              <thead><tr><th>품목</th><th>상자</th></tr></thead>
              <tbody>
                <tr v-for="s in wmsStore.dashboard.topSellers" :key="s.name">
                  <td>{{ s.name }}</td>
                  <td>{{ s.boxes }}</td>
                </tr>
                <tr v-if="!wmsStore.dashboard.topSellers?.length"><td colspan="2">데이터가 없습니다.</td></tr>
              </tbody>
            </table>
          </template>
        </div>

        <div v-else-if="activeNav === 'search-edit'" class="search-edit-native">
          <SearchEditPanel />
        </div>

        <div v-else-if="activeNav === 'settings'" class="settings-panel">
          <p>세션 사용자: {{ authStore.user?.member_name || '—' }} ({{ authStore.user?.access_level || '—' }})</p>
          <form v-if="authStore.isAdmin" class="settings-form" @submit.prevent="saveSettingsForm">
            <label>트럭 목표 상자<input v-model.number="settingsForm.truckTargetBoxes" type="number" min="1" /></label>
            <label>성수기 배수<input v-model.number="settingsForm.winterPeakMultiplier" type="number" min="0.1" step="0.1" /></label>
            <label>영수증 상호<input v-model="settingsForm.receiptCompany" type="text" /></label>
            <label>영수증 주소<input v-model="settingsForm.receiptAddress" type="text" /></label>
            <label>영수증 안내<input v-model="settingsForm.receiptNotice" type="text" /></label>
            <label>영수증 행수<input v-model.number="settingsForm.receiptRowsPerPage" type="number" min="1" /></label>
            <label class="master-check">
              <input v-model="settingsForm.alertOnIndividualOut" type="checkbox" />
              낱개 출고 시 경고
            </label>
            <fieldset class="settings-wh">
              <legend>활성 서브창고</legend>
              <label v-for="code in SUB_WAREHOUSES" :key="code" class="master-check">
                <input type="checkbox" :value="code" v-model="settingsForm.activeSubWarehouses" />
                {{ code }}
              </label>
            </fieldset>
            <button type="submit" :disabled="settingsSaving">설정 저장</button>
          </form>
          <p v-else>설정 변경은 관리자만 할 수 있습니다. 서버 세션은 12시간 후 만료됩니다.</p>
          <p>이전 HTML 화면이 필요하면 <a href="/wms.html">/wms.html</a> 을 여세요.</p>
          <p v-if="settingsStatus">{{ settingsStatus }}</p>
        </div>
      </section>

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
        <div class="workspace-right" :class="{ 'inbound-mode': transactionMode === 'inbound', 'move-mode': transactionMode === 'move' }">
          
          <!-- 📍 우측 상단 다중 탭 (이름 옆에 X 삭제 버튼 추가 규칙 반영) -->
          <div class="tabs-control-header" :class="{ 'inbound-mode': transactionMode === 'inbound', 'move-mode': transactionMode === 'move' }">
            <div class="tabs-list">
              <div 
                v-for="tab in tabList" 
                :key="tab.id" 
                class="tab-wrapper-item"
                :class="{ 'active': activeTabId === tab.id, 'inbound-mode': transactionMode === 'inbound', 'move-mode': transactionMode === 'move' }"
              >
                <span class="tab-title-text" @click="activeTabId = tab.id">{{ tab.title }}</span>
                <!-- 탭 삭제 X 버튼 (첫 번째 탭은 안전상 삭제 불가 방어막 적용) -->
                <button v-if="tabList.length > 1" class="tab-close-x-btn" @click.stop="closeTab(tab.id)">×</button>
              </div>
            </div>
            <div class="tabs-header-actions">
              <span class="transaction-mode-label">{{ transactionModeLabel }}</span>
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
                  <option value="">-- 입고처 선택 (총 {{ activeSuppliers.length }}개) --</option>
                  <option v-for="s in activeSuppliers" :key="s.id" :value="s.name">{{ s.name }}</option>
                </select>
              </div>
              <div class="master-lock-group" v-else>
                <label>{{ transactionMode === 'move' ? '🔄 도착 지점:' : '🚚 출고처 지점:' }}</label>
                <select v-model="currentTab.selectedDestination" :disabled="!canEditMasterFields">
                  <option value="">-- {{ transactionMode === 'move' ? '도착지점' : '출고처' }} 선택 (총 {{ activeDestinations.length }}개) --</option>
                  <option v-for="d in activeDestinations" :key="d.id" :value="d.name">{{ d.name }}</option>
                </select>
              </div>
              <div class="master-lock-group">
                <label>👤 입력 담당자:</label>
                <select v-model="currentTab.selectedManager" :disabled="!canEditMasterFields">
                  <option value="">-- 담당자 선택 --</option>
                  <option v-for="m in activeManagers" :key="m.id" :value="m.member_name">
                    {{ m.member_name }} ({{ m.branch_name || '지점' }})
                  </option>
                </select>
              </div>
            </div>

            <!-- 현행 주문 전표 테이블 -->
            <table class="pos-cart-table">
              <thead>
                <tr><th>품명(컬러)</th><th colspan="2">{{ qtyInputLabel }} 입력</th><th>총 수량</th></tr>
                <tr class="sub-th"><th></th><th>Caja</th><th>Pza</th><th></th></tr>
              </thead>
              <tbody>
                <tr v-for="item in currentTab.cartItems" :key="item.id">
                  <td class="product-cell">
                    <div class="p-name">{{ item.name }} ({{ item.color }})</div>
                    <div class="p-stock-info">{{ item.pack_qty }}入 · 재고: {{ item.stock_box }}B + {{ item.stock_each || 0 }}ea ({{ (Number(item.stock_box)||0) * (Number(item.pack_qty)||1) + (Number(item.stock_each)||0) }}개)</div>
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
              <div class="summary-label-box">
                Σ 환산 총수량: <strong>{{ currentTabSummary.pieces }} 개</strong>
              </div>
            </div>
            
            <div class="action-btn-double-group">
              <button
                class="btn-outbound-reserve"
                :disabled="wmsStore.isSubmitting || transactionMode !== 'outbound'"
                @click="triggerAction('reserve')"
              >출고 예약 버튼</button>
              <button
                class="btn-final-submit"
                :disabled="wmsStore.isSubmitting"
                @click="triggerAction('submit')"
              >{{ wmsStore.isSubmitting ? '처리 중…' : '제출 버튼' }}</button>
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
import { ref, computed, watch, onMounted, onUnmounted } from 'vue'
import { useRouter } from 'vue-router'
import { useAuthStore } from '../stores/auth.js'
import { useWmsStore } from '../stores/wms.js'
import { resolveBranchCode, SUB_WAREHOUSES } from '../lib/supabaseAdapter.js'
import TruckGaugeBar from './TruckGaugeBar.vue'
import ProductRegistrationPanel from './ProductRegistrationPanel.vue'
import SearchEditPanel from './SearchEditPanel.vue'

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

const handleLogout = async () => {
  await authStore.logout()
  router.push('/login')
}

const searchQuery = ref('')
const newPartnerName = ref('')
const newPartnerWarehouse = ref('')
const newPartnerIsBranch = ref(false)
const newMemberName = ref('')
const newMemberPassword = ref('')
const newMemberBranch = ref('')
const newMemberLevel = ref('staff')
const editingPartnerId = ref('')
const editPartnerName = ref('')
const editPartnerWarehouse = ref('')
const editPartnerIsBranch = ref(false)
const editingMemberId = ref('')
const editMemberBranch = ref('')
const editMemberLevel = ref('staff')
const editMemberPassword = ref('')
const settingsSaving = ref(false)
const settingsStatus = ref('')
const settingsForm = ref({
  truckTargetBoxes: 100,
  winterPeakMultiplier: 1.3,
  alertOnIndividualOut: true,
  receiptCompany: '',
  receiptAddress: '',
  receiptNotice: '',
  receiptRowsPerPage: 15,
  activeSubWarehouses: [...SUB_WAREHOUSES]
})
const activeSuppliers = computed(() => wmsStore.suppliers.filter(s => s.is_active !== false))
const activeDestinations = computed(() => wmsStore.destinations.filter(d => d.is_active !== false))
const activeManagers = computed(() => wmsStore.managers.filter(m => m.is_active !== false))
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
const isPosWorkspace = computed(() => ['home', 'outbound', 'inbound', 'move'].includes(activeNav.value))

const transactionModeLabel = computed(() => {
  if (transactionMode.value === 'inbound') return '입고 입력'
  if (transactionMode.value === 'move') return '재고 이동'
  return '출고 입력'
})

const qtyInputLabel = computed(() => {
  if (transactionMode.value === 'inbound') return '입고량'
  if (transactionMode.value === 'move') return '이동량'
  return '출고량'
})

const masterPanelTitle = computed(() => ({
  supplier: '입고처',
  destination: '출고처',
  manager: '담당자',
  report: '리포트',
  reservation: '예약상황',
  'search-edit': '입출고 검색수정',
  settings: '설정',
}[activeNav.value] || '마스터'))

const masterPanelHint = computed(() => ({
  supplier: '입고 전표에서 선택하는 공급처 목록입니다.',
  destination: '출고·이동 전표에서 선택하는 도착지 목록입니다.',
  manager: '전표 담당자로 선택되는 작업자 목록입니다.',
  report: '현재 세션에서 로드된 마스터·재고 요약입니다.',
  reservation: 'MAIN 출고 예약 및 이동 중 주문입니다.',
  'search-edit': '기존 전표를 찾아 수량·품목을 수정합니다. 저장 시 재고가 원자적으로 다시 반영됩니다.',
  settings: '트럭 목표 상자와 영수증 문구를 서버에 저장합니다.',
}[activeNav.value] || ''))

const setTransactionMode = (mode) => {
  if (mode === 'home') {
    transactionMode.value = 'outbound'
    activeNav.value = 'home'
    return
  }
  transactionMode.value = mode
  activeNav.value = mode
}

const setActiveNav = (nav) => {
  activeNav.value = nav
}

watch(activeNav, (nav) => {
  if (nav === 'reservation') {
    wmsStore.loadPendingOrders().catch(() => {})
  }
  if (nav === 'report') {
    wmsStore.loadDashboard().catch(() => {})
  }
  if (nav === 'settings') {
    loadSettingsForm().catch(() => {})
  }
})

const addPartner = async (role) => {
  const name = newPartnerName.value.trim()
  if (!name) {
    alert('이름을 입력하세요.')
    return
  }
  try {
    await wmsStore.upsertPartner({
      name,
      role: newPartnerIsBranch.value && role === 'OUTBOUND' ? 'BRANCH' : role,
      warehouseCode: newPartnerWarehouse.value || null
    })
    newPartnerName.value = ''
    newPartnerWarehouse.value = ''
    newPartnerIsBranch.value = false
  } catch (err) {
    alert(`저장 실패: ${err.message}`)
  }
}

const addMember = async () => {
  if (!newMemberName.value.trim() || !newMemberPassword.value) {
    alert('아이디와 비밀번호를 입력하세요.')
    return
  }
  try {
    await wmsStore.createMember({
      memberName: newMemberName.value,
      password: newMemberPassword.value,
      accessLevel: newMemberLevel.value,
      branchName: newMemberBranch.value
    })
    newMemberName.value = ''
    newMemberPassword.value = ''
    newMemberBranch.value = ''
    newMemberLevel.value = 'staff'
  } catch (err) {
    alert(`저장 실패: ${err.message}`)
  }
}

const partnerRoleOf = (partner, fallback) => {
  if (partner.is_branch) return 'BRANCH'
  if (partner.partner_type === 'BOTH') return 'BOTH'
  return fallback
}

const startPartnerEdit = (partner, fallbackRole) => {
  editingPartnerId.value = partner.id
  editPartnerName.value = partner.name
  editPartnerWarehouse.value = partner.warehouse_code || ''
  editPartnerIsBranch.value = Boolean(partner.is_branch)
}

const cancelPartnerEdit = () => {
  editingPartnerId.value = ''
  editPartnerName.value = ''
  editPartnerWarehouse.value = ''
  editPartnerIsBranch.value = false
}

const savePartnerEdit = async (fallbackRole) => {
  const partner = [...wmsStore.suppliers, ...wmsStore.destinations].find(p => p.id === editingPartnerId.value)
  if (!partner) return
  try {
    await wmsStore.upsertPartner({
      id: partner.id,
      name: editPartnerName.value.trim() || partner.name,
      role: fallbackRole === 'OUTBOUND'
        ? (editPartnerIsBranch.value ? 'BRANCH' : 'OUTBOUND')
        : 'INBOUND',
      warehouseCode: editPartnerWarehouse.value || null,
      isActive: partner.is_active !== false
    })
    cancelPartnerEdit()
  } catch (err) {
    alert(`저장 실패: ${err.message}`)
  }
}

const togglePartnerActive = async (partner, fallbackRole) => {
  try {
    await wmsStore.upsertPartner({
      id: partner.id,
      name: partner.name,
      role: partnerRoleOf(partner, fallbackRole),
      warehouseCode: partner.warehouse_code || null,
      isActive: partner.is_active === false
    })
  } catch (err) {
    alert(`상태 변경 실패: ${err.message}`)
  }
}

const startMemberEdit = (member) => {
  editingMemberId.value = member.id
  editMemberBranch.value = member.branch_name || ''
  editMemberLevel.value = member.access_level || 'staff'
  editMemberPassword.value = ''
}

const cancelMemberEdit = () => {
  editingMemberId.value = ''
  editMemberBranch.value = ''
  editMemberLevel.value = 'staff'
  editMemberPassword.value = ''
}

const saveMemberEdit = async () => {
  try {
    await wmsStore.updateMember({
      id: editingMemberId.value,
      branchName: editMemberBranch.value,
      accessLevel: editMemberLevel.value,
      password: editMemberPassword.value
    })
    cancelMemberEdit()
  } catch (err) {
    alert(`저장 실패: ${err.message}`)
  }
}

const toggleMemberActive = async (member) => {
  try {
    await wmsStore.updateMember({
      id: member.id,
      branchName: member.branch_name,
      accessLevel: member.access_level,
      isActive: member.is_active === false
    })
  } catch (err) {
    alert(`상태 변경 실패: ${err.message}`)
  }
}

const loadSettingsForm = async () => {
  const loaded = await wmsStore.loadSettings()
  settingsForm.value = {
    truckTargetBoxes: Number(loaded.truckTargetBoxes || 100),
    winterPeakMultiplier: Number(loaded.winterPeakMultiplier || 1.3),
    alertOnIndividualOut: loaded.alertOnIndividualOut !== false,
    receiptCompany: loaded.receiptCompany || '',
    receiptAddress: loaded.receiptAddress || '',
    receiptNotice: loaded.receiptNotice || '',
    receiptRowsPerPage: Number(loaded.receiptRowsPerPage || 15),
    activeSubWarehouses: Array.isArray(loaded.activeSubWarehouses) ? [...loaded.activeSubWarehouses] : [...SUB_WAREHOUSES]
  }
}

const saveSettingsForm = async () => {
  settingsSaving.value = true
  settingsStatus.value = ''
  try {
    await wmsStore.saveSettings(settingsForm.value)
    settingsStatus.value = '설정을 저장했습니다. 트럭 목표 상자는 서브창고 게이지에 반영됩니다.'
  } catch (err) {
    settingsStatus.value = `저장 실패: ${err.message}`
  } finally {
    settingsSaving.value = false
  }
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
  if (!currentTab.value) return { boxes: 0, eaches: 0, pieces: 0 }
  let boxes = 0
  let eaches = 0
  let pieces = 0
  currentTab.value.cartItems.forEach(item => {
    const box = Number(item.input_box) || 0
    const each = Number(item.input_each) || 0
    const pack = Number(item.pack_qty) || 1
    boxes += box
    eaches += each
    pieces += (box * pack) + each
  })
  return { boxes, eaches, pieces }
})

// 실재고 기반 Top 10 핫키 표시
const displayedSingleHotkeys = computed(() => wmsStore.hotkeyItems || [])
const gridHotkeys = computed(() => wmsStore.gridHotkeys || [])

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
  activeGroup.value = {
    ...group,
    variants: (group.variants || []).map(v => ({ ...v, input_box: '', input_each: '' }))
  }
  isGridModalOpen.value = true
}

const submitGridSelection = () => {
  if (!currentTab.value || !activeGroup.value) return
  activeGroup.value.variants.forEach(v => {
    if ((Number(v.input_box) || 0) > 0 || (Number(v.input_each) || 0) > 0) {
      currentTab.value.cartItems.push({
        id: v.id,
        name: activeGroup.value.group_name,
        color: v.color,
        pack_qty: v.pack_qty || activeGroup.value.pack_qty,
        stock_box: v.stock_box,
        stock_each: v.stock_each,
        input_box: Number(v.input_box) || 0,
        input_each: Number(v.input_each) || 0
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

  if (wmsStore.isSubmitting) {
    alert('이미 전표 처리가 진행 중입니다. 완료될 때까지 기다려주세요.')
    return
  }

  if (actionType === 'reserve') {
    if (transactionMode.value !== 'outbound') {
      alert('출고 예약은 출고 입력 모드에서만 사용할 수 있습니다.')
      return
    }
    const partnerName = currentTab.value.selectedDestination || '일반 출고처'
    const handlerName = currentTab.value.selectedManager || authStore.user?.member_name || '관리자'
    try {
      const res = await wmsStore.reserveOutbound({
        partnerName,
        handlerName,
        cartItems: currentTab.value.cartItems
      })
      alert(`[예약 완료] ${currentTab.value.title}\n${res.count}건이 pending_orders에 등록되었습니다.`)
      currentTab.value.cartItems = []
    } catch (err) {
      alert(`예약 실패: ${err.message}`)
    }
    return
  }

  const mode = transactionMode.value
  const isInbound = mode === 'inbound'
  const isMove = mode === 'move'
  const partnerName = isInbound
    ? (currentTab.value.selectedSupplier || '일반 입고처')
    : (currentTab.value.selectedDestination || (isMove ? '이동 도착지점' : '일반 출고처'))

  const handlerName = currentTab.value.selectedManager || authStore.user?.member_name || '관리자'
  const destCode = (!isInbound && partnerName) ? resolveBranchCode(partnerName) : null

  if (isMove && !destCode) {
    alert('재고 이동은 도착 지점을 선택해야 합니다.')
    return
  }

  try {
    const res = await wmsStore.submitTransaction({
      transactionType: isMove ? 'MOVE' : (isInbound ? 'INBOUND' : 'OUTBOUND'),
      warehouseCode: 'MAIN',
      partnerName,
      handlerName,
      cartItems: currentTab.value.cartItems,
      targetWarehouse: isMove ? destCode : undefined
    })

    const doneType = res?.txType || (isMove ? 'MOVE' : (isInbound ? 'INBOUND' : 'OUTBOUND'))
    const label = doneType === 'MOVE' ? '이동' : (isInbound ? '입고' : '출고')
    alert(`[${label} 완료] ${currentTab.value.title}\n전표: ${res?.invoiceNo || '-'}`)
    currentTab.value.cartItems = []
  } catch (err) {
    alert(`❌ 처리 실패: ${err.message}`)
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
.tabs-control-header.move-mode { background: #e0f2fe; border-bottom-color: #7dd3fc; }
.tabs-list { display: flex; gap: 4px; }
.tab-wrapper-item { display: flex; align-items: center; gap: 6px; background: #e2e8f0; border: 1px solid #cbd5e1; border-bottom: none; padding: 8px 12px; border-radius: 6px 6px 0 0; font-size: 12.5px; font-weight: bold; cursor: pointer; color: #64748b; position: relative; }
.tab-wrapper-item.inbound-mode { background: #fbcfe8; border-color: #f9a8d4; }
.tab-wrapper-item.move-mode { background: #bae6fd; border-color: #7dd3fc; }
.tab-wrapper-item.active { background: white; color: #00a896; border-color: #cbd5e1; border-bottom-color: white; margin-bottom: -1px; }
.tab-wrapper-item.inbound-mode.active { background: #fff1f2; color: #db2777; border-color: #f9a8d4; border-bottom-color: #fff1f2; }
.tab-wrapper-item.move-mode.active { background: #f0f9ff; color: #0369a1; border-color: #7dd3fc; border-bottom-color: #f0f9ff; }
.tab-title-text { cursor: pointer; }
.tab-close-x-btn { background: none; border: none; font-size: 14px; font-weight: bold; color: #94a3b8; cursor: pointer; padding: 0 2px; line-height: 1; border-radius: 50%; }
.tab-close-x-btn:hover { background: #ef4444; color: white; }
.tabs-header-actions { display: flex; align-items: center; gap: 10px; padding-bottom: 6px; }
.transaction-mode-label { font-size: 13px; font-weight: bold; color: #00a896; white-space: nowrap; }
.inbound-mode .transaction-mode-label { color: #db2777; }
.move-mode .transaction-mode-label { color: #0369a1; }
.add-tab-action-btn { background: none; border: none; color: #00a896; font-weight: bold; cursor: pointer; font-size: 13px; }
.inbound-mode .add-tab-action-btn { color: #db2777; }
.move-mode .add-tab-action-btn { color: #0369a1; }
.workspace-right.inbound-mode { background: #fff1f2; border-color: #f9a8d4; }
.workspace-right.move-mode { background: #f0f9ff; border-color: #7dd3fc; }

.master-panel {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 20px 24px 32px;
  background: #f4f6f9;
}
.master-panel-header h2 { margin: 0 0 4px; font-size: 20px; color: #1e293b; }
.master-panel-header p { margin: 0 0 16px; font-size: 13px; color: #64748b; }
.master-table-wrap { background: white; border-radius: 8px; border: 1px solid #e2e8f0; overflow: auto; }
.master-table { width: 100%; border-collapse: collapse; font-size: 13px; }
.master-table th, .master-table td { padding: 10px 12px; border-bottom: 1px solid #e2e8f0; text-align: left; }
.master-table th { background: #f8fafc; color: #475569; font-size: 12px; }
.master-stats { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 12px; }
.stat-card { background: white; border: 1px solid #e2e8f0; border-radius: 8px; padding: 16px; }
.stat-card span { display: block; font-size: 12px; color: #64748b; }
.stat-card strong { display: block; margin-top: 6px; font-size: 22px; color: #0f172a; }
.master-cta { background: white; border: 1px solid #e2e8f0; border-radius: 8px; padding: 20px; }
.master-link-btn { display: inline-block; margin-top: 8px; padding: 8px 14px; background: #0ea5e9; color: white; border-radius: 6px; text-decoration: none; font-size: 13px; font-weight: bold; }
.master-add-form { display: flex; flex-wrap: wrap; gap: 8px; padding: 12px; background: #f8fafc; border-bottom: 1px solid #e2e8f0; align-items: center; }
.master-add-form input, .master-add-form select { padding: 8px; border: 1px solid #cbd5e1; border-radius: 4px; font-size: 13px; }
.master-add-form button { padding: 8px 12px; background: #0ea5e9; color: white; border: none; border-radius: 4px; font-weight: bold; cursor: pointer; }
.master-check { font-size: 12px; color: #475569; display: flex; gap: 4px; align-items: center; }
.row-mini { margin-right: 4px; padding: 4px 8px; border: none; border-radius: 4px; background: #0ea5e9; color: white; font-size: 12px; cursor: pointer; }
.row-mini.ghost { background: #e2e8f0; color: #334155; }
.settings-panel { background: white; border: 1px solid #e2e8f0; border-radius: 8px; padding: 20px; display: flex; flex-direction: column; gap: 12px; }
.settings-form { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 10px; }
.settings-form label { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: #475569; }
.settings-form input[type="text"], .settings-form input[type="number"] { padding: 8px; border: 1px solid #cbd5e1; border-radius: 4px; }
.settings-form button { grid-column: 1 / -1; justify-self: start; padding: 8px 14px; background: #0ea5e9; color: white; border: none; border-radius: 4px; font-weight: bold; cursor: pointer; }
.settings-wh { grid-column: 1 / -1; display: flex; flex-wrap: wrap; gap: 8px; border: 1px solid #e2e8f0; padding: 8px; }
.search-edit-native { background: transparent; }
.report-panel { display: flex; flex-direction: column; gap: 16px; }
.report-sub { margin: 8px 0 0; font-size: 14px; color: #334155; }
.search-edit-frame-wrap { flex: 1; min-height: 0; background: white; border-radius: 8px; overflow: hidden; border: 1px solid #e2e8f0; }
.search-edit-frame { width: 100%; height: calc(100vh - 160px); border: 0; }

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
.truck-counter-info-grid { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 10px; }
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
