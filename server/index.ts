
import "dotenv/config";
import { closeRateLimitStore, connectRateLimitStore } from "./rate-limit.js";
import { pool } from "./db.js";

const port = Number(process.env.PORT ?? 3001);
const host = process.env.HOST ?? "0.0.0.0";

async function start(): Promise<void> {
  // Step 1: Connect Redis first
  await connectRateLimitStore();

  console.log("Redis rate-limit store connected.");

  // Step 2: Import app only after Redis is ready
  const { app } = await import("./app.js");

  // Step 3: Start the server
  const server = app.listen(port, host, () => {
    console.log(`LedgerLine API listening on http://${host}:${port}`);
  });

  const shutdown = (): void => {
    server.close(() => {
      void Promise.all([
        pool.end(),
        closeRateLimitStore()
      ])
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
  process.exit(1);
});
