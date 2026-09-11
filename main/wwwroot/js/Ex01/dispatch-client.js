// dispatch-client.js — Index 專案自建的最小前端 dispatch client。
//
// 用 fetch 實作、不引入 jQuery/SweetAlert——這個專案是乾淨的原生 ESM，
// 帶進整包 jQuery+SweetAlert 對這個獨立小專案偏重。
//
// 關於命名：公司既有兩個專案的前端輔助函式分別叫 Capi
// 和 ajaxPost，兩個名字直接搬過來都會誤導——
// Capi 配的是舊的 { success, message, data } 信封，ajaxPost 是 jQuery + form-urlencoded。
// 這裡是 fetch + JSON + { Code, Message, Data }，所以用 CapiDb 這個新名字。

/**
 * 呼叫後端 dispatch 的唯一進入點。
 *
 * 送出：{ FunctionID, ObjParams }，ObjParams 的值「全部都是字串」——
 *   因為後端宣告是 Dictionary<string, string>，數字和布林都要自己轉：
 *   布林一律送 '1' / '0'（送 'true' 的話 SP 端 CAST 成 BIT 會直接炸），
 *   陣列一律 JSON.stringify 成一個字串（SP 端用 OPENJSON 展開）。
 *
 * 收到：{ Code, Message, Data }
 *   Code 是字串，成功是 '1'。
 *   Data 是序列化後的 DataSet——注意它「不是陣列」，而是以資料表名稱為鍵的物件：
 *   { "Table": [...], "Table1": [...] }。第一個叫 Table，沒有數字後綴。
 *
 * 跟 Capi 一樣，連線層級的錯誤也會回一個信封而不是丟例外，
 * 讓呼叫端永遠只有一套 if (res.Code === '1') 的判斷邏輯。
 */
export async function CapiDb(urlPage, functionId, objParams) {
  try {
    const res = await fetch(urlPage, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ FunctionID: functionId, ObjParams: objParams || {} }),
    });
    if (!res.ok) {
      throw new Error('HTTP ' + res.status);
    }
    return await res.json();
  } catch (err) {
    Message('請求發生錯誤，請稍後再試。');
    return { Code: '-1', Message: err && err.message ? err.message : String(err), Data: null };
  }
}

/** 取出 DataSet 的第 n 個結果集；沒有就回空陣列（避免呼叫端到處寫 ?. 判斷）。 */
export function Table(apiResult, index = 0) {
  const key = index === 0 ? 'Table' : 'Table' + index;
  return (apiResult && apiResult.Data && apiResult.Data[key]) || [];
}

export function Message(msg) {
  // 先用最簡單的版本；之後如果想要更漂亮的提示，直接換掉這個函式本體即可，
  // 呼叫端的介面 Message(msg) 不需要跟著改。
  alert(msg);
}
