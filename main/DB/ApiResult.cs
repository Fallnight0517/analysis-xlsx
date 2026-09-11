using System.Data;

namespace xlsx_poc.DB;

// 離開 action 的回應信封。形狀比照公司既有專案的同名類別。
//
// Code 是 string 不是 int：值由 SP 的 @code output 決定（成功 "1"、業務失敗 "99"、
// 權限或參數問題 "-1"），DBService.cs 自己的例外路徑也是回 "-1"。
//
// Data 是 DataSet 不是單一 DataTable：一支 SP 可以回多個結果集，
// 序列化之後前端拿到的是 { "Table": [...], "Table1": [...] }，
// 以資料表名稱為鍵的物件，不是陣列。第一個叫 Table（沒有數字後綴）。
public class ApiResult
{
    public ApiResult()
    {
        Code = "";
        Message = "";
    }

    public ApiResult(int code)
    {
        Code = code.ToString();
        Message = "";
    }

    public ApiResult(int code, string msg)
    {
        Code = code.ToString();
        Message = msg;
    }

    public ApiResult(int code, string msg, DataSet data)
    {
        Code = code.ToString();
        Message = msg;
        Data = data;
    }

    // 既有專案的版本另有一個 (dynamic?, dynamic?, DataSet?) 多載，用途是直接吃 SqlParameter.Value
    // （型別是 object）。DBService.cs 是自己在呼叫端 .ToString() 轉好才塞進來的，
    // 用不到那個多載，所以沒有照抄。

    public string Code { get; set; }
    public string Message { get; set; }
    public DataSet? Data { get; set; }
}
