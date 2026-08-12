namespace xlsx_poc.Utility;

public static class MSSqlWork
{
    // 傳入的 SQL 已經有 " WHERE " 就接 " AND "，否則開頭用 " WHERE "。
    public static string MakeSqlWhere(string sql)
    {
        return sql.IndexOf(" WHERE ", StringComparison.OrdinalIgnoreCase) >= 0 ? " AND " : " WHERE ";
    }
}
