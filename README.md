# analysis-xlsx

在瀏覽器內解析 `.xlsx`、分批上傳存進 MSSQL、再用分頁方式檢視內容。
ASP.NET Core（net10.0）同時擔任網站主機與一套**自建的最小 dispatch 後端**。

- **.xlsx 解析完全在瀏覽器內完成**：自行實作、零第三方相依的 ZIP + XML 解析器
  （見下方「[xlsx 解析器：自寫、零第三方相依](#xlsx-解析器自寫零第三方相依)」），
  在 Web Worker 裡邊解壓邊掃，不需要把整份檔案讀進記憶體。
- **資料持久化在 MSSQL**：解析出來的每一列分批（chunk）上傳、寫進資料庫；
  重新整理頁面、換一台瀏覽器都還能繼續看到之前上傳過的資料。
- **後端是刻意精簡的自建 dispatch**，不是完整的部門框架：單一入口
  `/api/ApiWork` 依 `FUNCTION_ID` 分派給對應邏輯，形狀比照常見的企業內部
  dispatch 慣例（單一 controller、`Class/`＋`Utility/` 分層），但拿掉了本專案
  用不到的東西（SSO 登入、連線字串加密、集中式操作記錄）。

## 架構總覽

```
瀏覽器
├─ Views/Ex01/Index.cshtml(.js)      頁面骨架與 UI 邏輯（選檔、上傳進度、分頁顯示）
├─ wwwroot/js/Ex01/parser-worker.js  Web Worker：只做解析，把列資料分塊丟回主執行緒
├─ wwwroot/js/Ex01/xlsx-reader.js    自寫的 .xlsx 解析器（零第三方相依，見下方章節）
└─ wwwroot/js/Ex01/dispatch-client.js  前端 dispatch client（Capi / CapiAsync / Message）
        │  fetch POST /api/ApiWork { FUNCTION_ID, Data }
        ▼
Controllers/ApiController.cs        唯一入口，依 FUNCTION_ID 分派
        │
        ▼
Class/EX01.cs                       EX01_SAVE ／ EX01_LIST ／ EX01_PAGE
        │
        ▼
Utility/MSDA.cs、MSSqlWork.cs、BaseUtility.cs   精簡版資料存取／SQL 組裝／記錄
        │
        ▼
MSSQL：Ex01Dataset、Ex01Row 兩張表
```

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

4. 執行：

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

單一入口 `POST /api/ApiWork`，body 為 `{ "FUNCTION_ID": "...", "Data": {...} }`，
回應一律是 `{ "success": bool, "message": string, "data"?: string }`
（`data` 是序列化過的 JSON 字串，需要再 `JSON.parse` 一次）。

| FUNCTION_ID | Data | 說明 |
| --- | --- | --- |
| `EX01_SAVE` | `{ DatasetId, FileName, HasHeader, ColumnCount, StartLine, Lines[], IsFirst, IsLast }` | 分塊上傳。`IsFirst` 時建立 `Ex01Dataset`；`IsLast` 時回填 `TotalRows`／`ColumnCount`（欄數要掃完全檔才知道）。 |
| `EX01_LIST` | 無 | 列出目前使用者上傳過的資料集（本地無登入，固定用一個使用者代號）。 |
| `EX01_PAGE` | `{ DatasetId, Page, PageSize, WantHeader }` | 回傳 `{ columnCount, header, rows, totalRows, totalPages, page }`；`WantHeader` 只需要在換資料集時傳 `true`。 |

## 前端組成

- **`xlsx-reader.js` + `parser-worker.js`**：解析永遠在 Worker 內完成，只做解析、
  不打任何 API。解析出來的列先累積成一批（約 500 列），滿了就 `postMessage`
  回主執行緒，由主執行緒呼叫 `EX01_SAVE` 上傳——這樣設計是為了保留原本
  「邊解壓邊掃、記憶體不隨檔案大小成長」的串流特性，即使檔案很大，Worker
  也不需要等整份解析完才開始上傳。
- **`dispatch-client.js`**：`Capi(para, cb)` 是 fetch 版的最小 dispatch client；
  `CapiAsync(urlPage, functionId, data)` 是它的 Promise 封裝，呼叫端不用自己
  重複寫 `new Promise(...)`。`Message(msg)` 目前只是 `alert()`，之後要換成
  自訂彈窗只需要改這一個函式。
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

## 授權

尚未指定授權條款。
