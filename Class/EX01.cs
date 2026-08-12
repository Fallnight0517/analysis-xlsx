using System.Collections;
using System.Data;
using Microsoft.Data.SqlClient;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using xlsx_poc.Utility;

namespace xlsx_poc.Class;

public class EX01
{
    // 分塊上傳（parser 解析出來的 NDJSON，每塊約 500 列送一次）。
    // IsFirst 時先建 Ex01Dataset 一筆；每塊把 Lines 依序寫進 Ex01Row（LineNum = StartLine + i）；
    // IsLast 時回填 TotalRows 與 ColumnCount。整塊寫入包在同一個交易內，中途失敗不會留下半份資料。
    //
    // ★ColumnCount 在 IsFirst 時只是暫時值：Worker 是邊解壓邊串流輸出，「整份檔案最寬
    //   那一列」的真正欄數要掃完全檔才知道，所以 IsFirst 先用 0（或前端當下已知的估計值）
    //   佔位建立資料集，等 IsLast（Worker 已經跑完）時才用真正的 ColumnCount 回填。
    static public Dictionary<string, object> EX01_SAVE(Dictionary<string, string> Udata, JObject obj, ref Dictionary<string, object> ResultJsonObjet)
    {
        if (obj["Data"] == null)
        {
            throw new Exception("參數錯誤");
        }
        JObject objData = JObject.Parse(obj["Data"]!.ToString());
        String message = string.Empty;
        Boolean success = false;
        try
        {
            Guid datasetId = Guid.Parse(objData["DatasetId"]!.ToString());
            bool isFirst = objData["IsFirst"]?.ToObject<bool>() ?? false;
            bool isLast = objData["IsLast"]?.ToObject<bool>() ?? false;
            int startLine = objData["StartLine"]?.ToObject<int>() ?? 0;
            JArray lines = (JArray?)objData["Lines"] ?? new JArray();

            if (isFirst)
            {
                ArrayList insertParams = new ArrayList
                {
                    new SqlParameter("@DatasetId", datasetId),
                    new SqlParameter("@FileName", objData["FileName"]?.ToString() ?? string.Empty),
                    new SqlParameter("@UploadUser", Udata["USER_ID"]),
                    new SqlParameter("@HasHeader", objData["HasHeader"]?.ToObject<bool>() ?? true),
                    new SqlParameter("@ColumnCount", objData["ColumnCount"]?.ToObject<int>() ?? 0),
                };
                MSDA.ExecuteNonQuery(
                    @"INSERT INTO Ex01Dataset (DatasetId, FileName, UploadUser, HasHeader, ColumnCount)
                      VALUES (@DatasetId, @FileName, @UploadUser, @HasHeader, @ColumnCount)",
                    insertParams);
            }

            using (SqlConnection cn = MSDA.GetConnection())
            {
                cn.Open();
                using (SqlTransaction trans = cn.BeginTransaction())
                {
                    for (int i = 0; i < lines.Count; i++)
                    {
                        ArrayList rowParams = new ArrayList
                        {
                            new SqlParameter("@DatasetId", datasetId),
                            new SqlParameter("@LineNum", startLine + i),
                            new SqlParameter("@RowJson", lines[i]!.ToString()),
                        };
                        MSDA.ExecuteNonQuery(
                            "INSERT INTO Ex01Row (DatasetId, LineNum, RowJson) VALUES (@DatasetId, @LineNum, @RowJson)",
                            rowParams, trans, cn);
                    }
                    trans.Commit();
                }
            }

            if (isLast)
            {
                ArrayList updateParams = new ArrayList
                {
                    new SqlParameter("@DatasetId", datasetId),
                    new SqlParameter("@TotalRows", startLine + lines.Count),
                    new SqlParameter("@ColumnCount", objData["ColumnCount"]?.ToObject<int>() ?? 0),
                };
                MSDA.ExecuteNonQuery(
                    "UPDATE Ex01Dataset SET TotalRows=@TotalRows, ColumnCount=@ColumnCount WHERE DatasetId=@DatasetId",
                    updateParams);
            }

            success = true;
            message = "儲存成功";
            ResultJsonObjet["success"] = success;
            ResultJsonObjet["message"] = message;
            return ResultJsonObjet;
        }
        catch (Exception ex)
        {
            BaseUtility.WriteLog(ex);
            message = "儲存失敗";
            ResultJsonObjet["success"] = false;
            ResultJsonObjet["message"] = message + ex.Message;
            return ResultJsonObjet;
        }
        finally
        {
            Udata["MSG"] = message;
            Udata["RDATA"] = obj["Data"]!.ToString();
            BaseUtility.SY006(Udata);
        }
    }

    // 列出目前使用者上傳過的資料集。本地無 SSO，Udata["USER_ID"] 固定是 "local"（見 ApiController）。
    static public Dictionary<string, object> EX01_LIST(Dictionary<string, string> Udata, JObject obj, ref Dictionary<string, object> ResultJsonObjet)
    {
        ArrayList parameters = new ArrayList();
        String strSql = string.Empty;
        DataTable? dtResult = null;
        String message = string.Empty;
        Boolean success = false;
        try
        {
            parameters.Add(new SqlParameter("@USER_ID", Udata["USER_ID"]));

            #region SQL
            strSql = @"SELECT DatasetId, FileName, UploadUser,
                              CONVERT(VARCHAR, UploadTime, 120) AS UploadTime,
                              HasHeader, ColumnCount, TotalRows
                       FROM Ex01Dataset
                       WHERE UploadUser = @USER_ID
                       ORDER BY UploadTime DESC";
            #endregion

            dtResult = MSDA.GetDataTable(strSql, parameters, "EX01_LIST");

            if (dtResult != null && dtResult.Rows.Count > 0)
            {
                success = true;
                message = "查詢成功";
                ResultJsonObjet["data"] = JsonConvert.SerializeObject(dtResult, Formatting.Indented);
            }
            else
            {
                success = false;
                message = "查無資料";
            }
            ResultJsonObjet["success"] = success;
            ResultJsonObjet["message"] = message;
            return ResultJsonObjet;
        }
        catch (Exception ex)
        {
            BaseUtility.WriteLog(ex);
            message = "查詢失敗";
            ResultJsonObjet["success"] = false;
            ResultJsonObjet["message"] = message + ex.Message;
            return ResultJsonObjet;
        }
        finally
        {
            Udata["MSG"] = message;
            Udata["RDATA"] = obj["Data"]?.ToString() ?? string.Empty;
            BaseUtility.SY006(Udata);
        }
    }

    // 分頁查詢單一資料集的資料列。LineNum 連號，用範圍查詢即可，不必 OFFSET/FETCH。
    // WantHeader 只有第一次載入該資料集時傳 true（表頭只需要拿一次）。
    static public Dictionary<string, object> EX01_PAGE(Dictionary<string, string> Udata, JObject obj, ref Dictionary<string, object> ResultJsonObjet)
    {
        if (obj["Data"] == null)
        {
            throw new Exception("參數錯誤");
        }
        JObject objData = JObject.Parse(obj["Data"]!.ToString());
        String message = string.Empty;
        Boolean success = false;
        try
        {
            Guid datasetId = Guid.Parse(objData["DatasetId"]!.ToString());
            int page = objData["Page"]?.ToObject<int>() ?? 0;
            int pageSize = objData["PageSize"]?.ToObject<int>() ?? 10;
            bool wantHeader = objData["WantHeader"]?.ToObject<bool>() ?? false;

            ArrayList datasetParams = new ArrayList { new SqlParameter("@DatasetId", datasetId) };
            DataTable? dtDataset = MSDA.GetDataTable(
                "SELECT HasHeader, ColumnCount, TotalRows FROM Ex01Dataset WHERE DatasetId=@DatasetId",
                datasetParams, "EX01_PAGE_DATASET");

            if (dtDataset == null)
            {
                ResultJsonObjet["success"] = false;
                ResultJsonObjet["message"] = "查無此資料集";
                return ResultJsonObjet;
            }

            bool hasHeader = (bool)dtDataset.Rows[0]["HasHeader"];
            int columnCount = (int)dtDataset.Rows[0]["ColumnCount"];
            int totalRows = (int)dtDataset.Rows[0]["TotalRows"];

            int firstDataLine = hasHeader ? 1 : 0;
            int fromLine = firstDataLine + page * pageSize;
            int toLine = Math.Min(fromLine + pageSize, totalRows);

            JArray? header = null;
            if (wantHeader && hasHeader)
            {
                ArrayList headerParams = new ArrayList
                {
                    new SqlParameter("@DatasetId", datasetId),
                    // ★字面常數 0 會被 C# 解析成 SqlParameter(name, SqlDbType) 那個多載
                    //   （int 常數 0 可隱含轉型成任何 enum，剛好等於 SqlDbType.BigInt），
                    //   等於「有型別、沒有值」，執行時會報 @LineNum 未提供。用 (object)0 強制走值多載。
                    new SqlParameter("@LineNum", (object)0),
                };
                DataTable? dtHeader = MSDA.GetDataTable(
                    "SELECT RowJson FROM Ex01Row WHERE DatasetId=@DatasetId AND LineNum=@LineNum",
                    headerParams, "EX01_PAGE_HEADER");
                if (dtHeader != null)
                {
                    header = JArray.Parse(dtHeader.Rows[0]["RowJson"].ToString()!);
                }
            }

            JArray rows = new JArray();
            if (fromLine < toLine)
            {
                ArrayList rowParams = new ArrayList
                {
                    new SqlParameter("@DatasetId", datasetId),
                    new SqlParameter("@FromLine", fromLine),
                    new SqlParameter("@ToLine", toLine),
                };
                #region SQL
                DataTable? dtRows = MSDA.GetDataTable(
                    @"SELECT LineNum, RowJson FROM Ex01Row
                      WHERE DatasetId=@DatasetId AND LineNum>=@FromLine AND LineNum<@ToLine
                      ORDER BY LineNum",
                    rowParams, "EX01_PAGE_ROWS");
                #endregion

                if (dtRows != null)
                {
                    foreach (DataRow dr in dtRows.Rows)
                    {
                        rows.Add(JArray.Parse(dr["RowJson"].ToString()!));
                    }
                }
            }

            // 參考文件的 data 格式只列了 columnCount/header/rows；totalRows/totalPages 是
            // 額外加的欄位，讓前端不用重複算「扣掉表頭列」的分頁邏輯（後端已經知道 hasHeader）。
            int dataRowCount = Math.Max(0, totalRows - firstDataLine);
            int totalPages = Math.Max(1, (int)Math.Ceiling(dataRowCount / (double)pageSize));

            JObject payload = new JObject
            {
                ["columnCount"] = columnCount,
                ["header"] = header,
                ["rows"] = rows,
                ["totalRows"] = dataRowCount,
                ["totalPages"] = totalPages,
                ["page"] = page,
            };

            success = true;
            message = "查詢成功";
            ResultJsonObjet["data"] = payload.ToString(Formatting.Indented);
            ResultJsonObjet["success"] = success;
            ResultJsonObjet["message"] = message;
            return ResultJsonObjet;
        }
        catch (Exception ex)
        {
            BaseUtility.WriteLog(ex);
            message = "查詢失敗";
            ResultJsonObjet["success"] = false;
            ResultJsonObjet["message"] = message + ex.Message;
            return ResultJsonObjet;
        }
        finally
        {
            Udata["MSG"] = message;
            Udata["RDATA"] = obj["Data"]!.ToString();
            BaseUtility.SY006(Udata);
        }
    }
}
