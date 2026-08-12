namespace xlsx_poc.Utility;

// 極簡版：本地開發沒有部門那套集中式記錄機制。
// WriteLog 直接寫本機檔案；SY006（部門的操作記錄 SP）先做 no-op，
// 呼叫點結構仍保留一致，方便日後真的要接部門機制時比對修改。
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
        // no-op：本專案沒有部門的 LOGSY006 記錄 SP。
    }

    public static bool IsChinese(char c) => c >= 0x4E00 && c <= 0x9FFF;
}
