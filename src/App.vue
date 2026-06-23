<!-- src/App.vue -->
<template>
  <div class="app-center-shell">
    <PosPage />
  </div>
</template>

<script setup>
import PosPage from './components/pos_page.vue'
</script>

<style>
.app-center-shell {
  width: 100%;
  max-width: 100%;
  min-height: 100vh;
  margin: 0 auto;
  display: flex;
  justify-content: center;
  overflow: auto;
  box-sizing: border-box;
}
</style>
