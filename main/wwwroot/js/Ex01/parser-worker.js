// parser-worker.js — module worker（new Worker('parser-worker.js', { type: 'module' })）
//
// 資料改存 MSSQL 後，這支 worker 的職責縮小成「只做解析」：
//   1. 主執行緒選好檔案後，直接把 File 物件 postMessage 過來（不再經過 OPFS 中介，
//      也不需要 uuid 檔名——File 物件本身可以被結構化複製，瀏覽器對 Blob/File 的複製
//      是參照配額、不是整份記憶體拷貝）。
//   2. 用自寫的 xlsx-reader 串流解析（邊解壓邊掃，不把所有列堆在記憶體）。
//   3. 每解出一列就塞進 buffer；buffer 超過 CHUNK_SIZE 就整批 postMessage 回主執行緒，
//      由主執行緒呼叫 EX01_SAVE 分塊上傳——Worker 本身不打 API，職責維持單純。
//
// ★不再建立 byte 索引：分頁改由後端資料庫查詢，前端不需要知道任何位元組位移。
//
// ★buffer 的 flush 規則刻意「超過 CHUNK_SIZE 才 flush，且固定留 1 筆」：
//   這樣結尾一定還有東西可以標記成 isLast 的最後一塊，不會出現「剛好整除、
//   最後一塊為 0 筆」的邊界案例，主執行緒也就不需要另外猜「這是不是最後一塊」。
//
// 解析器是同源的自寫模組，沒有第三方相依、也不需要 CDN。

import { readXlsxRows } from './xlsx-reader.js';

const CHUNK_SIZE = 500;

self.onmessage = async (event) => {
  const { file } = event.data || {};
  try {
    if (!file) throw new Error('postMessage 未帶 file');

    let buffer = [];
    let sentCount = 0;

    // 節流：主執行緒不需要每個 chunk 都重畫一次 DOM。
    // 但「階段轉換」與「收尾」一定要送到，否則使用者會看到標籤跳號或永遠差幾 %。
    const PROGRESS_MIN_INTERVAL_MS = 80;
    let lastProgressAt = 0;
    let lastPhase = null;
    const reportProgress = (p) => {
      const force = p.phase !== lastPhase || p.phase === 'done';
      lastPhase = p.phase;
      const now = performance.now();
      if (!force && now - lastProgressAt < PROGRESS_MIN_INTERVAL_MS) return;
      lastProgressAt = now;
      postMessage({ type: 'progress', ...p });
    };

    // ★finalMeta 只在收尾那一次才需要（見下方 flush(true, meta) 呼叫）。中途 flush 完全
    //   不能提前讀外層的 `const meta = await readXlsxRows(...)`——那個賦值要等 readXlsxRows
    //   整個 resolve 才會完成，但 onRow 是在它「執行中」就同步觸發的，此時 meta 還在
    //   暫時性死區（TDZ），一讀就丟 ReferenceError。所以中途 flush 一律不帶 finalMeta。
    const flush = (isLast, finalMeta) => {
      const lines = buffer;
      buffer = [];
      const startLine = sentCount;
      sentCount += lines.length;
      postMessage({
        type: 'chunk',
        startLine,
        lines,
        isLast,
        columnCount: isLast ? finalMeta.columnCount : undefined,
        rowCount: isLast ? finalMeta.rowCount : undefined,
      });
    };

    const meta = await readXlsxRows(file, {
      onRow(cells) {
        buffer.push(JSON.stringify(cells));
        if (buffer.length > CHUNK_SIZE) {
          const carry = buffer.pop();   // 留最新這 1 筆，確保結尾一定還有東西可 flush 成 isLast
          flush(false);
          buffer.push(carry);
        }
      },
      onProgress: reportProgress,
    });

    // ★不管 buffer 剩幾筆（含 0 筆，例如空檔案）都要送出這個收尾訊息，
    //   主執行緒靠 isLast 判斷「解析＋分塊上傳」是否已經全部完成。
    flush(true, meta);

    reportProgress({ phase: 'done', ratio: 1, rowCount: meta.rowCount });
  } catch (err) {
    // XlsxError 的 message 本身就是給使用者看的中文說明，直接往上送；
    // 內部 code 不外露，其餘例外只回傳 message。
    postMessage({
      type: 'error',
      ok: false,
      error: err && err.message ? err.message : String(err),
    });
  }
};
