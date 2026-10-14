namespace LargeFileUpload.Api.Uploads;

public static class UploadStatus
{
    public const string Uploading = "uploading";
    public const string Committing = "committing";
    public const string Completed = "completed";
    public const string Aborted = "aborted";
}

/// <summary>Persisted as JSON in the session container (same shape as the Node API).</summary>
public sealed record UploadSession
{
    public required string Id { get; init; }
    public required string UserId { get; init; }
    public required string Fingerprint { get; init; }
    public required string FileName { get; init; }
    public required long FileSize { get; init; }
    public required string ContentType { get; init; }
    public required long BlockSize { get; init; }
    public required int TotalBlocks { get; init; }
    public required string BlobName { get; init; }
    public required string Status { get; init; }
    public required DateTimeOffset CreatedAt { get; init; }
    public required DateTimeOffset ExpiresAt { get; init; }
    public DateTimeOffset? CompletedAt { get; init; }

    public long ExpectedBlockSize(int index) =>
        index == TotalBlocks - 1 ? FileSize - index * BlockSize : BlockSize;
}

public sealed record StartUploadRequest(string? FileName, long? FileSize, string? ContentType, string? Fingerprint);

/// <summary>What the Angular client receives; identical to the Node API's response.</summary>
public sealed record UploadSessionResponse
{
    public required string UploadId { get; init; }
    public required string FileName { get; init; }
    public required long FileSize { get; init; }
    public required long BlockSize { get; init; }
    public required int TotalBlocks { get; init; }
    public required string Status { get; init; }
    public required DateTimeOffset ExpiresAt { get; init; }
    /// <summary>Block indexes Azure already holds: the answer to "where was I?"</summary>
    public required IReadOnlyList<int> UploadedBlocks { get; init; }
    public required long UploadedBytes { get; init; }
    public string? SasUrl { get; init; }
    public DateTimeOffset? SasExpiresOn { get; init; }
    public bool? Resumed { get; init; }
}

/// <summary>Turned into a JSON error response { error, details } by the error middleware.</summary>
public sealed class ApiException(int statusCode, string message, object? details = null) : Exception(message)
{
    public int StatusCode { get; } = statusCode;
    public object? Details { get; } = details;
}
