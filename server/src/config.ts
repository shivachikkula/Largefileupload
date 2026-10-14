import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Load server/.env however the API is started (npm scripts, npx tsx, VS Code debugger).
// Works from both src/ and dist/; variables already set in the environment win.
const envFile = fileURLToPath(new URL('../.env', import.meta.url));
if (existsSync(envFile)) process.loadEnvFile(envFile);

const MiB = 1024 * 1024;

export const config = {
  port: Number(process.env.PORT ?? 3000),
  clientOrigin: process.env.CLIENT_ORIGIN ?? 'http://localhost:4200',

  /** Either a connection string (account key / Azurite) ... */
  connectionString: process.env.AZURE_STORAGE_CONNECTION_STRING,
  /** ... or an account URL used with DefaultAzureCredential (Managed Identity). */
  accountUrl: process.env.AZURE_STORAGE_ACCOUNT_URL,

  uploadContainer: process.env.UPLOAD_CONTAINER ?? 'uploads',
  sessionContainer: process.env.SESSION_CONTAINER ?? 'upload-sessions',
  configureStorageCors: process.env.CONFIGURE_STORAGE_CORS === 'true',

  maxFileSize: Number(process.env.MAX_FILE_SIZE ?? 50 * 1024 * MiB), // 50 GiB
  minBlockSize: 8 * MiB,
  /** Azure allows at most 50,000 committed blocks per block blob. */
  maxBlocks: 50_000,

  /** SAS lifetime. Short on purpose; the client asks for a fresh one when it expires. */
  sasTtlMinutes: 30,
  /** Azure discards uncommitted blocks after 7 days, so sessions can't outlive that. */
  sessionTtlDays: 7,
};
