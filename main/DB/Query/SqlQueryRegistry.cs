namespace xlsx_poc.DB.Query;

// DBService.ExecuteQuery（DBService.cs:156）需要這個型別才能編譯，但公司既有專案裡
// 找不到它的本尊——全樹搜 SqlQueryRegistry / TryGetSql 零命中，也沒有 Query/ 目錄，
// 任何 .csproj 都沒有把 .sql 檔納進來。
//
// 目前的決定是三支功能全部走 ExecuteProcedure，完全不呼叫 ExecuteQuery，
// 所以這裡放一個空的登錄檔：既讓 DBService.cs 維持一字不改，
// 「登錄檔是空的」也正好是目前的真實狀態。
//
// 待確認「ExecuteQuery 這條路線是不是真的在用」之後，這個檔案要嘛被真正的實作取代，
// 要嘛連同 ExecuteQuery 一起確認為不使用。
//
// ★注意：既有專案存放預存程序腳本的那個目錄裡的 .sql 檔不能拿來填這個登錄檔。
//   那些是 SSMS 匯出的 CREATE PROCEDURE 物件定義（含 GO 批次分隔符，
//   SqlCommand 不認識），部署時跑一次就結束；
//   ExecuteQuery 要的是每次呼叫都執行、會回傳結果集、內部引用 @params 的查詢主體。
public static class SqlQueryRegistry
{
    private static readonly Dictionary<string, string> Registry =
        new(StringComparer.OrdinalIgnoreCase);

    public static bool TryGetSql(string functionId, out string sql)
    {
        if (Registry.TryGetValue(functionId, out string? found))
        {
            sql = found;
            return true;
        }

        sql = string.Empty;
        return false;
    }
}
