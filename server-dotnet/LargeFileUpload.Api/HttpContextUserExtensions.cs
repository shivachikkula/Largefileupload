namespace LargeFileUpload.Api;

public static class HttpContextUserExtensions
{
    public const string UserIdKey = "UserId";

    public static string GetUserId(this HttpContext http) =>
        http.Items[UserIdKey] as string ?? throw new InvalidOperationException("User not resolved");
}
