namespace xlsx_poc.Utility;

// 極簡版：本地開發沒有公司那套集中式記錄機制。
// WriteLog 直接寫本機檔案；SY006（既有專案的操作記錄 SP）先做 no-op。
//
// ★遷移後這個檔案暫時沒有任何呼叫者，但刻意保留：
//   原本 Class/EX01.cs 的每個功能都會在 finally 裡呼叫 SY006 記一筆操作記錄。
//   搬進預存程序之後那些呼叫點跟著消失了，而既有專案的做法是「在閘道 SP 裡統一記錄」——
//   但 DBService.cs 沒有閘道（它是 CommandText = FunctionID 直接叫目標 SP）。
//   操作記錄到底該放哪一層還待確認，在那之前保留這個檔案當作標記，
//   不要因為「現在沒人用」就刪掉。
public static class BaseUtility
{
    private static readonly string LogPath = Path.Combine(AppContext.BaseDirectory, "ex01.log");
    private static readonly object LogLock = new();

    public static void WriteLog(string msg)
    {
        lock (LogLock)
        {
            try
            {
                File.AppendAllText(LogPath, $"[{DateTime.Now:yyyy-MM-dd HH:mm:ss}] {msg}{Environment.NewLine}");
            }
            catch
            {
                // 本地 dev 用途：寫檔失敗不應該影響主流程。
            }
        }
    }

    public static void WriteLog(Exception ex) => WriteLog(ex.ToString());

    public static void SY006(Dictionary<string, string> Udata)
    {
        // no-op：本專案沒有接公司的集中式操作記錄機制。
    }

    public static bool IsChinese(char c) => c >= 0x4E00 && c <= 0x9FFF;
}
