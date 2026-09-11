'use strict';

import { CapiDb, Table, Message } from '/js/Ex01/dispatch-client.js';

const PAGE_SIZE = 10;

// NDJSON 的第 0 列是 .xlsx 的標題列。true = 上傳時標記 HasHeader=true，
// 後端會把 LineNum=0 那列當表頭、分頁時從 LineNum=1 開始算資料列。
const HAS_HEADER_ROW = true;

// ---- 目前檢視狀態：資料實際存在資料庫，這裡只留「正在看哪個資料集、第幾頁」這類輕量狀態 ----
const state = {
  datasetId: null,   // 目前檢視中的資料集
  page: 0,
  totalPages: 0,
  header: null,       // 表頭只抓一次；換資料集才重抓，同資料集換頁不重複查
  columnCount: 0,
};

const el = {
  unsupported: document.getElementById('unsupported'),
  fileInput: document.getElementById('fileInput'),
  cacheStatus: document.getElementById('cacheStatus'),
  btnParse: document.getElementById('btnParse'),
  parseStatus: document.getElementById('parseStatus'),
  progressRow: document.getElementById('progressRow'),
  progressTrack: document.getElementById('progressTrack'),
  progressBar: document.getElementById('progressBar'),
  progressText: document.getElementById('progressText'),
  uploadCountRow: document.getElementById('uploadCountRow'),
  uploadCountText: document.getElementById('uploadCountText'),
  datasetSelect: document.getElementById('datasetSelect'),
  btnPrev: document.getElementById('btnPrev'),
  btnNext: document.getElementById('btnNext'),
  curPage: document.getElementById('curPage'),
  totalPages: document.getElementById('totalPages'),
  pageStatus: document.getElementById('pageStatus'),
  dataHead: document.getElementById('dataHead'),
  dataBody: document.getElementById('dataBody'),
  pageSizeLabel: document.getElementById('pageSizeLabel'),
};

el.pageSizeLabel.textContent = PAGE_SIZE;

const STATUS_CLASS = { ok: 'w3-text-green', err: 'w3-text-red', muted: 'w3-text-grey' };

function setStatus(node, text, cls) {
  node.textContent = text;
  node.className = 'w3-margin-top ' + (STATUS_CLASS[cls] || STATUS_CLASS.muted);
}

function formatSize(bytes) {
  if (bytes < 1024) return bytes + ' bytes';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1024 / 1024).toFixed(1) + ' MB';
}

// ---- 讀取進度條：Worker 的職責縮小成只做解析，但進度事件格式不變，這段沿用原本設計 ----
const PHASE_LABEL = {
  sharedStrings: '讀取文字內容',
  styles: '讀取格式設定',
  dimension: '計算欄位數',
  sheet: '讀取資料列',
  done: '完成',
};

function showProgressIndeterminate(label) {
  el.progressRow.hidden = false;
  el.progressBar.classList.add('indeterminate');
  el.progressBar.style.width = '';
  el.progressTrack.removeAttribute('aria-valuenow');
  el.progressText.textContent = label;
}

function hideProgress() {
  el.progressRow.hidden = true;
  el.progressBar.classList.remove('indeterminate');
  el.progressBar.style.width = '0';
  el.progressTrack.removeAttribute('aria-valuenow');
  el.progressText.textContent = '';
}

function renderProgress(msg) {
  const label = PHASE_LABEL[msg.phase] || msg.phase;
  if (msg.ratio === null || msg.ratio === undefined) {
    showProgressIndeterminate(label + '…');
    return;
  }
  const pct = Math.round(msg.ratio * 100);
  el.progressRow.hidden = false;
  el.progressBar.classList.remove('indeterminate');
  el.progressBar.style.width = pct + '%';
  el.progressTrack.setAttribute('aria-valuenow', String(pct));
  el.progressText.textContent = label + '　' + pct + '%';
}

// ---- 上傳筆數：跟讀取進度條是分開的兩件事（見前面討論）——上傳的「總筆數」要等
// Worker 解析到最後一列才知道，沒辦法像讀取那樣一開始就算出百分比，所以這裡改用
// 「即時計數」而不是進度條：解析出幾筆、已經確認存進資料庫幾筆，直接顯示數字。
function showUploadCount() {
  el.uploadCountRow.hidden = false;
}

function hideUploadCount() {
  el.uploadCountRow.hidden = true;
  el.uploadCountText.textContent = '';
}

function renderUploadCount(parsedCount, uploadedCount) {
  // 兩個數字都含表頭那一列；扣掉表頭才是使用者理解的「資料筆數」，跟完成訊息的口徑一致。
  const headerOffset = HAS_HEADER_ROW ? 1 : 0;
  const parsedData = Math.max(0, parsedCount - headerOffset);
  const uploadedData = Math.max(0, uploadedCount - headerOffset);
  el.uploadCountText.textContent =
    '已解析 ' + parsedData.toLocaleString() + ' 筆／已上傳 ' + uploadedData.toLocaleString() + ' 筆';
}

// ---- 環境檢查：資料改存 DB 後不再需要 OPFS，只需要 crypto.randomUUID 產生 DatasetId ----
(function checkSupport() {
  const missing = [];
  if (!window.isSecureContext) missing.push('請透過 https:// 或 http://localhost 開啟本頁');
  if (!window.crypto || !crypto.randomUUID) missing.push('瀏覽器版本過舊');
  if (!missing.length) return;

  const message = '此瀏覽器環境無法使用本功能：\n- ' + missing.join('\n- ');
  el.unsupported.hidden = false;
  el.unsupported.textContent = message;
  el.fileInput.disabled = true;
  setTimeout(() => Message(message), 0);
})();

// ==================== 區塊一：選檔 ====================
//
// 資料改存 DB 後不再需要 OPFS 快取：選了檔案就直接留著 File 物件，
// 按下「開始讀取」時整個交給 Worker（File 可以被結構化複製，不需要中介檔案）。

let selectedFile = null;

function onFileChange() {
  const file = el.fileInput.files && el.fileInput.files[0];
  if (!file) {
    selectedFile = null;
    setStatus(el.cacheStatus, '尚未選擇檔案。', 'muted');
    return;
  }
  if (!file.name.toLowerCase().endsWith('.xlsx')) {
    el.fileInput.value = '';
    selectedFile = null;
    setStatus(el.cacheStatus, '尚未選擇檔案。', 'muted');
    Message('請選擇 .xlsx 格式的檔案。');
    return;
  }

  selectedFile = file;
  setStatus(el.cacheStatus, '已選擇：' + file.name + '（' + formatSize(file.size) + '）', 'ok');

  el.btnParse.disabled = false;
  el.btnParse.textContent = '開始讀取並上傳';
  hideProgress();
  hideUploadCount();
  setStatus(el.parseStatus, '可以開始讀取。', 'muted');
}

el.fileInput.addEventListener('change', onFileChange);

// ==================== 區塊二：讀取＋分塊上傳 ====================

/** 依序上傳 chunk 的簡單佇列：Worker 解析速度跟上傳速度脫鉤，但送出順序必須跟 LineNum 一致。 */
function createUploadQueue(onDone, onError, onChunkUploaded) {
  const queue = [];
  let pumping = false;

  async function pump() {
    if (pumping) return;
    pumping = true;
    try {
      while (queue.length) {
        const chunk = queue.shift();
        await uploadChunk(chunk);
        onChunkUploaded(chunk);
        if (chunk.isLast) {
          onDone();
          return;
        }
      }
    } catch (err) {
      onError(err);
    } finally {
      pumping = false;
    }
  }

  return {
    push(chunk) {
      queue.push(chunk);
      pump();
    },
  };
}

async function uploadChunk(chunk) {
  // 寫入走 UpdateData（既有專案把讀與寫分成兩個 action）。
  // ObjParams 的值全部都要是字串：布林送 '1' / '0'，數字自己 String() 轉。
  // ★Lines 是「一整批 500 列」序列化成一個字串——這就是 round-trip 從 500 降到 1 的關鍵。
  //   chunk.lines 本身是字串陣列（parser-worker.js:66 已經 JSON.stringify 過每一列），
  //   所以這裡再 stringify 一次是第二層編碼，SP 端用兩層 OPENJSON 拆回來。
  const response = await CapiDb('/api/UpdateData', 'EX01_SAVE', {
    DatasetId: chunk.datasetId,
    FileName: chunk.fileName,
    HasHeader: HAS_HEADER_ROW ? '1' : '0',
    ColumnCount: String(chunk.columnCount || 0),
    StartLine: String(chunk.startLine),
    Lines: JSON.stringify(chunk.lines),
    IsFirst: chunk.isFirst ? '1' : '0',
    IsLast: chunk.isLast ? '1' : '0',
  });
  if (response.Code !== '1') {
    throw new Error(response.Message || 'EX01_SAVE 失敗');
  }
}

function onParseClick() {
  if (!selectedFile) {
    Message('請先選擇檔案。');
    return;
  }
  const file = selectedFile;
  const datasetId = crypto.randomUUID();
  const fileName = file.name;

  el.btnParse.disabled = true;
  el.fileInput.disabled = true;
  setStatus(el.parseStatus, '讀取並上傳中…', 'muted');
  // 從按下按鈕到收到第一則進度之間（建 Worker、載入模組）沒有可量測的分母，先走不確定模式。
  showProgressIndeterminate('準備中…');
  showUploadCount();
  renderUploadCount(0, 0);

  let worker;
  try {
    // parser-worker.js 是跨頁共用資源，留在 wwwroot/js/Ex01/，
    // 跟這支已搬到 Views/Ex01/ 的 .cshtml.js 不同目錄，所以改用絕對路徑定位。
    const workerUrl = new URL('/js/Ex01/parser-worker.js', location.href);
    worker = new Worker(workerUrl, { type: 'module' });
  } catch (err) {
    hideProgress();
    hideUploadCount();
    setStatus(el.parseStatus, '可以開始讀取。', 'muted');
    el.btnParse.disabled = false;
    el.fileInput.disabled = false;
    Message('無法啟動讀取程序，請重新整理頁面後再試。');
    return;
  }

  let isFirstChunk = true;
  let finalRowCount = 0;
  let parsedCount = 0;
  let uploadedCount = 0;

  const finishFail = (message) => {
    worker.terminate();
    hideProgress();
    hideUploadCount();
    el.btnParse.disabled = false;
    el.fileInput.disabled = false;
    setStatus(el.parseStatus, '請先選擇檔案。', 'muted');
    Message(message);
  };

  const finishOk = async () => {
    worker.terminate();
    renderProgress({ phase: 'done', ratio: 1 });
    // finalRowCount 是 Worker 回報的物理列數（含表頭）；這裡跟頁面其他地方「扣掉表頭算資料列」的口徑對齊。
    const dataRowCount = HAS_HEADER_ROW ? Math.max(0, finalRowCount - 1) : finalRowCount;
    setStatus(el.parseStatus, '讀取並上傳完成，共 ' + dataRowCount.toLocaleString() + ' 筆資料。', 'ok');
    el.btnParse.disabled = true;
    el.btnParse.textContent = '已完成（如需重讀請重新選檔）';
    el.fileInput.disabled = false;

    await refreshDatasetList(datasetId);
    await renderPage(datasetId, 0);
  };

  const queue = createUploadQueue(
    () => { finishOk(); },
    (err) => { finishFail('上傳失敗：' + (err.message || String(err))); },
    (chunk) => {
      uploadedCount += chunk.lines.length;
      renderUploadCount(parsedCount, uploadedCount);
    }
  );

  worker.onerror = () => {
    finishFail('讀取過程發生錯誤，請重新選擇檔案再試一次。');
  };

  worker.onmessage = (e) => {
    const msg = e.data || {};
    // ★這個守衛必須在檢查其餘分支之前：progress 訊息很頻繁，優先處理完就返回。
    if (msg.type === 'progress') { renderProgress(msg); return; }
    if (msg.type === 'error') {
      finishFail('無法讀取這個檔案：' + (msg.error || '未知錯誤'));
      return;
    }
    if (msg.type === 'chunk') {
      if (msg.isLast) finalRowCount = msg.rowCount || 0;
      parsedCount += msg.lines.length;
      renderUploadCount(parsedCount, uploadedCount);
      const isFirst = isFirstChunk;
      isFirstChunk = false;
      queue.push({
        datasetId,
        fileName,
        columnCount: msg.columnCount || 0,
        startLine: msg.startLine,
        lines: msg.lines,
        isFirst,
        isLast: !!msg.isLast,
      });
    }
  };

  // ★只傳 file：Worker 自己解析，主執行緒不需要事先做任何事。
  worker.postMessage({ file });
}

el.btnParse.addEventListener('click', onParseClick);

// ==================== 區塊三：資料集清單 + 分頁顯示（改向後端查詢） ====================

async function refreshDatasetList(selectId) {
  const response = await CapiDb('/api/GetData', 'EX01_LIST');

  el.datasetSelect.replaceChildren();
  if (response.Code !== '1') {
    Message(response.Message || 'EX01_LIST 失敗');
    return;
  }

  // 查無資料不再是錯誤（SP 一律回 Code=1 加一個空結果集），這裡自然會得到一個空的下拉選單。
  const list = Table(response);
  for (const row of list) {
    const opt = document.createElement('option');
    opt.value = row.DatasetId;
    opt.textContent = row.FileName + '（' + row.UploadTime + '，共 ' + row.TotalRows + ' 列）';
    el.datasetSelect.appendChild(opt);
  }
  if (selectId) el.datasetSelect.value = selectId;
}

async function fetchPage(datasetId, page, wantHeader) {
  // ObjParams 的值全部都要是字串（後端是 Dictionary<string, string>）：
  // 數字自己 String() 轉，布林一律送 '1' / '0'——送 'true' 的話 SP 端 CAST 成 BIT 會直接炸。
  const response = await CapiDb('/api/GetData', 'EX01_PAGE', {
    DatasetId: datasetId,
    Page: String(page),
    PageSize: String(PAGE_SIZE),
    WantHeader: wantHeader ? '1' : '0',
  });
  if (response.Code !== '1') {
    throw new Error(response.Message || 'EX01_PAGE 失敗');
  }

  // SP 固定回三個結果集：0=中介資料、1=表頭（可能 0 列）、2=本頁資料列。
  const meta = Table(response)[0];
  const headerRow = Table(response, 1)[0];

  // totalPages 的除法留在前端算（既有專案的分頁數學一律在前端，SP 只回原始筆數）。
  const totalRows = meta.TotalRows;
  const totalPages = Math.max(1, Math.ceil(totalRows / PAGE_SIZE));

  // 回傳形狀刻意跟舊版一模一樣，renderPage 那邊一行都不用改。
  return {
    columnCount: meta.ColumnCount,
    header: headerRow ? JSON.parse(headerRow.RowJson) : null,
    rows: Table(response, 2).map((r) => JSON.parse(r.RowJson)),
    totalRows,
    totalPages,
    page: meta.Page,
  };
}

const formatCell = (v) => (v === null || v === undefined ? '' : String(v));

/** 0 → "A"、25 → "Z"、26 → "AA"（Excel 欄位代號） */
function columnLabel(i) {
  let s = '';
  let n = i;
  do { s = String.fromCharCode(65 + (n % 26)) + s; n = Math.floor(n / 26) - 1; } while (n >= 0);
  return s;
}

/** 畫表頭。表頭那一格沒有文字時，改顯示 Excel 欄位代號（A、B、C…）當佔位，比空白好用。 */
function renderHead(header, columnCount) {
  el.dataHead.replaceChildren();
  if (!columnCount) return;
  const tr = document.createElement('tr');
  const th0 = document.createElement('th');
  th0.textContent = '#';
  tr.appendChild(th0);
  for (let c = 0; c < columnCount; c++) {
    const th = document.createElement('th');
    const label = header ? formatCell(header[c]) : '';
    if (label) {
      th.textContent = label;
    } else {
      th.textContent = columnLabel(c);
      th.className = 'w3-text-grey';
    }
    tr.appendChild(th);
  }
  el.dataHead.appendChild(tr);
}

/** 顯示資料集 datasetId 的第 p 頁（0-based）：改向 EX01_PAGE 查詢，不再讀本機檔案。 */
async function renderPage(datasetId, p) {
  el.btnPrev.disabled = true;
  el.btnNext.disabled = true;
  setStatus(el.pageStatus, '讀取第 ' + (p + 1) + ' 頁…', 'muted');

  try {
    // 表頭只需要抓一次：換了資料集才重新要，同一個資料集換頁不必重複查。
    const wantHeader = state.datasetId !== datasetId;
    const data = await fetchPage(datasetId, p, wantHeader);

    state.datasetId = datasetId;
    state.page = p;
    state.totalPages = data.totalPages;
    state.columnCount = data.columnCount;
    if (wantHeader) state.header = data.header;

    renderHead(state.header, state.columnCount);

    const firstNo = p * PAGE_SIZE + 1;
    const frag = document.createDocumentFragment();
    data.rows.forEach((row, i) => {
      const tr = document.createElement('tr');
      const tdNo = document.createElement('td');
      tdNo.className = 'w3-right-align w3-text-grey tabular-nums';
      tdNo.textContent = String(firstNo + i);
      tr.appendChild(tdNo);
      for (let c = 0; c < state.columnCount; c++) {
        const td = document.createElement('td');
        td.textContent = formatCell(row[c]);
        tr.appendChild(td);
      }
      frag.appendChild(tr);
    });
    el.dataBody.replaceChildren(frag);

    el.curPage.textContent = String(p + 1);
    el.totalPages.textContent = String(data.totalPages);
    setStatus(el.pageStatus,
      '第 ' + (p + 1) + ' / ' + data.totalPages + ' 頁：第 ' + firstNo.toLocaleString()
      + '–' + (firstNo + data.rows.length - 1).toLocaleString() + ' 筆', 'ok');
  } catch (err) {
    setStatus(el.pageStatus, '第 ' + (p + 1) + ' 頁無法顯示。', 'muted');
    Message('讀取第 ' + (p + 1) + ' 頁時發生錯誤：' + (err.message || String(err)));
  } finally {
    el.btnPrev.disabled = state.page <= 0;
    el.btnNext.disabled = state.page >= state.totalPages - 1;
  }
}

function resetPagination(message) {
  state.datasetId = null;
  state.page = 0;
  state.totalPages = 0;
  state.header = null;
  state.columnCount = 0;
  el.dataHead.replaceChildren();
  el.dataBody.replaceChildren();
  el.curPage.textContent = '-';
  el.totalPages.textContent = '-';
  el.btnPrev.disabled = true;
  el.btnNext.disabled = true;
  setStatus(el.pageStatus, message, 'muted');
}

function onPrevClick() {
  if (!state.datasetId || state.page <= 0) return;
  renderPage(state.datasetId, state.page - 1);
}

function onNextClick() {
  if (!state.datasetId || state.page >= state.totalPages - 1) return;
  renderPage(state.datasetId, state.page + 1);
}

function onDatasetChange() {
  const datasetId = el.datasetSelect.value;
  if (!datasetId) {
    resetPagination('請先選擇資料集。');
    return;
  }
  renderPage(datasetId, 0);
}

el.btnPrev.addEventListener('click', onPrevClick);
el.btnNext.addEventListener('click', onNextClick);
el.datasetSelect.addEventListener('change', onDatasetChange);

// ==================== 初始化 ====================

async function initPage() {
  resetPagination('請先讀取檔案，或從上方選擇一個既有的資料集。');
  await refreshDatasetList();
  if (el.datasetSelect.value) {
    await renderPage(el.datasetSelect.value, 0);
  }
}

initPage();
