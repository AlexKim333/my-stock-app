<template>
  <div class="truck-gauge-container">
    <div class="gauge-header">
      <div class="header-left">
        <span class="truck-icon">🚛</span>
        <span class="title">멕시코 센트로 8대 서브창고 100상자 FTL 트럭 현황</span>
      </div>
      <div class="header-right">
        <span class="standard-badge">기준: 100상자/대</span>
        <button class="refresh-btn" @click="$emit('refresh')" title="새로고침">🔄</button>
      </div>
    </div>

    <div class="gauge-grid">
      <div 
        v-for="wh in warehouses" 
        :key="wh.warehouse_code" 
        class="warehouse-card"
        :class="{ 'full-truck': (wh.current_boxes || 0) >= 100 }"
        @click="$emit('select-warehouse', wh)"
      >
        <div class="card-top">
          <span class="wh-name">{{ wh.warehouse_name }}</span>
          <span class="wh-box-count">
            <strong>{{ wh.current_boxes || 0 }}</strong> / 100
          </span>
        </div>

        <div class="progress-track">
          <div 
            class="progress-fill"
            :style="{ width: Math.min(100, (wh.gauge_percentage || 0)) + '%' }"
            :class="getGaugeClass(wh.gauge_percentage)"
          ></div>
        </div>

        <div class="card-bottom">
          <span class="pct-text">{{ wh.gauge_percentage || 0 }}%</span>
          <span class="status-tag" :class="getStatusClass(wh.current_boxes)">
            {{ getStatusText(wh.current_boxes) }}
          </span>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
defineProps({
  warehouses: {
    type: Array,
    default: () => []
  }
})

defineEmits(['select-warehouse', 'refresh'])

const getGaugeClass = (pct) => {
  const p = Number(pct) || 0
  if (p >= 100) return 'fill-green'
  if (p >= 50) return 'fill-blue'
  return 'fill-amber'
}

const getStatusClass = (boxes) => {
  const b = Number(boxes) || 0
  if (b >= 100) return 'tag-ready'
  if (b >= 50) return 'tag-progress'
  return 'tag-pending'
}

const getStatusText = (boxes) => {
  const b = Number(boxes) || 0
  if (b >= 100) return '배차가능'
  if (b >= 50) return '모집중'
  return '대기'
}
</script>

<style scoped>
.truck-gauge-container {
  background: #0f172a;
  border-radius: 10px;
  padding: 12px 16px;
  margin-bottom: 12px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
  color: #f8fafc;
}

.gauge-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 10px;
  padding-bottom: 6px;
  border-bottom: 1px solid #1e293b;
}

.header-left {
  display: flex;
  align-items: center;
  gap: 8px;
}

.truck-icon {
  font-size: 18px;
}

.title {
  font-size: 14px;
  font-weight: 700;
  color: #38bdf8;
  letter-spacing: -0.3px;
}

.header-right {
  display: flex;
  align-items: center;
  gap: 8px;
}

.standard-badge {
  font-size: 11px;
  background: #1e293b;
  color: #94a3b8;
  padding: 2px 8px;
  border-radius: 4px;
}

.refresh-btn {
  background: transparent;
  border: none;
  cursor: pointer;
  font-size: 13px;
  opacity: 0.7;
  transition: opacity 0.2s, transform 0.2s;
}

.refresh-btn:hover {
  opacity: 1;
  transform: rotate(90deg);
}

.gauge-grid {
  display: grid;
  grid-template-columns: repeat(8, 1fr);
  gap: 8px;
}

@media (max-width: 1200px) {
  .gauge-grid {
    grid-template-columns: repeat(4, 1fr);
  }
}

.warehouse-card {
  background: #1e293b;
  border: 1px solid #334155;
  border-radius: 6px;
  padding: 8px;
  cursor: pointer;
  transition: all 0.2s ease;
}

.warehouse-card:hover {
  border-color: #38bdf8;
  transform: translateY(-2px);
  box-shadow: 0 4px 8px rgba(0, 0, 0, 0.2);
}

.warehouse-card.full-truck {
  border-color: #10b981;
  background: #064e3b;
}

.card-top {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 11px;
  margin-bottom: 5px;
}

.wh-name {
  font-weight: 700;
  color: #e2e8f0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.wh-box-count {
  font-size: 10px;
  color: #94a3b8;
}

.wh-box-count strong {
  color: #f1f5f9;
  font-size: 12px;
}

.progress-track {
  height: 6px;
  background: #334155;
  border-radius: 3px;
  overflow: hidden;
  margin-bottom: 5px;
}

.progress-fill {
  height: 100%;
  border-radius: 3px;
  transition: width 0.4s ease;
}

.fill-amber {
  background: #f59e0b;
}

.fill-blue {
  background: #0ea5e9;
}

.fill-green {
  background: #10b981;
  box-shadow: 0 0 8px rgba(16, 185, 129, 0.6);
}

.card-bottom {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 10px;
}

.pct-text {
  color: #94a3b8;
  font-weight: 600;
}

.status-tag {
  font-size: 9px;
  padding: 1px 4px;
  border-radius: 3px;
  font-weight: 600;
}

.tag-ready {
  background: #10b981;
  color: #ffffff;
}

.tag-progress {
  background: #0ea5e9;
  color: #ffffff;
}

.tag-pending {
  background: #475569;
  color: #cbd5e1;
}
</style>
