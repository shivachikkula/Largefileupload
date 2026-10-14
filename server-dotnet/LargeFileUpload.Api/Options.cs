namespace LargeFileUpload.Api;

public sealed class StorageOptions
{
    public string? ConnectionString { get; set; }
    public string? AccountUrl { get; set; }
    public string UploadContainer { get; set; } = "uploads";
    public string SessionContainer { get; set; } = "upload-sessions";
    public bool ConfigureCors { get; set; }
}

public sealed class UploadOptions
{
    public long MaxFileSize { get; set; } = 50L * 1024 * 1024 * 1024;
    public long MinBlockSize { get; set; } = 8 * 1024 * 1024;

    /// <summary>Azure allows at most 50,000 committed blocks per block blob.</summary>
    public int MaxBlocks { get; set; } = 50_000;

    /// <summary>Short on purpose; the client asks for a fresh SAS when it expires.</summary>
    public int SasTtlMinutes { get; set; } = 30;

    /// <summary>Azure discards uncommitted blocks after 7 days, so sessions can't outlive that.</summary>
    public int SessionTtlDays { get; set; } = 7;
}
