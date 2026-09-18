<template>
  <div class="search-edit-panel">
    <form class="search-edit-bar" @submit.prevent="runSearch">
      <label>
        유형
        <select v-model="txType">
          <option value="inbound">입고</option>
          <option value="outbound">출고/이동</option>
          <option value="adj">재고조정</option>
        </select>
      </label>
      <label>
        날짜
        <input v-model="bizDate" type="date" />
      </label>
      <label>
        전표번호
        <input v-model="invoiceQuery" type="text" placeholder="비우면 당일 목록" />
      </label>
      <button type="submit" :disabled="busy">검색</button>
    </form>

    <p v-if="errorMessage" class="search-edit-error">{{ errorMessage }}</p>
    <p v-if="statusMessage" class="search-edit-ok">{{ statusMessage }}</p>

    <div v-if="invoiceList.length && !loadedInvoice" class="master-table-wrap">
      <table class="master-table">
        <thead>
          <tr>
            <th>전표</th>
            <th>유형</th>
            <th>거래처</th>
            <th>담당</th>
            <th>행</th>
            <th>상자</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="inv in invoiceList" :key="inv.invoice_no">
            <td>{{ inv.invoice_no }}</td>
            <td>{{ inv.transaction_type }}</td>
            <td>{{ inv.partner_name || '—' }}</td>
            <td>{{ inv.handler_name || '—' }}</td>
            <td>{{ inv.lines }}</td>
            <td>{{ inv.boxes }}</td>
            <td><button type="button" class="row-btn" @click="openInvoice(inv.invoice_no)">열기</button></td>
          </tr>
        </tbody>
      </table>
    </div>

    <div v-if="loadedInvoice" class="search-edit-editor">
      <header class="search-edit-editor-head">
        <strong>{{ loadedInvoice }}</strong>
        <span>{{ loadedType }}</span>
        <button type="button" class="row-btn ghost" @click="clearEditor">목록으로</button>
        <button type="button" class="row-btn danger" :disabled="busy" @click="deleteInvoice">전표 삭제</button>
        <button type="button" class="row-btn primary" :disabled="busy" @click="saveInvoice">저장</button>
      </header>

      <div class="search-edit-add">
        <input
          v-model="addQuery"
          type="text"
          placeholder="품명 검색 후 행 추가"
          @input="onAddSearch"
        />
        <div v-if="wmsStore.searchResults.length" class="search-dropdown-list">
          <button
            v-for="item in wmsStore.searchResults"
            :key="item.id"
            type="button"
            class="search-result-row"
            @click="addLine(item)"
          >
            {{ item.name }} ({{ item.color }}) · {{ item.pack_qty }}入
          </button>
        </div>
      </div>

      <table class="master-table">
        <thead>
          <tr>
            <th>품명</th>
            <th>색상</th>
            <th>입수</th>
            <th>상자</th>
            <th>낱개</th>
            <th>거래처</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(row, idx) in lines" :key="row.item_id + '-' + idx">
            <td>{{ row.itemName }}</td>
            <td>{{ row.color }}</td>
            <td>{{ row.boxContent }}</td>
            <td><input v-model.number="row.boxQty" type="number" min="0" class="qty-input" /></td>
            <td><input v-model.number="row.individualQty" type="number" min="0" class="qty-input" /></td>
            <td><input v-model="row.location" type="text" class="partner-input" /></td>
            <td><button type="button" class="row-btn ghost" @click="lines.splice(idx, 1)">삭제</button></td>
          </tr>
          <tr v-if="!lines.length">
            <td colspan="7">행이 없습니다. 저장하면 전표가 삭제됩니다.</td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

<script setup>
import { ref } from 'vue'
import { useAuthStore } from '../stores/auth.js'
import { useWmsStore } from '../stores/wms.js'
import { serverMethods } from '../lib/supabaseAdapter.js'

const authStore = useAuthStore()
const wmsStore = useWmsStore()

const today = new Date()
const pad = (n) => String(n).padStart(2, '0')
const txType = ref('outbound')
const bizDate = ref(`${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`)
const invoiceQuery = ref('')
const invoiceList = ref([])
const loadedInvoice = ref('')
const loadedType = ref('')
const lines = ref([])
const busy = ref(false)
const errorMessage = ref('')
const statusMessage = ref('')
const addQuery = ref('')
let addTimer = null

const onAddSearch = () => {
  clearTimeout(addTimer)
  addTimer = setTimeout(() => wmsStore.searchItems(addQuery.value), 180)
}

const addLine = (item) => {
  lines.value.push({
    item_id: item.id,
    itemName: item.name,
    color: item.color,
    boxContent: item.pack_qty,
    boxQty: 1,
    individualQty: 0,
    location: lines.value[0]?.location || ''
  })
  addQuery.value = ''
  wmsStore.searchResults = []
}

const clearEditor = () => {
  loadedInvoice.value = ''
  loadedType.value = ''
  lines.value = []
}

const openInvoice = async (invoiceNo) => {
  errorMessage.value = ''
  statusMessage.value = ''
  busy.value = true
  try {
    const rows = await serverMethods.searchRecords(txType.value, invoiceNo)
    if (!rows.length) {
      loadedInvoice.value = ''
      lines.value = []
      return
    }
    loadedInvoice.value = invoiceNo
    loadedType.value = txType.value
    lines.value = rows.map(r => ({ ...r }))
    invoiceList.value = []
  } catch (err) {
    errorMessage.value = err.message || '전표를 열 수 없습니다.'
  } finally {
    busy.value = false
  }
}

const runSearch = async () => {
  errorMessage.value = ''
  statusMessage.value = ''
  clearEditor()
  busy.value = true
  try {
    if (invoiceQuery.value.trim()) {
      await openInvoice(invoiceQuery.value.trim())
      if (!lines.value.length) errorMessage.value = '해당 전표를 찾지 못했습니다.'
      return
    }
    invoiceList.value = await serverMethods.listInvoices(txType.value, bizDate.value)
    if (!invoiceList.value.length) statusMessage.value = '해당 날짜의 전표가 없습니다.'
  } catch (err) {
    errorMessage.value = err.message || '검색 실패'
  } finally {
    busy.value = false
  }
}

const saveInvoice = async () => {
  if (!loadedInvoice.value) return
  if (!confirm(`${loadedInvoice.value} 전표를 수정할까요?`)) return
  busy.value = true
  errorMessage.value = ''
  try {
    const res = await serverMethods.updatePendingRecords(
      loadedInvoice.value,
      loadedType.value,
      lines.value,
      authStore.user?.member_name || 'ADMIN'
    )
    statusMessage.value = res?.message || '전표가 수정되었습니다.'
    await openInvoice(loadedInvoice.value)
  } catch (err) {
    errorMessage.value = err.message || '저장 실패'
  } finally {
    busy.value = false
  }
}

const deleteInvoice = async () => {
  if (!loadedInvoice.value) return
  if (!confirm(`${loadedInvoice.value} 전표를 삭제할까요? 재고가 롤백됩니다.`)) return
  busy.value = true
  errorMessage.value = ''
  try {
    const res = await serverMethods.updatePendingRecords(
      loadedInvoice.value,
      loadedType.value,
      [],
      authStore.user?.member_name || 'ADMIN'
    )
    statusMessage.value = res?.message || '전표가 삭제되었습니다.'
    clearEditor()
    invoiceList.value = await serverMethods.listInvoices(txType.value, bizDate.value)
  } catch (err) {
    errorMessage.value = err.message || '삭제 실패'
  } finally {
    busy.value = false
  }
}
</script>

<style scoped>
.search-edit-panel { display: flex; flex-direction: column; gap: 12px; }
.search-edit-bar { display: flex; flex-wrap: wrap; gap: 8px; align-items: end; background: white; padding: 12px; border: 1px solid #e2e8f0; border-radius: 8px; }
.search-edit-bar label { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: #475569; }
.search-edit-bar input, .search-edit-bar select { padding: 8px; border: 1px solid #cbd5e1; border-radius: 4px; min-width: 140px; }
.search-edit-bar button, .row-btn { padding: 8px 12px; border: none; border-radius: 4px; background: #0ea5e9; color: white; font-weight: bold; cursor: pointer; }
.row-btn.ghost { background: #e2e8f0; color: #334155; }
.row-btn.danger { background: #ef4444; }
.row-btn.primary { background: #0ea5e9; }
.search-edit-error { color: #b91c1c; margin: 0; }
.search-edit-ok { color: #047857; margin: 0; }
.search-edit-editor { background: white; border: 1px solid #e2e8f0; border-radius: 8px; padding: 12px; display: flex; flex-direction: column; gap: 10px; }
.search-edit-editor-head { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.search-edit-add { position: relative; }
.search-edit-add input { width: 100%; padding: 8px; border: 1px solid #cbd5e1; border-radius: 4px; box-sizing: border-box; }
.search-dropdown-list { position: absolute; z-index: 5; left: 0; right: 0; background: white; border: 1px solid #cbd5e1; border-radius: 4px; max-height: 220px; overflow: auto; }
.search-result-row { display: block; width: 100%; text-align: left; padding: 8px 10px; border: none; background: white; cursor: pointer; }
.search-result-row:hover { background: #f1f5f9; }
.qty-input { width: 72px; padding: 4px; }
.partner-input { width: 140px; padding: 4px; }
.master-table-wrap { background: white; border-radius: 8px; border: 1px solid #e2e8f0; overflow: auto; }
.master-table { width: 100%; border-collapse: collapse; font-size: 13px; }
.master-table th, .master-table td { padding: 8px 10px; border-bottom: 1px solid #e2e8f0; text-align: left; }
.master-table th { background: #f8fafc; }
</style>
