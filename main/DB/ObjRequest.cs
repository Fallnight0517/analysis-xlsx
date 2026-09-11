namespace xlsx_poc.DB;

// 進入 action 的請求信封。形狀比照公司既有專案的同名類別，只有兩處刻意不同：
//
// ①屬性名是 FunctionID（大寫 ID），不是既有專案用的 FunctionId。
//   因為 DBService.cs:57 讀的是 request.FunctionID，而 DBService.cs 不能動。
//   這是 DBService.cs 自己定的拼法，不是我們的選擇。
//
// ②namespace 用檔案範圍語法，跟 main/ 其餘檔案一致。
//
// ★ObjParams 刻意是 Dictionary<string, string>：這支 API 服務多個 FunctionID，
//   每個 FunctionID 要的參數都不一樣，編譯期根本不知道會收到什麼欄位，所以不宣告。
//   代價是沒有編譯期檢查——鍵名打錯不會報錯，SP 端只會拿到 NULL。
public class ObjRequest
{
    public ObjRequest()
    {
        FunctionID = "";
        ObjParams = new Dictionary<string, string>();
    }

    public string FunctionID { set; get; }
    public Dictionary<string, string> ObjParams { set; get; }
}
