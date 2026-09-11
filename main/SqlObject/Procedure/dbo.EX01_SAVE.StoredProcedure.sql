USE [Ex01Db]
GO
SET ANSI_NULLS ON
GO
SET QUOTED_IDENTIFIER ON
GO

-- =============================================
-- Author:		Fallnight0517
-- Create date: 2026/08/19
-- Description:	分塊寫入上傳的資料集（前端解析 xlsx 後每 500 列送一次）
-- =============================================
-- 參數（@params 是一包 JSON，由 DBService.ExecuteProcedure 序列化 ObjParams 而來）：
--   DatasetId   : 資料集 GUID
--   FileName    : 原始檔名（只有 IsFirst 用得到）
--   USER_ID     : 上傳者代號（Controller 注入）
--   HasHeader   : '1' / '0'
--   ColumnCount : IsFirst 時是佔位值 0，IsLast 時才是真正的欄數
--   StartLine   : 這一塊的第一列在整份檔案中的 0-based 列號
--   IsFirst     : '1' / '0'，第一塊時要先建 Ex01Dataset
--   IsLast      : '1' / '0'，最後一塊時回填 TotalRows 與 ColumnCount
--   Lines       : 「一整批」列資料，JSON.stringify 過的字串陣列
--                 形如 ["[\"a\",\"b\"]", "[\"c\",\"d\"]"]
--                 每個元素解碼後就是一列的 RowJson
--
-- 回傳：成功時 1 個結果集（一列 'success'）；失敗時 0 個結果集（@code = 99）
--
-- ★★ 這支 SP 的重點：round-trip 從 500 降到 1 ★★
--   舊版是 C# 迴圈跑 500 次 ExecuteNonQuery（Class/EX01.cs:57-68），
--   每一列都是一趟完整的網路往返。
--   現在整批 JSON 一次進來，OPENJSON 展開成 500 個資料列，一句 INSERT ... SELECT 寫完。
--
-- ★★ 絕對不能用 JSON_VALUE 取 Lines ★★
--   JSON_VALUE 有 4000 字元硬上限，500 列必定超過，
--   而且超過時是「回 NULL、不報錯」——資料會靜靜地不見。
--   必須用 OPENJSON(...) WITH (Lines nvarchar(max) '$.Lines')，它沒有長度限制。
--
-- ★★ 交易範圍比舊版更完整 ★★
--   舊版的「IsFirst 建 Ex01Dataset」那一句在交易外面（Class/EX01.cs:46-49，
--   交易從第 52 行才開始），建完 dataset 之後寫列失敗會留下一個空殼 dataset。
--   現在三件事（建 dataset / 寫列 / 回填）在同一個交易裡。
-- =============================================
CREATE OR ALTER procedure [dbo].[EX01_SAVE] (@params nvarchar(max), @code int out ,@message nvarchar(2000) out)
as
begin
	DECLARE @DatasetId		uniqueidentifier	= JSON_VALUE(@params, '$.DatasetId')
	DECLARE @FileName		nvarchar(260)		= JSON_VALUE(@params, '$.FileName')
	DECLARE @UploadUser		nvarchar(50)		= JSON_VALUE(@params, '$.USER_ID')
	DECLARE @HasHeader		bit					= JSON_VALUE(@params, '$.HasHeader')
	DECLARE @ColumnCount	int					= JSON_VALUE(@params, '$.ColumnCount')
	DECLARE @StartLine		int					= JSON_VALUE(@params, '$.StartLine')
	DECLARE @IsFirst		bit					= JSON_VALUE(@params, '$.IsFirst')
	DECLARE @IsLast			bit					= JSON_VALUE(@params, '$.IsLast')

	-- 見上面「絕對不能用 JSON_VALUE」。ISNULL 對應舊版的 (JArray?)objData["Lines"] ?? new JArray()。
	DECLARE @Lines nvarchar(max) =
		(SELECT Lines FROM OPENJSON(@params) WITH (Lines nvarchar(max) '$.Lines'))
	SET @Lines = ISNULL(@Lines, N'[]')

	SET NOCOUNT ON;
	SET @code = 1;
	SET @message = '';

	-- ★@S1 / @S3 必須在 IF 外面就給初值 0。
	--   T-SQL 的變數宣告雖然是整個批次可見，但「DECLARE @x int = 0」的賦值只有
	--   執行到那一行才會發生；寫在 IF 裡面而該分支沒跑到的話，變數會是 NULL，
	--   下面的 IF @S1 = 0 就永遠不成立，於是明明成功卻被 ROLLBACK。
	DECLARE @S1 int = 0;
	DECLARE @S2 int = 0;
	DECLARE @S3 int = 0;
	DECLARE @RowsWritten int = 0;

	BEGIN TRANSACTION

	-- 第一塊：建立資料集。ColumnCount 此時只是佔位值，IsLast 時才回填真正的欄數
	-- （Worker 是邊解壓邊串流輸出，「整份檔案最寬那一列」要掃完全檔才知道）。
	IF @IsFirst = 1
	BEGIN
		INSERT INTO Ex01Dataset (DatasetId, FileName, UploadUser, HasHeader, ColumnCount)
		VALUES (@DatasetId, @FileName, @UploadUser, @HasHeader, @ColumnCount)
		SELECT @S1 = @@ERROR
	END

	-- 每一塊都要做：整批寫入。
	-- OPENJSON 不加 WITH 時，對陣列會回傳 [key]（0-based 索引，nvarchar，要 CAST）
	-- 和 [value]（該元素的內容）。Lines 的元素是字串，所以 [value] 就是解碼後的 RowJson。
	-- LineNum = StartLine + 索引，對應舊版的 startLine + i（Class/EX01.cs:62）。
	INSERT INTO Ex01Row (DatasetId, LineNum, RowJson)
	SELECT	@DatasetId, @StartLine + CAST([key] AS int), [value]
	FROM	OPENJSON(@Lines)
	SELECT @S2 = @@ERROR, @RowsWritten = @@ROWCOUNT

	-- 最後一塊：回填總筆數與真正的欄數。
	IF @IsLast = 1
	BEGIN
		UPDATE	Ex01Dataset
		SET		TotalRows = @StartLine + @RowsWritten,
				ColumnCount = @ColumnCount
		WHERE	DatasetId = @DatasetId
		SELECT @S3 = @@ERROR
	END

	IF @S1 = 0 AND @S2 = 0 AND @S3 = 0
	BEGIN
		COMMIT TRANSACTION
		SELECT 'success' AS result
	END
	ELSE
	BEGIN
		ROLLBACK TRANSACTION
		SET @code = 99;
		SET @message = N'儲存失敗';
		RETURN;
	END

end
GO
