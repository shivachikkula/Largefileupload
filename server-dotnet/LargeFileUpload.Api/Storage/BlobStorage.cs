using System.Text;
using System.Text.RegularExpressions;
using Azure;
using Azure.Identity;
using Azure.Storage.Blobs;
using Azure.Storage.Blobs.Models;
using Azure.Storage.Sas;
using Microsoft.Extensions.Options;

namespace LargeFileUpload.Api.Storage;

/// <summary>Blob clients, block IDs and SAS generation.</summary>
public sealed partial class BlobStorage
{
    private readonly StorageOptions _storage;
    private readonly UploadOptions _upload;
    private readonly string _clientOrigin;
    private readonly SemaphoreSlim _delegationKeyLock = new(1, 1);
    private (UserDelegationKey Key, DateTimeOffset ExpiresOn)? _delegationKey;

    public BlobServiceClient Service { get; }
    public BlobContainerClient Uploads { get; }
    public BlobContainerClient Sessions { get; }

    public BlobStorage(IOptions<StorageOptions> storage, IOptions<UploadOptions> upload, IConfiguration config)
    {
        _storage = storage.Value;
        _upload = upload.Value;
        _clientOrigin = config["ClientOrigin"] ?? "http://localhost:4200";

        if (!string.IsNullOrWhiteSpace(_storage.ConnectionString))
            Service = new BlobServiceClient(_storage.ConnectionString);
        else if (!string.IsNullOrWhiteSpace(_storage.AccountUrl))
            Service = new BlobServiceClient(new Uri(_storage.AccountUrl), new DefaultAzureCredential());
        else
            throw new InvalidOperationException(
                "Set Storage:ConnectionString or Storage:AccountUrl (appsettings.json or env vars " +
                "Storage__ConnectionString / Storage__AccountUrl). For local development run with " +
                "ASPNETCORE_ENVIRONMENT=Development to use Azurite.");

        Uploads = Service.GetBlobContainerClient(_storage.UploadContainer);
        Sessions = Service.GetBlobContainerClient(_storage.SessionContainer);
    }

    public async Task InitializeAsync(CancellationToken ct = default)
    {
        await Uploads.CreateIfNotExistsAsync(cancellationToken: ct);
        await Sessions.CreateIfNotExistsAsync(cancellationToken: ct);

        if (_storage.ConfigureCors)
        {
            // The browser PUTs blocks straight to Blob Storage, so the storage account
            // itself must allow the Angular origin. In production set this via IaC.
            // Read-modify-write so logging/metrics settings on the account are kept.
            BlobServiceProperties properties = await Service.GetPropertiesAsync(ct);
            properties.Cors =
            [
                new BlobCorsRule
                {
                    AllowedOrigins = _clientOrigin,
                    AllowedMethods = "PUT,GET,HEAD,OPTIONS",
                    AllowedHeaders = "*",
                    ExposedHeaders = "*",
                    MaxAgeInSeconds = 3600,
                },
            ];
            await Service.SetPropertiesAsync(properties, ct);
        }
    }

    /// <summary>
    /// Block IDs must be base64 and all the same length within a blob, so the index
    /// is zero-padded. The Angular client uses the identical formula.
    /// </summary>
    public static string BlockIdFor(int index) =>
        Convert.ToBase64String(Encoding.UTF8.GetBytes($"block-{index:D6}"));

    public static int? BlockIndexFor(string blockId)
    {
        try
        {
            var match = BlockIdPattern().Match(Encoding.UTF8.GetString(Convert.FromBase64String(blockId)));
            return match.Success ? int.Parse(match.Groups[1].Value) : null;
        }
        catch (FormatException)
        {
            return null;
        }
    }

    /// <summary>
    /// Write-only SAS for a single blob. The client can stage blocks but cannot read,
    /// list or delete anything, and the token expires quickly.
    /// </summary>
    public async Task<(Uri Url, DateTimeOffset ExpiresOn)> CreateUploadSasAsync(string blobName, CancellationToken ct = default)
    {
        var blob = Uploads.GetBlobClient(blobName);
        var sas = new BlobSasBuilder
        {
            BlobContainerName = Uploads.Name,
            BlobName = blobName,
            Resource = "b",
            StartsOn = DateTimeOffset.UtcNow.AddMinutes(-5), // tolerate clock skew
            ExpiresOn = DateTimeOffset.UtcNow.AddMinutes(_upload.SasTtlMinutes),
        };
        sas.SetPermissions(BlobSasPermissions.Write);

        if (blob.CanGenerateSasUri) // account key (connection string / Azurite)
            return (blob.GenerateSasUri(sas), sas.ExpiresOn);

        // Managed Identity: sign with a user delegation key instead of an account key.
        sas.Protocol = SasProtocol.Https;
        var query = sas.ToSasQueryParameters(await GetDelegationKeyAsync(ct), Service.AccountName);
        return (new BlobUriBuilder(blob.Uri) { Sas = query }.ToUri(), sas.ExpiresOn);
    }

    private async Task<UserDelegationKey> GetDelegationKeyAsync(CancellationToken ct)
    {
        await _delegationKeyLock.WaitAsync(ct);
        try
        {
            // Reuse the key while it has at least an hour left; one key signs many SAS tokens.
            if (_delegationKey is not { } cached || cached.ExpiresOn - DateTimeOffset.UtcNow < TimeSpan.FromHours(1))
            {
                var expiresOn = DateTimeOffset.UtcNow.AddHours(6);
                var key = await Service.GetUserDelegationKeyAsync(DateTimeOffset.UtcNow.AddMinutes(-5), expiresOn, ct);
                _delegationKey = (key.Value, expiresOn);
            }
            return _delegationKey.Value.Key;
        }
        finally
        {
            _delegationKeyLock.Release();
        }
    }

    public static bool IsNotFound(RequestFailedException ex) => ex.Status == 404;

    [GeneratedRegex(@"^block-(\d{6})$")]
    private static partial Regex BlockIdPattern();
}
