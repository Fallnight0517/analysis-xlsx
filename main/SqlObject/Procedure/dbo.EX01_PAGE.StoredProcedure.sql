USE [Ex01Db]
GO
SET ANSI_NULLS ON
GO
SET QUOTED_IDENTIFIER ON
GO

-- =============================================
-- Author:		Fallnight0517
-- Create date: 2026/08/19
-- Description:	分頁查詢單一資料集的資料列
-- =============================================
-- 參數（@params 是一包 JSON，由 DBService.ExecuteProcedure 序列化 ObjParams 而來）：
--   DatasetId  : 資料集 GUID
--   Page       : 0-based 頁碼
--   PageSize   : 每頁筆數
--   WantHeader : '1' / '0'，只有第一次載入該資料集時才要表頭
--
-- 回傳：成功時「固定 3 個結果集」
--   Table  (0) 中介資料：ColumnCount / TotalRows / HasHeader / Page，恰好 1 列
--   Table1 (1) 表頭列的 RowJson：0 或 1 列
--   Table2 (2) 本頁資料列：LineNum / RowJson，0..PageSize 列
--
-- ★★ 結果集的數量必須固定 ★★
--   前端是「按位置」取結果集的（Table / Table1 / Table2）。
--   舊版 C# 是「WantHeader 為 false 就不查表頭」（Class/EX01.cs:201），
--   如果照搬成 IF 包住那句 SELECT，不要表頭時 Table2 就會變成 Table1，
--   資料整份錯位，而且不會拋任何錯誤。
--   所以表頭那句 SELECT 永遠執行，用 WHERE 條件讓它在不需要時回 0 列。
--
-- 分頁用 LineNum 範圍查詢，不用 OFFSET/FETCH：LineNum 是連號的，
-- 而且既有專案的預存程序沒有任何一支做伺服器端分頁，不需要在這裡發明新慣例。
-- totalPages 的除法留給前端算（既有專案的分頁數學一律在前端）。
-- =============================================
CREATE OR ALTER procedure [dbo].[EX01_PAGE] (@params nvarchar(max), @code int out ,@message nvarchar(2000) out)
as
begin
	DECLARE @DatasetId	uniqueidentifier	= JSON_VALUE(@params, '$.DatasetId')
	DECLARE @Page		int					= JSON_VALUE(@params, '$.Page')
	DECLARE @PageSize	int					= JSON_VALUE(@params, '$.PageSize')
	DECLARE @WantHeader	bit					= JSON_VALUE(@params, '$.WantHeader')

	SET NOCOUNT ON;
	SET @code = 1;
	SET @message = '';

	DECLARE @HasHeader bit, @ColumnCount int, @TotalRows int;

	SELECT	@HasHeader   = HasHeader,
			@ColumnCount = ColumnCount,
			@TotalRows   = TotalRows
	FROM	Ex01Dataset
	WHERE	DatasetId = @DatasetId

	IF @@ROWCOUNT = 0
	BEGIN
		SET @code = 99;
		SET @message = '查無此資料集';
		RETURN;
	END

	-- HasHeader 時 LineNum=0 是標題列，資料從 LineNum=1 開始。
	DECLARE @FirstDataLine	int = CASE WHEN @HasHeader = 1 THEN 1 ELSE 0 END;
	DECLARE @FromLine		int = @FirstDataLine + @Page * @PageSize;
	DECLARE @ToLine			int = CASE WHEN @FirstDataLine + @Page * @PageSize + @PageSize < @TotalRows
									   THEN @FirstDataLine + @Page * @PageSize + @PageSize
									   ELSE @TotalRows END;
	-- 扣掉標題列之後的「資料列」筆數，前端用它算 totalPages。
	DECLARE @DataRowCount	int = CASE WHEN @TotalRows - @FirstDataLine > 0
									   THEN @TotalRows - @FirstDataLine
									   ELSE 0 END;

	-- 結果集 0：中介資料
	SELECT	@ColumnCount	AS ColumnCount,
			@DataRowCount	AS TotalRows,
			@HasHeader		AS HasHeader,
			@Page			AS Page

	-- 結果集 1：表頭（不需要時回 0 列，但這句 SELECT 一定會執行）
	SELECT	RowJson
	FROM	Ex01Row
	WHERE	DatasetId = @DatasetId
			AND LineNum = 0
			AND @WantHeader = 1
			AND @HasHeader = 1

	-- 結果集 2：本頁資料列（@FromLine >= @ToLine 時自然回 0 列）
	SELECT	LineNum, RowJson
	FROM	Ex01Row
	WHERE	DatasetId = @DatasetId
			AND LineNum >= @FromLine
			AND LineNum <  @ToLine
	ORDER BY LineNum

end
GO
