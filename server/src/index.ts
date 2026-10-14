import cors from 'cors';
import express, { type NextFunction, type Request, type Response } from 'express';
import { initStorage } from './azure.js';
import { config } from './config.js';
import { errorHandler, uploadsRouter } from './routes/uploads.js';

declare global {
  namespace Express {
    interface Request {
      userId: string;
    }
  }
}

/**
 * DEMO ONLY: takes the user from a header. Replace with real authentication
 * (e.g. validate an Entra ID / MSAL bearer token and use its `oid` claim).
 */
function demoAuth(req: Request, _res: Response, next: NextFunction) {
  req.userId = req.header('x-user-id')?.slice(0, 64) || 'demo-user';
  next();
}

const app = express();
app.use(cors({ origin: config.clientOrigin }));
app.use(express.json({ limit: '16kb' })); // only metadata comes through the API, never file bytes
app.get('/healthz', (_req, res) => {
  res.send('ok');
});
app.use('/api/uploads', demoAuth, uploadsRouter);
app.use(errorHandler);

try {
  await initStorage();
} catch (err) {
  console.error(
    '\nCould not reach Azure Storage. Is Azurite running (`npm run azurite`), and is\n' +
      'AZURE_STORAGE_CONNECTION_STRING / AZURE_STORAGE_ACCOUNT_URL set (see .env.example)?\n',
  );
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}
app.listen(config.port, () => {
  console.log(`Upload API listening on http://localhost:${config.port}`);
});
