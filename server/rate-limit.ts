import rateLimit from "express-rate-limit";
import { RedisStore } from "rate-limit-redis";
import { createClient } from "redis";

const redisUrl = process.env.REDIS_URL;

if (process.env.NODE_ENV === "production" && !redisUrl) {
  throw new Error("REDIS_URL must be configured in production.");
}

export const rateLimitBackend = redisUrl ? "redis" : "memory";
const redisClient = redisUrl ? createClient({ url: redisUrl }) : undefined;

redisClient?.on("error", () => {
  console.error("Redis connection error.");
});

export async function connectRateLimitStore(): Promise<void> {
  if (redisClient && !redisClient.isOpen) {
    await redisClient.connect();
  }
}

export function isRateLimitStoreReady(): boolean {
  return redisClient ? redisClient.isReady : process.env.NODE_ENV !== "production";
}

export async function closeRateLimitStore(): Promise<void> {
  if (redisClient?.isOpen) {
    await redisClient.quit();
  }
}

export function createRateLimiter(windowMs: number, limit: number) {
  return rateLimit({
    windowMs,
    limit,
    standardHeaders: true,
    legacyHeaders: false,
    store: redisClient
      ? new RedisStore({
          sendCommand: (...args: string[]) => redisClient.sendCommand(args)
        })
      : undefined
  });
}
