using System.Text.Json.Serialization;
using LargeFileUpload.Api;
using LargeFileUpload.Api.Storage;
using LargeFileUpload.Api.Uploads;

var builder = WebApplication.CreateBuilder(args);

builder.Services.Configure<StorageOptions>(builder.Configuration.GetSection("Storage"));
builder.Services.Configure<UploadOptions>(builder.Configuration.GetSection("Upload"));
builder.Services.AddSingleton<BlobStorage>();
builder.Services.AddSingleton<SessionStore>();

builder.Services.ConfigureHttpJsonOptions(o =>
    o.SerializerOptions.DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull);
builder.Services.AddCors(o => o.AddDefaultPolicy(p => p
    .WithOrigins(builder.Configuration["ClientOrigin"] ?? "http://localhost:4200")
    .AllowAnyHeader()
    .AllowAnyMethod()));

var app = builder.Build();

app.UseMiddleware<ErrorHandlingMiddleware>();
app.UseCors();

// DEMO ONLY: takes the user from a header. Replace with real authentication
// (e.g. AddMicrosoftIdentityWebApi + [Authorize], and use the token's `oid` claim).
app.Use((http, next) =>
{
    var header = http.Request.Headers["x-user-id"].ToString();
    http.Items[HttpContextUserExtensions.UserIdKey] =
        string.IsNullOrWhiteSpace(header) ? "demo-user" : header[..Math.Min(header.Length, 64)];
    return next(http);
});

app.MapGet("/healthz", () => "ok");
app.MapUploadEndpoints();

try
{
    await app.Services.GetRequiredService<BlobStorage>().InitializeAsync();
}
catch (Exception ex)
{
    app.Logger.LogCritical(
        "Could not reach Azure Storage. Is Azurite running (`npm run azurite` in server/ or the Azurite " +
        "VS Code extension), and is Storage:ConnectionString / Storage:AccountUrl set? {Error}", ex.Message);
    return 1;
}

app.Run();
return 0;
