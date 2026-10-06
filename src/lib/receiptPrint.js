// =====================================================================
// 입출고증(COMPROBANTE) 인쇄 — 출고입력(index.html)과 검색수정(searchmodify.html) 공용
// ---------------------------------------------------------------------
// 예전에는 화면마다 양식이 복사되어 있어 한쪽만 고쳐지는 일이 반복됐다
// (재발행 전표에 ORIGEN 줄이 빠지는 등). 양식은 이 파일 하나만 고친다.
// =====================================================================

function escapeHtml(value) {
  if (value === null || value === undefined) return ''
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
}

// 'YYYY-MM-DD'는 출고입력 화면과 같은 toLocaleDateString() 형식(예: 2026. 10. 6.)으로 바꾼다.
// new Date('YYYY-MM-DD')는 UTC로 해석돼 멕시코 시간대에서 하루 밀리므로 로컬 날짜로 만든다.
function formatReceiptDate(selectedDate) {
  const ymd = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(selectedDate || ''))
  return ymd
    ? new Date(Number(ymd[1]), Number(ymd[2]) - 1, Number(ymd[3])).toLocaleDateString()
    : String(selectedDate || '').replace(/-/g, '/')
}

/**
 * 입출고증(COMPROBANTE) 2연 인쇄.
 *
 * invoiceNumber는 호출부에 따라 순번만(`001`) 또는 날짜 포함
 * 전체 송장번호(`2026/09/12-001`)로 들어온다. 전표에는 순번만 찍는다.
 *
 * route는 검색수정에서 불러온 전표의 { warehouse, txType }이다. 없으면(출고입력)
 * records[0].warehouse / 창고 선택값과 거래처의 지점 여부로 경로를 정한다.
 *
 * print()가 예외를 던지거나 사용자가 인쇄를 취소해도 callback은 반드시
 * 실행된다. 커밋 후 정리 작업을 이 콜백에 의존하는 호출부가 있기 때문이다.
 */
export function printReceipt(records, type, selectedDate, admin, invoiceNumber, callback, route) {
  const iframe = document.getElementById('printFrame')
  if (!iframe) return
  const doc = iframe.contentWindow.document
  const invoiceNo = String(invoiceNumber || '')
  const displayNumber = invoiceNo.includes('-') ? invoiceNo.split('-')[1] : invoiceNo
  const formattedDate = formatReceiptDate(selectedDate)
  const totalItems = new Set(records.map(r => `${r.itemName}_${r.color}`)).size
  const totalBoxes = records.reduce((sum, r) => sum + Math.abs(r.boxQty), 0)
  const totalIndividuals = records.reduce((sum, r) => sum + Math.abs(r.individualQty), 0)
  const rowsPerPage = 15
  const pages = Math.ceil(records.length / rowsPerPage)
  const locationValue = records.length > 0 ? records[0].location : '미지정'
  const whSelect = document.getElementById('warehouseSelect')
  const selectedWh = (route && route.warehouse)
    || ((records.length > 0 && records[0].warehouse) ? records[0].warehouse : (whSelect ? whSelect.value : 'MAIN'))
    || 'MAIN'
  const isBranchTarget = (route && route.txType)
    ? route.txType === 'MOVE'
    : (typeof window.isBranchLocation === 'function' ? window.isBranchLocation(locationValue) : false)
  const isTransfer = (type === 'out' && isBranchTarget)

  let title = type === 'in' ? 'COMPROBANTE DE ENTRADA' : (type === 'adj' ? 'COMPROBANTE DE AJUSTE' : 'COMPROBANTE DE SALIDA')
  let titleColor = type === 'in' ? 'red' : (type === 'adj' ? '#4f46e5' : 'black')
  if (isTransfer) {
    title = 'COMPROBANTE DE TRASPASO'
    titleColor = '#1e3a8a'
  }

  let routeLineHtml = ''
  if (isTransfer) {
    routeLineHtml = `ORIGEN: <b>[${escapeHtml(selectedWh)}]</b> ➔ DESTINO: <b style="color: #047857;">🏢 [${escapeHtml(locationValue)}]</b>`
  } else if (type === 'in') {
    routeLineHtml = `PROV: <b>${escapeHtml(locationValue)}</b> ➔ DESTINO: <b>[${escapeHtml(selectedWh)}]</b>`
  } else if (type === 'adj') {
    routeLineHtml = `ALMACEN: <b>[${escapeHtml(selectedWh)}]</b>`
  } else {
    routeLineHtml = `ORIGEN: <b>[${escapeHtml(selectedWh)}]</b> ➔ CLIENTE: <b>${escapeHtml(locationValue)}</b>`
  }

  const adminColor = admin === 'ADMIN' ? 'black' : 'green'
  const adminStyle = `font-size: 11pt; color: ${adminColor};`
  let htmlContent = ''
  for (let page = 0; page < pages; page++) {
    const startIdx = page * rowsPerPage
    const endIdx = Math.min(startIdx + rowsPerPage, records.length)
    const pageRecords = records.slice(startIdx, endIdx)
    let tableRows = '<tr><th>PRODUCTO</th><th>COLOR</th><th>BULTO</th><th>PZS</th><th>PZS/B</th><th>TOTAL</th></tr>'
    for (let i = 0; i < rowsPerPage; i++) {
      if (i < pageRecords.length) {
        const rec = pageRecords[i]
        const boxQty = Math.abs(rec.boxQty)
        const individualQty = Math.abs(rec.individualQty)
        const boxContent = rec.boxContent || 0
        const totalIndividual = (boxQty * boxContent) + individualQty
        tableRows += `<tr><td>${rec.itemName}</td><td>${rec.color}</td><td>${boxQty}</td><td>${individualQty}</td><td>${boxContent}</td><td>${totalIndividual}</td></tr>`
      } else {
        tableRows += `<tr><td></td><td></td><td></td><td></td><td></td><td></td></tr>`
      }
    }
    const summaryTable = page === 0 ? `
      <table class="summary-table">
        <tr><th>cant item</th><th>cant bulto</th><th>cant pzs</th></tr>
        <tr><td>${totalItems}</td><td>${totalBoxes}</td><td>${totalIndividuals}</td></tr>
      </table>
    ` : ''
    const receiptHtml = `
          <div class="receipt">
            <div class="header" style="color: ${titleColor};">${title}</div>
            <div class="details">
              <p>No: ${displayNumber}</p>
              <p>fetcha: ${formattedDate}</p>
              <p class="location"><span class="location-value">${routeLineHtml}</span></p>
              <p class="admin">VENDEDOR: <span style="${adminStyle}">${admin}</span></p>
              ${summaryTable}
            </div>
            <table class="main-table">${tableRows}</table>
            <div class="footer">
              <span>ANIMO!!!</span>
              <span class="page-number">${page + 1}-${pages}</span>
            </div>
          </div>`
    htmlContent += `
      <div class="page">
        <div class="receipt-container">${receiptHtml}${receiptHtml}
        </div>
      </div>
    `
  }
  doc.open()
  doc.write(`
    <html>
      <head>
        <style>
          @page { size: letter landscape; margin: 0.5in; margin-bottom: 1in; }
          body { font-family: Arial, sans-serif; margin: 0; padding: 0; }
          /* 전표는 출력 가능 높이 7in(레터 가로 8.5in - 위 0.5in - 아래 1in) 안에 들어가야 한다. 넘치면 맨 위 타이틀이 잘려 출력된다. */
          .page { width: 100%; height: 7in; display: flex; justify-content: center; align-items: flex-start; page-break-after: always; }
          .receipt-container { display: flex; justify-content: space-between; width: 10in; }
          .receipt { width: 4.75in; border: 1px solid #000; padding: 0.1in; box-sizing: border-box; }
          .header { text-align: center; font-weight: bold; font-size: 14pt; margin-bottom: 0.1in; }
          .details { font-size: 10pt; margin-bottom: 0.1in; }
          .details p { margin: 0.05in 0; }
          .location { font-size: 10pt; font-weight: bold; text-decoration: underline; }
          .location-value { color: blue; font-size: 13pt; }
          .admin { font-size: 9pt; font-weight: bold; }
          .summary-table { width: 60%; margin: 0.1in auto; border-collapse: collapse; font-size: 10pt; }
          .summary-table th, .summary-table td { border: 1px solid #000; padding: 0.05in; text-align: center; }
          .summary-table th { background-color: #f2f2f2; font-weight: bold; }
          .main-table { width: 100%; border-collapse: collapse; font-size: 10pt; }
          .main-table th, .main-table td { border: 1px solid #000; padding: 0.04in; text-align: center; height: 0.25in; }
          .main-table th { background-color: #f2f2f2; font-weight: bold; }
          .footer { text-align: center; font-size: 10pt; margin-top: 0.1in; display: flex; justify-content: space-between; align-items: center; }
          .page-number { font-weight: bold; }
        </style>
      </head>
      <body>${htmlContent}</body>
    </html>
  `)
  doc.close()
  iframe.contentWindow.focus()
  setTimeout(() => {
    try {
      iframe.contentWindow.print()
    } catch (printErr) {
      console.warn('printReceipt iframe print error:', printErr)
    }
    if (typeof callback === 'function') {
      try {
        callback()
      } catch (cbErr) {
        console.warn('printReceipt callback error:', cbErr)
      }
    }
  }, 500)
}
