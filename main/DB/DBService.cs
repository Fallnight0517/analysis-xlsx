using Microsoft.Data.SqlClient;
using System.Data;
using System.Text.RegularExpressions;

namespace xlsx_poc.DB
{
    public interface IDBService
    {
        ApiResult ExecuteProcedure(ObjRequest request);
        ApiResult ExecuteQuery(ObjRequest request);
    }

    public class DBService : IDBService
    {
        private readonly string? _connectionString;
        private readonly string? _provider;
        private readonly string? _connectionName;

        /// <summary>
        /// 寬鬆驗證：只允許英文字母、數字、底線（合法預存程序名稱字元）
        /// </summary>
        private static readonly Regex SafeFunctionIdPattern = new Regex(
            @"^[A-Za-z][A-Za-z0-9_]{0,49}$",
            RegexOptions.Compiled);

        public DBService(IConfiguration configuration)
        {
            _provider = configuration.GetValue<string>("DBProvider");
            _connectionName = configuration.GetValue<string>("ConnectionName");
            _connectionString = configuration.GetConnectionString(_connectionName ?? "DefaultConnection");
        }

        private IDbConnection CreateConnection()
        {
            return _provider switch
            {
                "SqlServer" => new SqlConnection(_connectionString),
                _ => throw new NotSupportedException("Unsupported database provider")
            };
        }

        private IDataAdapter CreateDataAdapter(IDbCommand command)
        {
            return _provider switch
            {
                "SqlServer" => new SqlDataAdapter(command as SqlCommand),
                _ => throw new NotSupportedException("Unsupported database provider")
            };
        }

        /// <summary>
        /// 執行預存程序
        /// </summary>
        public ApiResult ExecuteProcedure(ObjRequest request)
        {
            // 驗證並萃取合法的 FunctionID（僅允許英文字母開頭 + 英數底線，長度 ≤ 50）
            var functionIdMatch = SafeFunctionIdPattern.Match(request.FunctionID ?? "");
            if (!functionIdMatch.Success)
            {
                return new ApiResult
                {
                    Code = "-1",
                    Message = "無效的功能識別碼",
                    Data = new DataSet()
                };
            }
            string sanitizedFunctionId = functionIdMatch.Value;

            // 使用 using 確保連線會被正確關閉和釋放
            using IDbConnection connection = CreateConnection();

            try
            {
                connection.Open();
                using var command = connection.CreateCommand();

                command.CommandTimeout = 30; 
                command.CommandType = CommandType.StoredProcedure;
                command.CommandText = sanitizedFunctionId;

                // request.ObjParams 轉換成 JSON 字串
                var jsonInput = request.ObjParams == null ? "{}" :
                    System.Text.Json.JsonSerializer.Serialize(request.ObjParams);

                // 設置參數
                var jsonParameter = command.CreateParameter();
                jsonParameter.ParameterName = "@params";
                jsonParameter.Value = jsonInput;
                jsonParameter.DbType = DbType.String;
                command.Parameters.Add(jsonParameter);

                var codeParameter = command.CreateParameter();
                codeParameter.ParameterName = "@code";
                codeParameter.DbType = DbType.Int32;
                codeParameter.Direction = ParameterDirection.Output;
                command.Parameters.Add(codeParameter);

                var messageParameter = command.CreateParameter();
                messageParameter.ParameterName = "@message";
                messageParameter.DbType = DbType.String;
                messageParameter.Direction = ParameterDirection.Output;
                messageParameter.Size = 2000;
                command.Parameters.Add(messageParameter);

                var dataSet = new DataSet();

                // 根據 provider 建立並使用 DataAdapter
                if (_provider == "SqlServer")
                {
                    using var adapter = new SqlDataAdapter(command as SqlCommand);
                    adapter.Fill(dataSet);
                }
                else
                {
                    throw new NotSupportedException("Unsupported database provider");
                }

                return new ApiResult
                {
                    Code = codeParameter.Value?.ToString() ?? "-1",
                    Message = messageParameter.Value?.ToString() ?? string.Empty,
                    Data = dataSet
                };
            }
            catch (Exception ex)
            {
                return new ApiResult
                {
                    Code = "-1",
                    Message = ex.Message,
                    Data = new DataSet()
                };
            }
        }

        /// <summary>
        /// 透過 FunctionID 讀取對應的 SQL 檔案並執行
        /// SQL 檔案路徑：Query/{FunctionID}.sql
        /// </summary>
        public ApiResult ExecuteQuery(ObjRequest request)
        {
            // 驗證並萃取合法的 FunctionID（僅允許英文字母開頭 + 英數底線，長度 ≤ 50）
            var functionIdMatch = SafeFunctionIdPattern.Match(request.FunctionID ?? "");
            if (!functionIdMatch.Success)
            {
                return new ApiResult
                {
                    Code = "-1",
                    Message = "無效的功能識別碼",
                    Data = new DataSet()
                };
            }
            string sanitizedFunctionId = functionIdMatch.Value;

            // 從靜態登錄檔取得 SQL 腳本
            if (!Query.SqlQueryRegistry.TryGetSql(sanitizedFunctionId, out string sqlScript))
            {
                return new ApiResult
                {
                    Code = "-1",
                    Message = $"找不到查詢：{sanitizedFunctionId}",
                    Data = new DataSet()
                };
            }

            // 使用 using 確保連線會被正確關閉和釋放
            using IDbConnection connection = CreateConnection();

            try
            {
                connection.Open();
                using var command = connection.CreateCommand();

                command.CommandTimeout = 30;
                command.CommandType = CommandType.Text;
                command.CommandText = sqlScript;

                // 將 request.ObjParams 轉換成 JSON 字串
                var jsonInput = request.ObjParams == null ? "{}" :
                    System.Text.Json.JsonSerializer.Serialize(request.ObjParams);

                // 設置參數 - 在 SQL 腳本中會宣告 @params，我們透過變數傳遞
                var jsonParameter = command.CreateParameter();
                jsonParameter.ParameterName = "@params";
                jsonParameter.Value = jsonInput;
                jsonParameter.DbType = DbType.String;
                command.Parameters.Add(jsonParameter);

                var dataSet = new DataSet();

                // 執行 SQL 並填充 DataSet
                if (_provider == "SqlServer")
                {
                    using var adapter = new SqlDataAdapter(command as SqlCommand);
                    adapter.Fill(dataSet);
                }
                else
                {
                    throw new NotSupportedException("Unsupported database provider");
                }

                // 解析最後一個結果集，取得 Code 和 Message
                string code = "-1";
                string message = "執行失敗";

                if (dataSet.Tables.Count > 0)
                {
                    var lastTable = dataSet.Tables[dataSet.Tables.Count - 1];
                    if (lastTable.Rows.Count > 0)
                    {
                        var row = lastTable.Rows[0];
                        if (lastTable.Columns.Contains("Code"))
                        {
                            code = row["Code"]?.ToString() ?? "-1";
                        }
                        if (lastTable.Columns.Contains("Message"))
                        {
                            message = row["Message"]?.ToString() ?? string.Empty;
                        }
                    }

                    // 移除最後一個結果集（Code/Message），只保留資料結果集
                    if (dataSet.Tables.Count > 1)
                    {
                        dataSet.Tables.RemoveAt(dataSet.Tables.Count - 1);
                    }
                    else
                    {
                        // 如果只有一個結果集且是 Code/Message，清空 DataSet
                        if (lastTable.Columns.Contains("Code") && lastTable.Columns.Contains("Message") && lastTable.Columns.Count == 2)
                        {
                            dataSet.Tables.Clear();
                        }
                    }
                }

                return new ApiResult
                {
                    Code = code,
                    Message = message,
                    Data = dataSet
                };
            }
            catch (Exception ex)
            {
                return new ApiResult
                {
                    Code = "-1",
                    Message = ex.Message,
                    Data = new DataSet()
                };
            }
        }
    }
}