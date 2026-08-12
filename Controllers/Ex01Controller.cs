using Microsoft.AspNetCore.Mvc;

namespace xlsx_poc.Controllers;

public class Ex01Controller : Controller
{
    public IActionResult Index()
    {
        return View();
    }
}
