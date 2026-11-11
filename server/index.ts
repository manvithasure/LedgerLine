import "dotenv/config";
import { app } from "./app.js";
import { closeRateLimitStore, connectRateLimitStore } from "./rate-limit.js";
import { pool } from "./db.js";

const port = Number(process.env.PORT ?? 3001);
const host = process.env.HOST ?? "127.0.0.1";

async function start(): Promise<void> {
  await connectRateLimitStore();
  const server = app.listen(port, host, () => {
    console.log(`LedgerLine API listening on http://${host}:${port}`);
  });

  const shutdown = (): void => {
    server.close(() => {
      void Promise.all([pool.end(), closeRateLimitStore()])
        .then(() => process.exit(0))
        .catch((error: unknown) => {
          console.error("Service shutdown failed:", error);
          process.exit(1);
        });
    });
  };

  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

start().catch((error: unknown) => {
  console.error("Could not start LedgerLine API:", error);
  process.exitCode = 1;
});
