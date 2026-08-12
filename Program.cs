var builder = WebApplication.CreateBuilder(args);

// Add services to the container.
// AddNewtonsoftJson()：EX01.cs 沿用 PA0010.cs 的 JObject/JsonConvert 寫法，需要 Newtonsoft 的 MVC 整合。
builder.Services.AddControllersWithViews().AddNewtonsoftJson();

var app = builder.Build();

// 本地無 SSO/無密管：連線字串明碼放在 appsettings.json，開發階段夠用（見 §2 SSMS 設定）。
xlsx_poc.Utility.MSDA.Init(builder.Configuration.GetConnectionString("Ex01Db") ?? string.Empty);

// Configure the HTTP request pipeline.
if (!app.Environment.IsDevelopment())
{
    app.UseExceptionHandler("/Home/Error");
    // The default HSTS value is 30 days. You may want to change this for production scenarios, see https://aka.ms/aspnetcore-hsts.
    app.UseHsts();
}

app.UseHttpsRedirection();

// --- xlsx POC: wwwroot 下的 css/js 靜態檔（含 Ex01 頁面的前端資源）由此送出 ---
var staticFileOptions = new StaticFileOptions();
if (app.Environment.IsDevelopment())
{
    // 開發時關掉瀏覽器快取。預設回應只有 ETag / Last-Modified、沒有 Cache-Control，
    // 瀏覽器會套用「啟發式快取」直接沿用舊檔 —— 改了 JS 重新整理卻還是舊版，很難察覺。
    staticFileOptions.OnPrepareResponse = ctx =>
        ctx.Context.Response.Headers.CacheControl = "no-store, no-cache, must-revalidate";
}

// UseDefaultFiles 讓目錄路徑改寫成該目錄下的 index.html。
// "/" 本身現在由下面的預設路由導向 Ex01Controller，不受影響 —— 網站根目錄底下
// 已經沒有 wwwroot/index.html 可以改寫了。
app.UseDefaultFiles();
app.UseStaticFiles(staticFileOptions);

app.UseRouting();

app.UseAuthorization();

app.MapStaticAssets();

// "/" 直接開 Excel 檔案檢視（Ex01），不是 ASP.NET Core 樣板預設的 Home。
app.MapControllerRoute(
    name: "default",
    pattern: "{controller=Ex01}/{action=Index}/{id?}")
    .WithStaticAssets();


app.Run();
