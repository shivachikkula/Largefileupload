using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Azure;
using Azure.Storage.Blobs.Models;
using LargeFileUpload.Api.Uploads;

namespace LargeFileUpload.Api.Storage;

public sealed record StoredSession(UploadSession Session, ETag ETag);

/// <summary>Thrown when another request changed the session first (optimistic concurrency).</summary>
public sealed class ConcurrencyException(string message) : Exception(message);

/// <summary>
/// Upload session metadata kept as small JSON blobs next to the data, so the API
/// stays stateless and needs no database. Swap for Cosmos DB / SQL if you prefer;
/// the endpoints only depend on this class.
/// </summary>
public sealed class SessionStore(BlobStorage storage)
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    private static string SessionPath(string id) => $"sessions/{id}.json";

    private static string IndexPath(string userId, string fingerprint) =>
        $"by-fingerprint/{Sha256(userId)}/{Sha256(fingerprint)}.json";

    private static string Sha256(string value) =>
        Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(value)));

    private sealed record FingerprintIndex(string UploadId);

    public async Task<StoredSession?> GetAsync(string id, CancellationToken ct = default)
    {
        var found = await ReadJsonAsync<UploadSession>(SessionPath(id), ct);
        return found is { } f ? new StoredSession(f.Value, f.ETag) : null;
    }

    public async Task<StoredSession> CreateAsync(UploadSession session, CancellationToken ct = default)
    {
        var etag = await WriteJsonAsync(SessionPath(session.Id), session, new() { IfNoneMatch = ETag.All }, ct);
        await WriteJsonAsync(IndexPath(session.UserId, session.Fingerprint), new FingerprintIndex(session.Id), null, ct);
        return new StoredSession(session, etag);
    }

    /// <summary>Conditional write: fails with ConcurrencyException if the session changed since it was read.</summary>
    public async Task<StoredSession> UpdateAsync(UploadSession session, ETag etag, CancellationToken ct = default)
    {
        var newEtag = await WriteJsonAsync(SessionPath(session.Id), session, new() { IfMatch = etag }, ct);
        return new StoredSession(session, newEtag);
    }

    /// <summary>Lets a user who re-selects the same file after a crash/refresh continue the old session.</summary>
    public async Task<StoredSession?> FindResumableAsync(string userId, string fingerprint, CancellationToken ct = default)
    {
        var index = await ReadJsonAsync<FingerprintIndex>(IndexPath(userId, fingerprint), ct);
        if (index is null) return null;

        var stored = await GetAsync(index.Value.Value.UploadId, ct);
        if (stored is null || stored.Session.Status != UploadStatus.Uploading) return null;
        return stored.Session.ExpiresAt > DateTimeOffset.UtcNow ? stored : null;
    }

    public Task ForgetFingerprintAsync(string userId, string fingerprint, CancellationToken ct = default) =>
        storage.Sessions.GetBlobClient(IndexPath(userId, fingerprint)).DeleteIfExistsAsync(cancellationToken: ct);

    private async Task<(T Value, ETag ETag)?> ReadJsonAsync<T>(string path, CancellationToken ct)
    {
        try
        {
            var result = await storage.Sessions.GetBlobClient(path).DownloadContentAsync(ct);
            return (result.Value.Content.ToObjectFromJson<T>(Json)!, result.Value.Details.ETag);
        }
        catch (RequestFailedException ex) when (BlobStorage.IsNotFound(ex))
        {
            return null;
        }
    }

    private async Task<ETag> WriteJsonAsync<T>(string path, T value, BlobRequestConditions? conditions, CancellationToken ct)
    {
        try
        {
            var result = await storage.Sessions.GetBlobClient(path).UploadAsync(
                BinaryData.FromObjectAsJson(value, Json),
                new BlobUploadOptions
                {
                    HttpHeaders = new BlobHttpHeaders { ContentType = "application/json" },
                    Conditions = conditions,
                },
                ct);
            return result.Value.ETag;
        }
        catch (RequestFailedException ex) when (ex.Status is 409 or 412)
        {
            throw new ConcurrencyException($"Session blob {path} changed concurrently");
        }
    }
}
