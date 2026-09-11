# analysis-xlsx

在瀏覽器內解析 `.xlsx`、分批上傳存進 MSSQL、再用分頁方式檢視內容。
ASP.NET Core（net10.0）同時擔任網站主機與一套**自建的最小 dispatch 後端**。

- **.xlsx 解析完全在瀏覽器內完成**：自行實作、零第三方相依的 ZIP + XML 解析器
  （見下方「[xlsx 解析器：自寫、零第三方相依](#xlsx-解析器自寫零第三方相依)」），
  在 Web Worker 裡邊解壓邊掃，不需要把整份檔案讀進記憶體。
- **資料持久化在 MSSQL**：解析出來的每一列分批（chunk）上傳、寫進資料庫；
  重新整理頁面、換一台瀏覽器都還能繼續看到之前上傳過的資料。
- **C# 不寫 SQL**：`FunctionID` 直接對應預存程序名稱，參數統一包成一個 `@params`
  JSON 字串由 SP 端用 `OPENJSON` 自己拆，回傳統一是 `ApiResult{Code, Message, Data}`。
  Controller 不認識任何一支 `FunctionID`，收到什麼就原封不動轉交——
  新增功能只要加一支 SP，C# 一行都不用改。

## 架構總覽

```
瀏覽器
├─ Views/Ex01/Index.cshtml(.js)      頁面骨架與 UI 邏輯（選檔、上傳進度、分頁顯示）
├─ wwwroot/js/Ex01/parser-worker.js  Web Worker：只做解析，把列資料分塊丟回主執行緒
├─ wwwroot/js/Ex01/xlsx-reader.js    自寫的 .xlsx 解析器（零第三方相依，見下方章節）
└─ wwwroot/js/Ex01/dispatch-client.js  前端 dispatch client（CapiDb / Table / Message）
        │  fetch POST /api/GetData    { FunctionID, ObjParams }   讀
        │  fetch POST /api/UpdateData { FunctionID, ObjParams }   寫
        ▼
Controllers/ApiController.cs        通用 dispatch，不認識任何 FunctionID
        │
        ▼
DB/DBService.cs                     ObjParams → 一包 JSON @params，
                                    CommandText = FunctionID，回 ApiResult
        │
        ▼
MSSQL 預存程序                       EX01_LIST ／ EX01_PAGE ／ EX01_SAVE
  （建立腳本在 SqlObject/Procedure/，版控用，執行期不讀檔）
        │
        ▼
MSSQL：Ex01Dataset、Ex01Row 兩張表
```

`DB/` 底下的四個檔案就是整個資料存取層：

| 檔案 | 角色 |
|---|---|
| `DB/ObjRequest.cs` | 進入 action 的信封：`FunctionID` + `Dictionary<string,string> ObjParams` |
| `DB/ApiResult.cs` | 離開 action 的信封：`Code` + `Message` + `DataSet Data` |
| `DB/DBService.cs` | 唯一會碰到 `SqlConnection` 的地方 |
| `DB/Query/SqlQueryRegistry.cs` | `ExecuteQuery` 路線用的登錄檔，目前是空的（本專案只走 `ExecuteProcedure`） |

## 資料庫存取方式的遷移：改動前後

早期版本的 SQL 是內嵌在 C# 字串裡、透過 static 的 `MSDA` 取得連線。
後來整套改成「`FunctionID` → 預存程序」的慣例，以下是檔案結構的前後對照。

### 改動前

```
xlsx_poc/
├─ Class/
│  └─ EX01.cs                      ★ SQL 字串內嵌在這裡（283 行）
├─ Controllers/
│  ├─ ApiController.cs             單一入口 /api/ApiWork，switch (FUNCTION_ID) 手寫分派
│  ├─ Ex01Controller.cs
│  └─ HomeController.cs
├─ Models/
│  └─ ErrorViewModel.cs
├─ Properties/
│  └─ launchSettings.json
├─ Utility/
│  ├─ BaseUtility.cs               WriteLog／SY006（操作記錄，no-op）
│  ├─ MSDA.cs                      ★ static 連線 + ExecuteNonQuery／GetDataTable
│  └─ MSSqlWork.cs                 ★ 動態組 WHERE 用
├─ Views/
│  ├─ Ex01/{Index.cshtml, Index.cshtml.js}
│  ├─ Shared/...
│  └─ {_ViewImports, _ViewStart}.cshtml
├─ wwwroot/
│  ├─ css/, favicon.ico, lib/
│  └─ js/Ex01/
│     ├─ dispatch-client.js        Capi／CapiAsync（{success, message, data} 信封）
│     ├─ parser-worker.js
│     └─ xlsx-reader.js
├─ appsettings.json                只有 ConnectionStrings
├─ Program.cs                      MSDA.Init(連線字串)
└─ xlsx_poc.csproj
```

### 改動後

```
xlsx_poc/
├─ Controllers/
│  ├─ ApiController.cs             ◆ 改：/api/GetData + /api/UpdateData，沒有 switch
│  ├─ Ex01Controller.cs
│  └─ HomeController.cs
├─ DB/                             ✚ 新增：整個資料存取層
│  ├─ ApiResult.cs                 ✚ 回應信封 {Code, Message, Data}
│  ├─ DBService.cs                 ✚ 唯一碰 SqlConnection 的地方（主管提供，只改 namespace 一行）
│  ├─ ObjRequest.cs                ✚ 請求信封 {FunctionID, ObjParams}
│  └─ Query/
│     └─ SqlQueryRegistry.cs       ✚ 空登錄檔（只為了讓 DBService.cs 不用改就能編譯）
├─ Models/
│  └─ ErrorViewModel.cs
├─ Properties/
│  └─ launchSettings.json
├─ SqlObject/                      ✚ 新增：SQL 物件腳本（版控用，執行期不讀檔）
│  └─ Procedure/
│     ├─ dbo.EX01_LIST.StoredProcedure.sql
│     ├─ dbo.EX01_PAGE.StoredProcedure.sql
│     └─ dbo.EX01_SAVE.StoredProcedure.sql
├─ Utility/
│  └─ BaseUtility.cs               ◆ 改：暫無呼叫者，保留當作「操作記錄該放哪一層」的標記
├─ Views/
│  ├─ Ex01/
│  │  ├─ Index.cshtml
│  │  └─ Index.cshtml.js           ◆ 改：三個呼叫點改用新信封
│  ├─ Shared/...
│  └─ {_ViewImports, _ViewStart}.cshtml
├─ wwwroot/
│  ├─ css/, favicon.ico, lib/
│  └─ js/Ex01/
│     ├─ dispatch-client.js        ◆ 改：CapiDb／Table（{Code, Message, Data} 信封）
│     ├─ parser-worker.js          ── 完全未改動
│     └─ xlsx-reader.js            ── 完全未改動
├─ appsettings.json                ◆ 改：加 DBProvider + ConnectionName
├─ Program.cs                      ◆ 改：MSDA.Init → AddScoped<IDBService, DBService>
└─ xlsx_poc.csproj                 ◆ 改：把 SqlObject/**/*.sql 納入版控清單

✘ 已刪除：Class/EX01.cs、Utility/MSDA.cs、Utility/MSSqlWork.cs
```

### 逐檔對照

| 檔案 | 變化 | 行數 | 說明 |
| --- | --- | --- | --- |
| `Class/EX01.cs` | ✘ 刪除 | 283 → 0 | SQL 全搬進預存程序；Controller 與資料存取層之間不需要中間層 |
| `Utility/MSDA.cs` | ✘ 刪除 | 64 → 0 | 連線改由 DI 提供給 `DBService` |
| `Utility/MSSqlWork.cs` | ✘ 刪除 | 10 → 0 | 動態組 WHERE 用不到了（其實在改動前就已經沒有呼叫者） |
| `DB/DBService.cs` | ✚ 新增 | 254 | 主管提供的檔案，**只改 namespace 那一行** |
| `DB/ObjRequest.cs` | ✚ 新增 | 25 | |
| `DB/ApiResult.cs` | ✚ 新增 | 47 | |
| `DB/Query/SqlQueryRegistry.cs` | ✚ 新增 | 34 | 空登錄檔，見檔內註解 |
| `SqlObject/Procedure/*.sql` | ✚ 新增 | 252（3 檔） | SQL 從 C# 搬到這裡 |
| `Controllers/ApiController.cs` | ◆ 修改 | 42 → 61 | 拿掉 `switch`，換成兩個通用 dispatch action |
| `Views/Ex01/Index.cshtml.js` | ◆ 修改 | 482 → 513 | 只動三個 API 呼叫點，渲染邏輯完全沒動 |
| `wwwroot/js/Ex01/dispatch-client.js` | ◆ 修改 | 45 → 54 | 換信封 |
| `Program.cs` | ◆ 修改 | 51 → 59 | DI 註冊取代 static 初始化 |
| `appsettings.json` | ◆ 修改 | 12 → 14 | |
| `Utility/BaseUtility.cs` | ◆ 修改 | 34 → 40 | 只加了說明為何保留的註解 |
| `wwwroot/js/Ex01/xlsx-reader.js` | ── 未動 | 870 | **解析器完全不受影響** |
| `wwwroot/js/Ex01/parser-worker.js` | ── 未動 | 90 | 同上 |
| `Views/Ex01/Index.cshtml` | ── 未動 | 72 | 版面沒有變 |

重點有兩個：**自寫的 xlsx 解析器（960 行）一個字都沒動**——這次改的是資料怎麼進資料庫，
跟怎麼解析檔案無關；以及**C# 的資料存取程式碼淨減少**，357 行手寫的 SQL／連線管理
換成 `DB/` 底下四個檔案，其中最大的那個（254 行）是既有的、一字未改。

## 執行需求

- .NET 10 SDK
- 一個本機可連的 SQL Server（LocalDB、SQL Server Express、或任何具名執行個體），
  Windows 驗證即可，不需要另外建帳號密碼

## 快速開始

1. 建立資料庫：

   ```sql
   CREATE DATABASE Ex01Db;
   ```

2. 在 `Ex01Db` 底下執行以下建表 SQL：

   ```sql
   CREATE TABLE Ex01Dataset (
       DatasetId   UNIQUEIDENTIFIER NOT NULL PRIMARY KEY,
       FileName    NVARCHAR(260)    NOT NULL,
       UploadUser  NVARCHAR(50)     NULL,
       UploadTime  DATETIME2        NOT NULL CONSTRAINT DF_Ex01Dataset_UploadTime DEFAULT (SYSDATETIME()),
       HasHeader   BIT              NOT NULL CONSTRAINT DF_Ex01Dataset_HasHeader   DEFAULT (1),
       ColumnCount INT              NOT NULL CONSTRAINT DF_Ex01Dataset_ColumnCount DEFAULT (0),
       TotalRows   INT              NOT NULL CONSTRAINT DF_Ex01Dataset_TotalRows   DEFAULT (0)
       -- TotalRows：ROWCOUNT 是 T-SQL 保留字，故欄位改名 TotalRows。
   );

   CREATE TABLE Ex01Row (
       DatasetId UNIQUEIDENTIFIER NOT NULL,
       LineNum   INT              NOT NULL,   -- 0-based；HasHeader 時 LineNum=0 為標題列
       RowJson   NVARCHAR(MAX)    NOT NULL,   -- 一行 NDJSON（一個 JSON 陣列字串）
       CONSTRAINT PK_Ex01Row PRIMARY KEY (DatasetId, LineNum),
       CONSTRAINT FK_Ex01Row_Dataset FOREIGN KEY (DatasetId) REFERENCES Ex01Dataset(DatasetId) ON DELETE CASCADE
   );
   ```

3. 把 `appsettings.json` 裡的連線字串改成你自己的執行個體名稱：

   ```json
   "ConnectionStrings": {
     "Ex01Db": "Server=YOUR_SERVER\\INSTANCE;Database=Ex01Db;Trusted_Connection=True;TrustServerCertificate=True;"
   }
   ```

   （LocalDB 通常是 `Server=(localdb)\MSSQLLocalDB;...`；預設 Express 通常是 `Server=.\SQLEXPRESS;...`。）

4. **建立三支預存程序**（漏掉這步的話三個功能全部都不會動）：

   ```bash
   sqlcmd -S "你的執行個體" -d Ex01Db -E -C -f 65001 -i SqlObject/Procedure/dbo.EX01_LIST.StoredProcedure.sql
   sqlcmd -S "你的執行個體" -d Ex01Db -E -C -f 65001 -i SqlObject/Procedure/dbo.EX01_PAGE.StoredProcedure.sql
   sqlcmd -S "你的執行個體" -d Ex01Db -E -C -f 65001 -i SqlObject/Procedure/dbo.EX01_SAVE.StoredProcedure.sql
   ```

   （也可以直接用 SSMS 開這三個檔案執行。腳本是 `CREATE OR ALTER`，重跑不會出錯。）

   `EX01_SAVE` 用到 `OPENJSON`，需要相容性層級 ≥ 130：

   ```sql
   SELECT compatibility_level FROM sys.databases WHERE name = 'Ex01Db';
   -- 若小於 130：ALTER DATABASE Ex01Db SET COMPATIBILITY_LEVEL = 130;
   ```

5. 執行：

   ```bash
   dotnet run
   ```

   開啟 <http://localhost:5279/>（見 `Properties/launchSettings.json` 的 `http` profile）。
   `/` 由 `Ex01Controller` 提供，即本專案唯一的功能頁面。

## 使用方式

1. 「① 選擇檔案」選一個 `.xlsx`。
2. 「② 讀取資料並上傳」：瀏覽器內解析成資料列，每約 500 列分一塊，依序呼叫
   `EX01_SAVE` 存進資料庫；讀取進度（解壓百分比）與上傳筆數（即時計數）分開顯示，
   兩者是獨立的兩件事——解析速度跟上傳速度本來就會脫鉤。
3. 「③ 資料內容」：透過下拉選單選擇任一筆已上傳的資料集（`EX01_LIST`），
   分頁瀏覽其內容（`EX01_PAGE`）。重新整理頁面後，資料集清單與內容都還在。

## 後端 API 契約

兩個入口，讀寫分開：**`POST /api/GetData`**（查詢）與 **`POST /api/UpdateData`**（寫入）。
body 一律是 `{ "FunctionID": "...", "ObjParams": { ... } }`。

**`ObjParams` 的值必須全部是字串**（後端宣告是 `Dictionary<string, string>`）：
布林送 `"1"` / `"0"`（送 `"true"` 會讓 SP 端 CAST 成 `BIT` 時直接失敗），
數字自己轉字串，陣列 `JSON.stringify` 成一個字串。

回應一律是：

```json
{ "Code": "1", "Message": "", "Data": { "Table": [...], "Table1": [...] } }
```

- `Code` 是**字串**：`"1"` 成功、`"99"` 業務失敗、`"-1"` 參數錯誤或例外
- `Data` 是序列化後的 `DataSet`——**不是陣列**，是以資料表名稱為鍵的物件。
  第一個結果集叫 `Table`（沒有數字後綴），第二個才是 `Table1`

| FunctionID | 端點 | ObjParams | 回傳的結果集 |
| --- | --- | --- | --- |
| `EX01_LIST` | `GetData` | 無（`USER_ID` 由 Controller 注入） | `Table`＝資料集清單（查無資料時為空陣列，**不是錯誤**） |
| `EX01_PAGE` | `GetData` | `{ DatasetId, Page, PageSize, WantHeader }` | **固定三個**：`Table`＝中介資料、`Table1`＝表頭（0 或 1 列）、`Table2`＝本頁資料列 |
| `EX01_SAVE` | `UpdateData` | `{ DatasetId, FileName, HasHeader, ColumnCount, StartLine, Lines, IsFirst, IsLast }` | `Table`＝一列 `'success'` |

`EX01_SAVE` 的 `Lines` 是**一整批列**序列化成的單一字串，SP 端用 `OPENJSON` 一句
`INSERT ... SELECT` 寫完——**500 列只有 1 次 round-trip**，不是 500 次。

`EX01_PAGE` 的三個結果集**數量固定不變**：不需要表頭時 `Table1` 仍然存在、只是 0 列。
前端是按位置取結果集的，少一個 `SELECT` 會讓所有索引位移且不會報錯。

## 前端組成

- **`xlsx-reader.js` + `parser-worker.js`**：解析永遠在 Worker 內完成，只做解析、
  不打任何 API。解析出來的列先累積成一批（約 500 列），滿了就 `postMessage`
  回主執行緒，由主執行緒呼叫 `EX01_SAVE` 上傳——這樣設計是為了保留原本
  「邊解壓邊掃、記憶體不隨檔案大小成長」的串流特性，即使檔案很大，Worker
  也不需要等整份解析完才開始上傳。
- **`dispatch-client.js`**：`CapiDb(urlPage, functionId, objParams)` 是 fetch 版的
  最小 dispatch client，回傳 `{ Code, Message, Data }`；連線層級的錯誤也會回一個
  `Code: '-1'` 的信封而不是丟例外，讓呼叫端永遠只有一套判斷邏輯。
  `Table(apiResult, n)` 取第 n 個結果集（沒有就回空陣列）。
  `Message(msg)` 目前只是 `alert()`，之後要換成自訂彈窗只需要改這一個函式。
- **`Index.cshtml.js`**：頁面邏輯——選檔、建立 Worker、上傳佇列（保證依序送出、
  跟解析速度脫鉤）、資料集下拉選單、分頁渲染。`PAGE_SIZE`（每頁筆數）與
  `HAS_HEADER_ROW`（NDJSON 第 0 列是否為標題列）是檔案最上方的常數。

## xlsx 解析器：自寫、零第三方相依

`.xlsx` 解析由 [wwwroot/js/Ex01/xlsx-reader.js](wwwroot/js/Ex01/xlsx-reader.js) 負責，
**完全自行實作**，依 ECMA-376（OOXML）與 PKWARE APPNOTE（ZIP）規格撰寫，只用原生 Web API：

| 需求 | 用什麼 | 常見做法（本專案不用） |
| --- | --- | --- |
| 解壓 deflate | `DecompressionStream('deflate-raw')` | fflate / pako |
| ZIP 容器解析 | 自寫（EOCD → central directory → local header） | JSZip |
| 隨機存取 | `Blob.slice()` | 整檔讀進記憶體 |
| XML 解析 | 自寫 tokenizer + 小節點樹 | DOMParser / @xmldom/xmldom / sax-js |

### 架構：串流切列 ＋ 元素內小節點樹

```
解壓串流 ──► streamElements('row') ──► 一次交出「一個完整的 <row> 字串」
                                              │
                                              ▼
                                    parseXml() ──► 一棵只含這一列的小節點樹
                                              │
                                              ▼
                             parseRow / parseCell 用節點查詢讀它
```

- **XML 文法只在 `nextToken()` 一個地方處理**——註解、CDATA、PI、命名空間前綴、
  屬性值裡的 `>`、`<x/>` 與 `<x>…</x>` 兩種寫法全部集中在那裡；其他地方一律
  只用節點查詢（`attr` / `num` / `child` / `children` / `find` / `findAll`）。
- **為什麼不是純 SAX**：純 SAX 會把「一格的值怎麼決定」拆進 open/text/close
  三個 handler，得靠一堆狀態變數重建上下文，反而更難讀。
- **為什麼不是整份 DOM**：那會把整個 sheet 讀進記憶體、破壞串流。

支援的 OOXML 情況（都有回歸測試覆蓋過，測試資產已在正式版移除，見下方「已知限制」）：

- 共用字串（`t="s"`）、內嵌字串（`inlineStr`）、公式快取值（`t="str"`）、
  布林（`t="b"`）、錯誤值（`t="e"`）、數字
- **稀疏儲存格**：Excel 會省略空白格，一律照 `r="C5"` 算出的欄號定位，欄位不會左移
- **整列省略**：空白列會補回全 `null`，列序才對得上試算表列號
- **rich text runs**：一格內多段格式會把所有 `<t>` 串接；`<rPh>` 假名注音不算內容
- **XML 實體**（`&amp;` `&#20320;` `&#x4f60;`）與 `xml:space="preserve"` 前後空白
- **命名空間前綴**（`<x:row>` / `<x:c>`）——一律以去掉前綴的 local name 比對
- **XML 註解與 CDATA**——註解裡的 `<row>` 不會被當成資料列；CDATA 內容當文字
- **日期**：內建 numFmt 編號加上 `<numFmts>` 自訂格式碼；1900 與 1904 兩種日期系統
- ZIP 的 deflate（method 8）與未壓縮（method 0）
- 工作表以 `rels` 對應實際部件路徑，不假設檔名一定是 `sheet1.xml`

不支援，且會丟出可辨識的錯誤碼（不會默默回傳空資料）：

| 情況 | 錯誤碼 |
| --- | --- |
| ZIP64（>4GB 或 >65535 個 entry） | `ZIP64_NOT_SUPPORTED` |
| 舊版 `.xls`（BIFF 二進位格式） | `XLS_NOT_SUPPORTED` |
| 不是 ZIP／檔案損毀 | `NOT_A_ZIP` / `NO_EOCD` / `BAD_CENTRAL_DIRECTORY` |
| 加密／密碼保護的 xlsx | 會在解壓或解析階段失敗 |
| 指定的工作表不存在 | `SHEET_NOT_FOUND` |

只讀一個工作表（預設第一個，可用 `options.sheet` 指定名稱或序號）。

### 主執行緒 ↔ Worker 的訊息內容

- 主 → Worker：`{ file }`（原始 `File` 物件，Worker 自己解析）
- Worker → 主（進度，可 0 到多次）：`{ type: 'progress', phase, loaded, total, ratio, rowCount }`
- Worker → 主（一批列資料，可多次）：`{ type: 'chunk', startLine, lines, isLast, columnCount?, rowCount? }`
  （`columnCount`／`rowCount` 只在 `isLast` 為 `true` 的最後一批才有值——欄數與總列數
  要掃完全檔才知道）
- Worker → 主（失敗）：`{ type: 'error', ok: false, error }`

`phase` 依序是 `sharedStrings` → `styles` → `dimension` → `sheet` → `done`。
`ratio` 為 `null` 表示分母不可信（ZIP central directory 的 `uncompressedSize`
不可用），UI 應顯示不確定狀態而非百分比。

## 已知限制（誠實告知）

- **全程無登入／驗證**：`ApiController` 固定用一個使用者代號，這是本專案刻意
  精簡的部分，不是遺漏；正式導入需要接上真正的登入機制。
- **連線字串明碼放在 `appsettings.json`**：本地開發用，未接密管機制。
- **`sharedStrings.xml` 是查表，必須整份在記憶體**：Worker 峰值記憶體
  ≈ 共用字串表 + 當下這一列，跟資料列數無關，但跟「不重複字串數」成正比。
- **`styles.xml` 是整份進記憶體解析的**（沒有串流）。一般檔案只有幾 KB，
  但條件格式很多的企業檔會明顯變大——這是全流程唯一一段「進度停著但真的
  在忙」的地方，進度條會用階段標籤標示它。
- **上傳佇列沒有 backpressure**：Worker 解析速度與上傳速度脫鉤，佇列會依序
  處理，但沒有限制佇列長度；極大檔案在很慢的網路/資料庫下，佇列可能明顯
  落後於解析進度。
- **`PAGE_SIZE` 固定在前端常數**，沒有做成使用者可調整的介面。

### 資料存取層的已知限制

以下幾點是照著 `DBService.cs` 的既有取捨抄過來的，**刻意不改**——
目的是學既有的固定寫法，不是改良它：

- **沒有跨呼叫的交易**。單次 `EX01_SAVE` 內部是原子的（交易寫在 SP 內），
  但一個大檔要送十幾塊，**跨塊沒辦法包成一個交易**。傳到一半中斷會留下
  未回填 `TotalRows` 的資料集——`TotalRows` 是否已回填就是「這份有沒有傳完」的標記。
- **`CommandTimeout` 固定 30 秒**，沒有給批次寫入的逃生口。
- **錯誤訊息不過濾**：SQL 的原始錯誤（含資料表名稱、條件約束名稱）會一路傳到瀏覽器。
- **SP 設的 `@code` 在出錯時傳不回來**。以主鍵衝突為例：SQL 端完全正確
  （`ROLLBACK` 會執行、`@code` 會設成 99），但嚴重性 ≥ 11 的錯誤同時也送到用戶端，
  `SqlDataAdapter.Fill` 因此丟例外，`catch` 搶先回 `Code="-1"` 加原始訊息。
  **資料完整性不受影響**，受影響的只有錯誤碼的品質。
- **全同步，沒有 async**：`SqlDataAdapter` 本身就沒有 `FillAsync`，這是設計前提。
- **回應的 `Content-Type` 沒有 `charset`**。瀏覽器不受影響（fetch 規範規定 JSON
  一律以 UTF-8 解碼），但非瀏覽器的用戶端（PowerShell 等）會退回 ISO-8859-1、中文變亂碼。
- **操作記錄目前是 no-op**（`Utility/BaseUtility.cs` 的 `SY006`）。
  既有專案的做法是在閘道 SP 裡統一記錄，但 `DBService.cs` 沒有閘道，這一項待確認。
- **`ObjParams` 是無型別的字串字典**：鍵名打錯不會有編譯錯誤，
  SP 端只會拿到 NULL——這是「一個 action 服務 N 支 SP」換來的代價。

### 預存程序

三支 SP 的建立腳本在 `SqlObject/Procedure/`，**版控用，執行期不讀檔**
（做法比照公司既有專案，把 SQL 物件腳本放在獨立目錄）。改了 SP 之後要自己在 SSMS 或
`sqlcmd` 重跑腳本，不會隨著 `dotnet build` 自動套用。

`OPENJSON` 需要資料庫相容性層級 **≥ 130**：

```sql
SELECT compatibility_level FROM sys.databases WHERE name = 'Ex01Db';
```

## 授權

尚未指定授權條款。
