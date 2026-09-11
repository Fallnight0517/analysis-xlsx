var builder = WebApplication.CreateBuilder(args);

// Add services to the container.
// AddNewtonsoftJson()：ApiController 是用 JsonConvert 手動序列化 ApiResult 回傳的
// （照既有專案的寫法，見 ApiController），保留 Newtonsoft 的 MVC 整合讓輸入綁定也走同一套。
// 註：公司既有專案其實沒有呼叫 AddNewtonsoftJson——它只有引用套件卻沒有掛上去，
//     結果同一個專案裡混著 PascalCase 和 camelCase 兩種回應。這裡刻意不重現那個問題。
builder.Services.AddControllersWithViews().AddNewtonsoftJson();

// 公司既有慣例的資料存取層。連線字串走「兩段間接」：DBProvider 決定連線型別、
// ConnectionName 決定去 ConnectionStrings 拿哪一條（見 appsettings.json）。
// 生命週期選 Scoped：DBService 讀完 IConfiguration 之後無狀態，Singleton 也可以，
// 但 Scoped 是 ASP.NET Core 資料存取的預設選擇，風險最低。
// （既有專案是每次自己 new 一個資料存取物件、完全不走 DI；但 DBService.cs 的建構子
//   吃 IConfiguration、介面叫 IDBService，這個檔案本身就是為 DI 設計的。）
builder.Services.AddScoped<xlsx_poc.DB.IDBService, xlsx_poc.DB.DBService>();

var app = builder.Build();

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
