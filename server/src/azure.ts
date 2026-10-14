import {
  BlobSASPermissions,
  BlobServiceClient,
  ContainerClient,
  SASProtocol,
  StorageSharedKeyCredential,
  UserDelegationKey,
  generateBlobSASQueryParameters,
} from '@azure/storage-blob';
import { DefaultAzureCredential } from '@azure/identity';
import { config } from './config.js';

function createServiceClient(): BlobServiceClient {
  if (config.connectionString) {
    return BlobServiceClient.fromConnectionString(config.connectionString);
  }
  if (config.accountUrl) {
    return new BlobServiceClient(config.accountUrl, new DefaultAzureCredential());
  }
  throw new Error(
    'Set AZURE_STORAGE_CONNECTION_STRING or AZURE_STORAGE_ACCOUNT_URL. For local development copy ' +
      'server/.env.example to server/.env (PowerShell: Copy-Item .env.example .env).',
  );
}

export const blobService = createServiceClient();
export const uploadContainer: ContainerClient = blobService.getContainerClient(config.uploadContainer);
export const sessionContainer: ContainerClient = blobService.getContainerClient(config.sessionContainer);

export async function initStorage(): Promise<void> {
  await uploadContainer.createIfNotExists();
  await sessionContainer.createIfNotExists();

  if (config.configureStorageCors) {
    // The browser PUTs blocks straight to Blob Storage, so the storage account
    // itself must allow the Angular origin. In production set this via IaC.
    await blobService.setProperties({
      cors: [
        {
          allowedOrigins: config.clientOrigin,
          allowedMethods: 'PUT,GET,HEAD,OPTIONS',
          allowedHeaders: '*',
          exposedHeaders: '*',
          maxAgeInSeconds: 3600,
        },
      ],
    });
  }
}

/**
 * Block IDs must be base64 and all the same length within a blob, so the
 * index is zero-padded. The Angular client uses the identical formula.
 */
export function blockIdFor(index: number): string {
  return Buffer.from(`block-${index.toString().padStart(6, '0')}`).toString('base64');
}

export function blockIndexFor(blockId: string): number | undefined {
  const match = /^block-(\d{6})$/.exec(Buffer.from(blockId, 'base64').toString());
  return match ? Number(match[1]) : undefined;
}

let delegationKey: { key: UserDelegationKey; expiresOn: Date } | undefined;

async function getDelegationKey(): Promise<UserDelegationKey> {
  // Reuse the key while it has at least an hour left; one key signs many SAS tokens.
  if (!delegationKey || delegationKey.expiresOn.getTime() - Date.now() < 60 * 60 * 1000) {
    const startsOn = new Date(Date.now() - 5 * 60 * 1000);
    const expiresOn = new Date(Date.now() + 6 * 60 * 60 * 1000);
    delegationKey = { key: await blobService.getUserDelegationKey(startsOn, expiresOn), expiresOn };
  }
  return delegationKey.key;
}

/**
 * Write-only SAS for a single blob. The client can stage blocks but cannot read,
 * list or delete anything, and the token expires quickly.
 */
export async function createUploadSas(blobName: string): Promise<{ url: string; expiresOn: Date }> {
  const blobClient = uploadContainer.getBlockBlobClient(blobName);
  const startsOn = new Date(Date.now() - 5 * 60 * 1000); // tolerate clock skew
  const expiresOn = new Date(Date.now() + config.sasTtlMinutes * 60 * 1000);
  const permissions = BlobSASPermissions.parse('w');

  if (blobService.credential instanceof StorageSharedKeyCredential) {
    const url = await blobClient.generateSasUrl({ permissions, startsOn, expiresOn });
    return { url, expiresOn };
  }

  const sas = generateBlobSASQueryParameters(
    {
      containerName: uploadContainer.containerName,
      blobName,
      permissions,
      startsOn,
      expiresOn,
      protocol: SASProtocol.Https,
    },
    await getDelegationKey(),
    blobService.accountName,
  ).toString();
  return { url: `${blobClient.url}?${sas}`, expiresOn };
}
