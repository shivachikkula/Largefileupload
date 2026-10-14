using System.Text.RegularExpressions;
using Azure;
using Azure.Storage.Blobs.Models;
using Azure.Storage.Blobs.Specialized;
using LargeFileUpload.Api.Storage;
using Microsoft.Extensions.Options;

namespace LargeFileUpload.Api.Uploads;

public static partial class UploadEndpoints
{
    private const long MiB = 1024 * 1024;

    public static void MapUploadEndpoints(this IEndpointRouteBuilder app)
    {
        var group = app.MapGroup("/api/uploads");
        group.MapPost("/", StartAsync);
        group.MapGet("/{id}", GetAsync);
        group.MapPost("/{id}/complete", CompleteAsync);
        group.MapDelete("/{id}", CancelAsync);
    }

    /// <summary>
    /// POST /api/uploads
    /// Starts an upload, or returns the existing session when the same user picks the
    /// same file again (same fingerprint). That's how a refresh or crash resumes.
    /// </summary>
    private static async Task<IResult> StartAsync(
        StartUploadRequest req, HttpContext http, SessionStore sessions, BlobStorage storage,
        IOptions<UploadOptions> options, CancellationToken ct)
    {
        var opts = options.Value;
        if (string.IsNullOrWhiteSpace(req.FileName)) throw new ApiException(400, "fileName is required");
        if (req.FileSize is not > 0) throw new ApiException(400, "fileSize must be a positive integer");
        if (req.FileSize > opts.MaxFileSize) throw new ApiException(413, $"File exceeds {opts.MaxFileSize} bytes");
        if (req.Fingerprint is not { Length: >= 16 and <= 256 }) throw new ApiException(400, "fingerprint is required");

        var userId = http.GetUserId();
        var fileSize = req.FileSize.Value;

        var existing = await sessions.FindResumableAsync(userId, req.Fingerprint, ct);
        if (existing is not null && existing.Session.FileSize == fileSize)
        {
            return Results.Ok(await ToResponseAsync(existing.Session, storage, ct) with { Resumed = true });
        }

        var id = Guid.NewGuid().ToString();
        var blockSize = ChooseBlockSize(fileSize, opts);
        var now = DateTimeOffset.UtcNow;
        var session = new UploadSession
        {
            Id = id,
            UserId = userId,
            Fingerprint = req.Fingerprint,
            FileName = req.FileName,
            FileSize = fileSize,
            ContentType = string.IsNullOrWhiteSpace(req.ContentType) ? "application/octet-stream" : req.ContentType,
            BlockSize = blockSize,
            TotalBlocks = (int)((fileSize + blockSize - 1) / blockSize),
            BlobName = $"{Uri.EscapeDataString(userId)}/{id}/{SafeFileName(req.FileName)}",
            Status = UploadStatus.Uploading,
            CreatedAt = now,
            ExpiresAt = now.AddDays(opts.SessionTtlDays),
        };
        await sessions.CreateAsync(session, ct);
        return Results.Json(await ToResponseAsync(session, storage, ct) with { Resumed = false }, statusCode: 201);
    }

    /// <summary>
    /// GET /api/uploads/{id}
    /// The resume call: which blocks does the server already have? Also hands out a
    /// fresh SAS, since the old one may have expired while the user was offline.
    /// </summary>
    private static async Task<IResult> GetAsync(
        string id, HttpContext http, SessionStore sessions, BlobStorage storage, CancellationToken ct)
    {
        var (session, _) = await LoadOwnedSessionAsync(id, http, sessions, ct);
        return Results.Ok(await ToResponseAsync(session, storage, ct));
    }

    /// <summary>
    /// POST /api/uploads/{id}/complete
    /// Checks every block is present with the right size, then commits the block list,
    /// which assembles the final blob in order.
    /// </summary>
    private static async Task<IResult> CompleteAsync(
        string id, HttpContext http, SessionStore sessions, BlobStorage storage, CancellationToken ct)
    {
        var (session, etag) = await LoadOwnedSessionAsync(id, http, sessions, ct);
        if (session.Status == UploadStatus.Completed)
            return Results.Ok(await ToResponseAsync(session, storage, ct)); // idempotent: a retried "complete" is fine
        if (session.Status != UploadStatus.Uploading)
            throw new ApiException(409, $"Upload is {session.Status}");

        var uploaded = (await GetUploadedBlocksAsync(session, storage, ct)).ToHashSet();
        var missing = Enumerable.Range(0, session.TotalBlocks).Where(i => !uploaded.Contains(i)).ToList();
        if (missing.Count > 0)
        {
            throw new ApiException(409, "Upload is missing blocks",
                new { missingBlocks = missing.Take(1000), missingCount = missing.Count });
        }

        // Claim the session so two concurrent "complete" calls can't both commit.
        (session, etag) = await sessions.UpdateAsync(session with { Status = UploadStatus.Committing }, etag, ct);

        try
        {
            var blob = storage.Uploads.GetBlockBlobClient(session.BlobName);
            var blockIds = Enumerable.Range(0, session.TotalBlocks).Select(BlobStorage.BlockIdFor);
            await blob.CommitBlockListAsync(blockIds, new CommitBlockListOptions
            {
                HttpHeaders = new BlobHttpHeaders { ContentType = session.ContentType },
                Metadata = new Dictionary<string, string>
                {
                    ["uploadid"] = session.Id,
                    ["originalname"] = Uri.EscapeDataString(session.FileName),
                },
            }, ct);

            var props = await blob.GetPropertiesAsync(cancellationToken: ct);
            if (props.Value.ContentLength != session.FileSize)
                throw new InvalidOperationException($"Committed size {props.Value.ContentLength} != expected {session.FileSize}");
        }
        catch
        {
            await sessions.UpdateAsync(session with { Status = UploadStatus.Uploading }, etag, ct);
            throw;
        }

        (session, _) = await sessions.UpdateAsync(
            session with { Status = UploadStatus.Completed, CompletedAt = DateTimeOffset.UtcNow }, etag, ct);
        await sessions.ForgetFingerprintAsync(session.UserId, session.Fingerprint, ct);
        return Results.Ok(await ToResponseAsync(session, storage, ct));
    }

    /// <summary>
    /// DELETE /api/uploads/{id}
    /// Cancels the upload. Committing an empty block list makes Azure discard every
    /// uncommitted block right away; then the empty blob is deleted.
    /// </summary>
    private static async Task<IResult> CancelAsync(
        string id, HttpContext http, SessionStore sessions, BlobStorage storage, CancellationToken ct)
    {
        var (session, etag) = await LoadOwnedSessionAsync(id, http, sessions, ct);
        if (session.Status == UploadStatus.Completed) throw new ApiException(409, "Upload already completed");
        if (session.Status == UploadStatus.Aborted) return Results.NoContent();

        await sessions.UpdateAsync(session with { Status = UploadStatus.Aborted }, etag, ct);
        var blob = storage.Uploads.GetBlockBlobClient(session.BlobName);
        await blob.CommitBlockListAsync([], cancellationToken: ct);
        await blob.DeleteIfExistsAsync(cancellationToken: ct);
        await sessions.ForgetFingerprintAsync(session.UserId, session.Fingerprint, ct);
        return Results.NoContent();
    }

    /// <summary>
    /// Azure is the source of truth for what has arrived: every successful Put Block
    /// shows up as an uncommitted block. A block is staged atomically, so a request
    /// cut off mid-way leaves nothing behind and the block is simply missing.
    /// </summary>
    private static async Task<IReadOnlyList<int>> GetUploadedBlocksAsync(
        UploadSession session, BlobStorage storage, CancellationToken ct)
    {
        if (session.Status == UploadStatus.Completed) return Enumerable.Range(0, session.TotalBlocks).ToList();
        try
        {
            var list = await storage.Uploads.GetBlockBlobClient(session.BlobName)
                .GetBlockListAsync(BlockListTypes.Uncommitted, cancellationToken: ct);
            return list.Value.UncommittedBlocks
                .Select(b => (Index: BlobStorage.BlockIndexFor(b.Name), b.SizeLong))
                .Where(b => b.Index is { } i && i < session.TotalBlocks && b.SizeLong == session.ExpectedBlockSize(i))
                .Select(b => b.Index!.Value)
                .Distinct()
                .Order()
                .ToList();
        }
        catch (RequestFailedException ex) when (BlobStorage.IsNotFound(ex))
        {
            return []; // no block has been staged yet, so the blob doesn't exist
        }
    }

    private static async Task<UploadSessionResponse> ToResponseAsync(
        UploadSession session, BlobStorage storage, CancellationToken ct)
    {
        var uploadedBlocks = await GetUploadedBlocksAsync(session, storage, ct);
        (Uri Url, DateTimeOffset ExpiresOn)? sas = session.Status == UploadStatus.Uploading
            ? await storage.CreateUploadSasAsync(session.BlobName, ct)
            : null;

        return new UploadSessionResponse
        {
            UploadId = session.Id,
            FileName = session.FileName,
            FileSize = session.FileSize,
            BlockSize = session.BlockSize,
            TotalBlocks = session.TotalBlocks,
            Status = session.Status,
            ExpiresAt = session.ExpiresAt,
            UploadedBlocks = uploadedBlocks,
            UploadedBytes = uploadedBlocks.Sum(session.ExpectedBlockSize),
            SasUrl = sas?.Url.ToString(),
            SasExpiresOn = sas?.ExpiresOn,
        };
    }

    private static async Task<StoredSession> LoadOwnedSessionAsync(
        string id, HttpContext http, SessionStore sessions, CancellationToken ct)
    {
        var stored = Guid.TryParse(id, out _) ? await sessions.GetAsync(id, ct) : null;
        // 404 (not 403) for other users' sessions so IDs can't be probed.
        if (stored is null || stored.Session.UserId != http.GetUserId()) throw new ApiException(404, "Upload not found");
        return stored;
    }

    /// <summary>Large enough to stay under Azure's 50,000-block limit, rounded to whole MiB.</summary>
    private static long ChooseBlockSize(long fileSize, UploadOptions opts)
    {
        var needed = (fileSize + opts.MaxBlocks - 1) / opts.MaxBlocks;
        return Math.Max(opts.MinBlockSize, (needed + MiB - 1) / MiB * MiB);
    }

    private static string SafeFileName(string name)
    {
        var safe = UnsafeFileNameChars().Replace(name, "_");
        return safe.Length == 0 ? "file" : safe[..Math.Min(safe.Length, 200)];
    }

    [GeneratedRegex(@"[^A-Za-z0-9_.\- ]")]
    private static partial Regex UnsafeFileNameChars();
}
