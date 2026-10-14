using LargeFileUpload.Api.Storage;
using LargeFileUpload.Api.Uploads;

namespace LargeFileUpload.Api;

/// <summary>Maps exceptions to the same { error, details } JSON the Node API returns.</summary>
public sealed class ErrorHandlingMiddleware(RequestDelegate next, ILogger<ErrorHandlingMiddleware> logger)
{
    public async Task InvokeAsync(HttpContext http)
    {
        try
        {
            await next(http);
        }
        catch (ApiException ex)
        {
            await WriteAsync(http, ex.StatusCode, ex.Message, ex.Details);
        }
        catch (ConcurrencyException)
        {
            await WriteAsync(http, 409, "Upload was modified by another request; retry");
        }
        catch (BadHttpRequestException ex)
        {
            await WriteAsync(http, ex.StatusCode, "Invalid request body");
        }
        catch (OperationCanceledException) when (http.RequestAborted.IsCancellationRequested)
        {
            // client went away (e.g. its network dropped); nothing to send
        }
        catch (Exception ex)
        {
            logger.LogError(ex, "Unhandled error");
            await WriteAsync(http, 500, "Internal server error");
        }
    }

    private static Task WriteAsync(HttpContext http, int status, string error, object? details = null)
    {
        if (http.Response.HasStarted) return Task.CompletedTask;
        http.Response.StatusCode = status;
        object body = details is null ? new { error } : new { error, details };
        return http.Response.WriteAsJsonAsync(body);
    }
}
