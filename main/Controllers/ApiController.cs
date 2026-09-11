using Microsoft.AspNetCore.Mvc;
using Newtonsoft.Json;
using xlsx_poc.DB;

namespace xlsx_poc.Controllers;

// 本地無 SSO：固定用一個使用者代號；之後若要接登入，只需替換這裡的 USER_ID 來源。
//
// 這個檔案「不認識任何一支 FunctionID」——收到什麼就原封不動轉交給 DBService，
// 由它去叫同名的預存程序。新增功能只要加一支 SP，這裡一行都不用改。
public class ApiController : Controller
{
    private const string USER_ID = "local";

    private readonly IDBService _db;

    public ApiController(IDBService db)
    {
        _db = db;
    }

    // 通用 dispatch：這裡不認識任何 FunctionID，原封不動轉交給 DBService，
    // 由它去叫同名的預存程序。新增功能只要加一支 SP，這個檔案一行都不用改。
    // （公司既有專案的 action 沒有加 [FromBody]、前端送 form-urlencoded；
    //   這裡加 [FromBody] 保留 JSON，因為 EX01_SAVE 一次要送 500 列的 JSON 字串，
    //   走 form-urlencoded 會被 URL 編碼撐大，而 FormOptions.ValueLengthLimit 預設只有 4MB。）
    [HttpPost]
    [Route("api/GetData")]
    public IActionResult GetData([FromBody] ObjRequest objRq)
    {
        objRq.ObjParams["USER_ID"] = USER_ID;

        ApiResult result = _db.ExecuteProcedure(objRq);

        // ReferenceLoopHandling.Ignore 不是可選項：DataSet／DataTable／DataRelation
        // 互相參照，不加會無窮遞迴。Formatting.Indented 是照抄既有專案的寫法（會多送一些空白）。
        return Content(JsonConvert.SerializeObject(result, Formatting.Indented,
            new JsonSerializerSettings
            {
                ReferenceLoopHandling = ReferenceLoopHandling.Ignore
            }), "application/json");
    }

    // 寫入用的入口。實作跟 GetData 完全一樣——既有專案也是兩支近乎重複的 action
    // ，差別只在語意上分開讀與寫。
    [HttpPost]
    [Route("api/UpdateData")]
    public IActionResult UpdateData([FromBody] ObjRequest objRq)
    {
        objRq.ObjParams["USER_ID"] = USER_ID;

        ApiResult result = _db.ExecuteProcedure(objRq);

        return Content(JsonConvert.SerializeObject(result, Formatting.Indented,
            new JsonSerializerSettings
            {
                ReferenceLoopHandling = ReferenceLoopHandling.Ignore
            }), "application/json");
    }
}
