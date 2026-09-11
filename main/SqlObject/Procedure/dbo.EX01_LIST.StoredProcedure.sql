USE [Ex01Db]
GO
SET ANSI_NULLS ON
GO
SET QUOTED_IDENTIFIER ON
GO

-- =============================================
-- Author:		Fallnight0517
-- Create date: 2026/08/19
-- Description:	列出指定使用者上傳過的資料集
-- =============================================
-- 參數（@params 是一包 JSON，由 DBService.ExecuteProcedure 序列化 ObjParams 而來）：
--   USER_ID : 上傳者代號
-- 回傳：1 個結果集（資料集清單，可能 0 列）
-- =============================================
CREATE OR ALTER procedure [dbo].[EX01_LIST] (@params nvarchar(max), @code int out ,@message nvarchar(2000) out)
as
begin
	-- 純量參數用 JSON_VALUE 取，一個參數一行、宣告時就初始化。
	-- 這是既有專案 XML 版 @InputXML.value(N'(/root/X)[1]', 'type') 的 JSON 對應寫法。
	-- ★JSON_VALUE 有 4000 字元上限，只能用在純量；大包陣列要用 OPENJSON（見 EX01_SAVE）。
	DECLARE @USER_ID nvarchar(50) = JSON_VALUE(@params, '$.USER_ID')

	SET NOCOUNT ON;
	SET @code = 1;
	SET @message = '';

	-- 查無資料不是錯誤：一律回 @code = 1 加一個空結果集，由前端自己判斷 length 是否為 0。
	-- （舊版 Class/EX01.cs:137-141 是回 success = false，那是把「沒有資料」當成「查詢失敗」。）
	SELECT	DatasetId, FileName, UploadUser,
			CONVERT(VARCHAR, UploadTime, 120) AS UploadTime,
			HasHeader, ColumnCount, TotalRows
	FROM	Ex01Dataset
	WHERE	UploadUser = @USER_ID
	ORDER BY UploadTime DESC

end
GO
