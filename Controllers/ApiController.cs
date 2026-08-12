using Microsoft.AspNetCore.Mvc;
using Newtonsoft.Json.Linq;
using xlsx_poc.Class;
using xlsx_poc.Utility;

namespace xlsx_poc.Controllers;

// 唯一 dispatch 入口：所有 EX01_* 功能都從這裡依 FUNCTION_ID 分派給 Class/EX01.cs。
// 本地無 SSO：固定用一個使用者代號；之後若要接登入，只需替換這裡的 Udata 來源。
public class ApiController : Controller
{
    [HttpPost]
    [Route("api/ApiWork")]
    public IActionResult ApiWork([FromBody] JObject json)
    {
        var Udata = new Dictionary<string, string> { ["USER_ID"] = "local" };
        var ResultJsonObjet = new Dictionary<string, object>();

        if (json?["FUNCTION_ID"] == null)
        {
            return Json(new { success = false, message = "參數錯誤" });
        }

        try
        {
            switch (json["FUNCTION_ID"]!.ToString())
            {
                case "EX01_SAVE": EX01.EX01_SAVE(Udata, json, ref ResultJsonObjet); break;
                case "EX01_LIST": EX01.EX01_LIST(Udata, json, ref ResultJsonObjet); break;
                case "EX01_PAGE": EX01.EX01_PAGE(Udata, json, ref ResultJsonObjet); break;
                default: return Json(new { success = false, message = "參數錯誤" });
            }
        }
        catch (Exception ex)
        {
            BaseUtility.WriteLog(ex);
            return Json(new { success = false, message = "系統錯誤：" + ex.Message });
        }

        return Json(ResultJsonObjet);
    }
}
