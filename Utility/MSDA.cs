using System.Collections;
using System.Data;
using Microsoft.Data.SqlClient;

namespace xlsx_poc.Utility;

// 精簡版資料存取：明碼連線字串（本地 dev，無 SSO、無連線字串加密）。
// 方法名稱／簽名比照部門版 MSDA，讓 EX01.cs 讀起來跟 PA0010.cs 一樣；
// 不需要 SqlBulkCopy，大量寫入用「GetConnection + BeginTransaction + 批次 ExecuteNonQuery」即可。
public static class MSDA
{
    private static string _connectionString = string.Empty;

    public static void Init(string connectionString)
    {
        _connectionString = connectionString;
    }

    public static SqlConnection GetConnection() => new SqlConnection(_connectionString);

    // 查無資料回 null（比照部門）。
    public static DataTable? GetDataTable(string sql, ArrayList parameters, string tag)
    {
        using var cn = GetConnection();
        using var cmd = new SqlCommand(sql, cn);
        foreach (var p in parameters)
        {
            if (p is SqlParameter sp) cmd.Parameters.Add(sp);
        }

        var dt = new DataTable(tag);
        cn.Open();
        using (var reader = cmd.ExecuteReader())
        {
            dt.Load(reader);
        }

        return dt.Rows.Count > 0 ? dt : null;
    }

    public static int ExecuteNonQuery(string sql, ArrayList parameters)
    {
        using var cn = GetConnection();
        using var cmd = new SqlCommand(sql, cn);
        foreach (var p in parameters)
        {
            if (p is SqlParameter sp) cmd.Parameters.Add(sp);
        }

        cn.Open();
        return cmd.ExecuteNonQuery();
    }

    public static int ExecuteNonQuery(string sql, ArrayList parameters, SqlTransaction trans, SqlConnection cn)
    {
        using var cmd = new SqlCommand(sql, cn, trans);
        foreach (var p in parameters)
        {
            if (p is SqlParameter sp) cmd.Parameters.Add(sp);
        }

        return cmd.ExecuteNonQuery();
    }
}
