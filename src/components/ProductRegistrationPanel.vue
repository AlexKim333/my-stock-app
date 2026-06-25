<template>
  <div class="product-registration-zone">
    <header class="product-reg-header">
      <h2>📦 상품등록</h2>
      <p class="product-reg-subtitle">복합 키 검증 · 바코드 중복 허용 · 그리드 자동 판별</p>
    </header>

    <div v-if="!isSupabaseConfigured" class="config-warning">
      `.env` 파일에 `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`를 설정한 뒤 개발 서버를 재시작하세요.
    </div>

    <form class="product-reg-form" @submit.prevent="saveProduct">
      <div class="form-grid">
        <label class="form-field">
          <span>품명 (item_name) *</span>
          <input v-model="form.item_name" type="text" required placeholder="예: P-160" />
        </label>
        <label class="form-field">
          <span>컬러 (color) *</span>
          <input v-model="form.color" type="text" required placeholder="예: NEGRO" />
        </label>
        <label class="form-field">
          <span>브랜드 *</span>
          <v-select
            v-model="form.brand_id"
            :items="brands"
            item-title="name"
            item-value="id"
            placeholder="브랜드 선택"
            density="compact"
            variant="outlined"
            hide-details
            :loading="brandsLoading"
            clearable
          >
            <template #append-item>
              <v-divider class="brand-create-divider" />
              <v-list-item
                class="brand-create-item"
                title="+ 새 브랜드 추가 (Crear Marca)"
                @click="openBrandDialog"
              />
            </template>
          </v-select>
        </label>
        <label class="form-field barcode-field">
          <span>바코드 / QR (barcode)</span>
          <input
            ref="barcodeInputRef"
            v-model="form.barcode"
            type="text"
            placeholder="스캐너 입력"
            @keydown.enter.prevent="saveProduct"
          />
        </label>
        <label class="form-field">
          <span>박스당 수량 (box_packaging_qty) *</span>
          <input v-model.number="form.box_packaging_qty" type="number" min="1" required placeholder="50" />
        </label>
        <label class="form-field">
          <span>기초 박스 재고</span>
          <input v-model.number="form.initial_stock_boxes" type="number" min="0" placeholder="0" />
        </label>
        <label class="form-field">
          <span>기초 낱개 재고</span>
          <input v-model.number="form.initial_stock_units" type="number" min="0" placeholder="0" />
        </label>
      </div>

      <div class="form-actions">
        <button type="submit" class="btn-save" :disabled="isSaving || !isSupabaseConfigured">
          {{ isSaving ? '저장 중…' : '상품 저장' }}
        </button>
        <button type="button" class="btn-reset" @click="resetForm">입력 초기화</button>
      </div>
    </form>

    <section class="product-list-section">
      <div class="list-header">
        <h3>등록 상품 모니터링</h3>
        <button type="button" class="btn-refresh" @click="loadItems" :disabled="itemsLoading">새로고침</button>
      </div>

      <div v-if="itemsLoading" class="list-empty">목록 불러오는 중…</div>
      <div v-else-if="registeredItems.length === 0" class="list-empty">등록된 상품이 없습니다.</div>

      <table v-else class="product-monitor-table">
        <thead>
          <tr>
            <th>품목코드</th>
            <th>품명</th>
            <th>컬러</th>
            <th>브랜드</th>
            <th>바코드</th>
            <th>박스당</th>
            <th>박스재고</th>
            <th>낱개재고</th>
            <th>그리드</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="item in registeredItems" :key="item.id">
            <td class="mono">{{ item.item_code ?? '—' }}</td>
            <td>{{ item.item_name }}</td>
            <td>{{ item.color ?? '—' }}</td>
            <td>{{ item.brands?.name ?? '—' }}</td>
            <td class="mono">{{ item.barcode ?? '—' }}</td>
            <td>{{ item.box_packaging_qty ?? '—' }}</td>
            <td>{{ item.initial_stock_boxes ?? 0 }}</td>
            <td>{{ item.initial_stock_units ?? 0 }}</td>
            <td class="grid-icon-cell">
              <span
                class="grid-badge"
                :class="item.is_grid_item ? 'grid-yes' : 'grid-no'"
                :title="item.is_grid_item ? '그리드 품목 (변형)' : '단일 품목'"
              >
                {{ item.is_grid_item ? '🌐 Grid' : '📦 Single' }}
              </span>
            </td>
          </tr>
        </tbody>
      </table>
    </section>

    <v-snackbar v-model="snackbar.show" :color="snackbar.color" :timeout="4500" location="top">
      {{ snackbar.message }}
      <template #actions>
        <v-btn variant="text" @click="snackbar.show = false">닫기</v-btn>
      </template>
    </v-snackbar>

    <!-- 브랜드 즉시 추가 (Crear Marca) — 상품 등록 핵심 로직과 분리 -->
    <v-dialog v-model="brandDialog" max-width="440" persistent>
      <v-card class="brand-dialog-card">
        <v-card-title class="brand-dialog-title">
          + Crear Marca
        </v-card-title>
        <v-card-subtitle class="brand-dialog-subtitle">
          새 브랜드를 등록하면 목록에 즉시 반영됩니다.
        </v-card-subtitle>
        <v-card-text>
          <v-text-field
            ref="brandNameInputRef"
            v-model="newBrandName"
            label="브랜드 이름 (name)"
            placeholder="예: MARCA-A"
            variant="outlined"
            density="compact"
            hide-details="auto"
            autofocus
            @keydown.enter.prevent="saveNewBrand"
          />
        </v-card-text>
        <v-card-actions class="brand-dialog-actions">
          <v-btn variant="text" :disabled="isBrandSaving" @click="closeBrandDialog">Cancelar</v-btn>
          <v-btn color="primary" variant="flat" :loading="isBrandSaving" @click="saveNewBrand">
            Guardar
          </v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </div>
</template>

<script setup>
import { ref, onMounted, nextTick } from 'vue'
import { isSupabaseConfigured, supabase } from '../lib/supabase.js'

const DUPLICATE_MSG = '이미 등록된 [품명-컬러-포장수량] 조합입니다.'

const form = ref({
  item_name: '',
  color: '',
  brand_id: null,
  barcode: '',
  box_packaging_qty: null,
  initial_stock_boxes: 0,
  initial_stock_units: 0,
})

const brands = ref([])
const registeredItems = ref([])
const brandsLoading = ref(false)
const itemsLoading = ref(false)
const isSaving = ref(false)
const barcodeInputRef = ref(null)

/** Crear Marca 팝업 전용 상태 (상품 등록 핵심 로직과 분리) */
const brandDialog = ref(false)
const newBrandName = ref('')
const isBrandSaving = ref(false)
const brandNameInputRef = ref(null)

const snackbar = ref({
  show: false,
  message: '',
  color: 'error',
})

const showSnackbar = (message, color = 'error') => {
  snackbar.value = { show: true, message, color }
}

const focusBarcode = () => {
  nextTick(() => barcodeInputRef.value?.focus())
}

const resetForm = () => {
  form.value = {
    item_name: '',
    color: '',
    brand_id: null,
    barcode: '',
    box_packaging_qty: null,
    initial_stock_boxes: 0,
    initial_stock_units: 0,
  }
  focusBarcode()
}

const loadBrands = async (selectBrandId = null) => {
  if (!isSupabaseConfigured) return
  brandsLoading.value = true
  try {
    const { data, error } = await supabase
      .from('brands')
      .select('id, name')
      .eq('is_active', true)
      .order('name')
    if (error) throw error
    brands.value = data ?? []
    if (selectBrandId) {
      form.value.brand_id = selectBrandId
    }
  } catch (err) {
    showSnackbar(`브랜드 로드 실패: ${err.message}`)
  } finally {
    brandsLoading.value = false
  }
}

const openBrandDialog = () => {
  newBrandName.value = ''
  brandDialog.value = true
  nextTick(() => brandNameInputRef.value?.focus())
}

const closeBrandDialog = () => {
  brandDialog.value = false
  newBrandName.value = ''
}

const saveNewBrand = async () => {
  if (!isSupabaseConfigured) {
    showSnackbar('.env Supabase 설정이 필요합니다.')
    return
  }

  const trimmedName = newBrandName.value.trim()
  if (!trimmedName) {
    showSnackbar('브랜드 이름을 입력하세요.')
    return
  }

  isBrandSaving.value = true
  try {
    const { data, error } = await supabase
      .from('brands')
      .insert({ name: trimmedName, is_active: true })
      .select('id, name')
      .single()

    if (error) {
      showSnackbar(`브랜드 저장 실패: ${error.message}`)
      return
    }

    closeBrandDialog()
    await loadBrands(data.id)
    showSnackbar(`브랜드 "${data.name}" 등록 완료`, 'success')
  } catch (err) {
    showSnackbar(`오류: ${err.message}`)
  } finally {
    isBrandSaving.value = false
  }
}

const loadItems = async () => {
  if (!isSupabaseConfigured) return
  itemsLoading.value = true
  try {
    const { data, error } = await supabase
      .from('items')
      .select('id, item_code, item_name, color, barcode, box_packaging_qty, initial_stock_boxes, initial_stock_units, is_grid_item, created_at, brands(name)')
      .order('created_at', { ascending: false })
    if (error) throw error
    registeredItems.value = data ?? []
  } catch (err) {
    showSnackbar(`상품 목록 로드 실패: ${err.message}`)
  } finally {
    itemsLoading.value = false
  }
}

/** 복합 키 (품명+컬러+포장수량) 중복 검사 */
const checkCompositeDuplicate = async (itemName, color, boxPackagingQty) => {
  const { data, error } = await supabase
    .from('items')
    .select('id')
    .eq('item_name', itemName)
    .eq('color', color)
    .eq('box_packaging_qty', boxPackagingQty)
    .maybeSingle()
  if (error) throw error
  return Boolean(data)
}

const saveProduct = async () => {
  if (!isSupabaseConfigured) {
    showSnackbar('.env Supabase 설정이 필요합니다.')
    return
  }

  const itemName = form.value.item_name.trim()
  const color = form.value.color.trim()
  const boxPackagingQty = Number(form.value.box_packaging_qty)

  if (!itemName || !color || !Number.isFinite(boxPackagingQty) || boxPackagingQty < 1) {
    showSnackbar('품명, 컬러, 박스당 수량(1 이상)은 필수입니다.')
    return
  }

  isSaving.value = true
  try {
    // 중복 검사는 유지 (UX 시각적 피드백용)
    const isDuplicate = await checkCompositeDuplicate(itemName, color, boxPackagingQty)
    if (isDuplicate) {
      showSnackbar(DUPLICATE_MSG)
      return
    }

    // is_grid_item은 DB 트리거가 동일 품명 2건 이상 시 자동 true 처리
    const { error } = await supabase.from('items').insert({
      item_name: itemName,
      color,
      brand_id: form.value.brand_id || null,
      barcode: form.value.barcode.trim() || null,
      box_packaging_qty: boxPackagingQty,
      initial_stock_boxes: Number(form.value.initial_stock_boxes) || 0,
      initial_stock_units: Number(form.value.initial_stock_units) || 0,
      is_grid_item: false,
      is_active: true,
    })

    if (error) {
      if (error.code === '23505') {
        showSnackbar(DUPLICATE_MSG)
      } else {
        showSnackbar(`저장 실패: ${error.message}`)
      }
      return
    }

    showSnackbar(`저장 완료 — 시스템이 자동으로 그리드 여부를 판별하여 등록했습니다.`, 'success')
    resetForm()
    await loadItems()
  } catch (err) {
    showSnackbar(`오류: ${err.message}`)
  } finally {
    isSaving.value = false
    focusBarcode()
  }
}

onMounted(async () => {
  await Promise.all([loadBrands(), loadItems()])
  focusBarcode()
})
</script>

<style scoped>
.product-registration-zone {
  flex: 1;
  overflow-y: auto;
  padding: 20px 24px 32px;
  background: #f4f6f9;
}

.product-reg-header h2 {
  margin: 0 0 4px;
  font-size: 20px;
  color: #1e293b;
}

.product-reg-subtitle {
  margin: 0 0 20px;
  font-size: 13px;
  color: #64748b;
}

.config-warning {
  background: #fef3c7;
  border: 1px solid #f59e0b;
  color: #92400e;
  padding: 12px 16px;
  border-radius: 8px;
  margin-bottom: 16px;
  font-size: 13px;
}

.product-reg-form {
  background: white;
  border: 1px solid #e2e8f0;
  border-radius: 8px;
  padding: 20px;
  margin-bottom: 24px;
}

.form-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 16px;
}

.form-field {
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 12px;
  font-weight: bold;
  color: #64748b;
}

.form-field input {
  padding: 10px 12px;
  border: 1px solid #cbd5e1;
  border-radius: 6px;
  font-size: 14px;
  font-weight: normal;
  outline: none;
}

.form-field input:focus {
  border-color: #00a896;
  box-shadow: 0 0 0 2px rgba(0, 168, 150, 0.15);
}

.barcode-field input {
  background: #ecfdf5;
  border-color: #00a896;
  font-family: monospace;
  font-weight: bold;
}

.form-actions {
  display: flex;
  gap: 10px;
  margin-top: 20px;
}

.btn-save {
  background: #00a896;
  color: white;
  border: none;
  padding: 12px 28px;
  border-radius: 6px;
  font-weight: bold;
  cursor: pointer;
  font-size: 14px;
}

.btn-save:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.btn-reset {
  background: #f1f5f9;
  color: #475569;
  border: 1px solid #cbd5e1;
  padding: 12px 20px;
  border-radius: 6px;
  font-weight: bold;
  cursor: pointer;
}

.product-list-section {
  background: white;
  border: 1px solid #e2e8f0;
  border-radius: 8px;
  padding: 16px 20px 20px;
}

.list-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 12px;
}

.list-header h3 {
  margin: 0;
  font-size: 15px;
  color: #334155;
}

.btn-refresh {
  background: none;
  border: 1px solid #cbd5e1;
  padding: 6px 12px;
  border-radius: 6px;
  font-size: 12px;
  cursor: pointer;
  color: #64748b;
}

.list-empty {
  padding: 32px;
  text-align: center;
  color: #94a3b8;
  font-style: italic;
}

.product-monitor-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12.5px;
}

.product-monitor-table th,
.product-monitor-table td {
  border: 1px solid #e2e8f0;
  padding: 8px 10px;
  text-align: center;
}

.product-monitor-table th {
  background: #f8fafc;
  font-weight: bold;
  color: #475569;
}

.product-monitor-table td.mono {
  font-family: monospace;
  font-size: 12px;
}

.grid-icon-cell {
  white-space: nowrap;
}

.grid-badge {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px 8px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: bold;
}

.grid-badge.grid-yes {
  background: #ccfbf1;
  color: #0f766e;
}

.grid-badge.grid-no {
  background: #f1f5f9;
  color: #64748b;
}

.brand-create-divider {
  margin-top: 4px;
}

.brand-create-item {
  color: #00a896 !important;
  font-weight: bold;
  font-size: 13px;
  min-height: 44px;
}

.brand-create-item:hover {
  background: #ecfdf5 !important;
}

.brand-dialog-card {
  border-top: 4px solid #00a896;
}

.brand-dialog-title {
  font-size: 18px;
  font-weight: bold;
  color: #1e293b;
  padding-bottom: 4px;
}

.brand-dialog-subtitle {
  font-size: 12px;
  color: #64748b;
  padding-top: 0;
}

.brand-dialog-actions {
  padding: 8px 16px 16px;
  justify-content: flex-end;
  gap: 8px;
}

@media (max-width: 1200px) {
  .form-grid {
    grid-template-columns: repeat(2, 1fr);
  }
}
</style>
