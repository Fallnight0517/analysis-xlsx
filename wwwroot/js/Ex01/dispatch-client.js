// dispatch-client.js — Index 專案自建的最小前端 dispatch client。
//
// 呼叫方式跟部門版 Capi/Message 一致（para = { urlPage, dataJson }，回傳
// { success, message, data }），但用 fetch 實作、不引入 jQuery/SweetAlert——
// 這個專案是乾淨的原生 ESM，帶進整包 jQuery+SweetAlert 對這個獨立小專案偏重。

export async function Capi(para, cb) {
  let response;
  try {
    const res = await fetch(para.urlPage, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify(para.dataJson),
    });
    if (!res.ok) {
      throw new Error('HTTP ' + res.status);
    }
    response = await res.json();
  } catch (err) {
    Message('請求發生錯誤，請稍後再試。', 'error');
    // ★跟一般「發生錯誤就不呼叫 cb」的簡化寫法不同：這裡刻意仍然呼叫 cb，
    //   回傳一個 success:false 的信封，讓呼叫端（例如上傳佇列、分頁讀取）
    //   永遠可以用同一套 if (response.success) 邏輯處理，不必額外處理
    //   「cb 從頭到尾沒被呼叫」這種情況（例如包成 Promise 時會整個掛住）。
    cb({ success: false, message: err && err.message ? err.message : String(err) });
    return;
  }
  cb(response);
}

/**
 * Capi 的 Promise 封裝：呼叫端不用再各自寫 `new Promise((resolve) => Capi(...))`。
 * urlPage 固定用 '/api/ApiWork'，呼叫端只需要給 FUNCTION_ID 跟 Data。
 */
export function CapiAsync(urlPage, functionId, data) {
  return new Promise((resolve) => {
    Capi({ urlPage, dataJson: { FUNCTION_ID: functionId, Data: data } }, resolve);
  });
}

export function Message(msg) {
  // 先用最簡單的版本；之後如果想要更漂亮的提示，直接換掉這個函式本體即可，
  // 呼叫端的介面 Message(msg) 不需要跟著改。
  alert(msg);
}
