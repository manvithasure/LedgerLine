import type { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";

export type Role = "ADMIN" | "HOLDER" | "AUDITOR";

export interface AuthUser {
  id: string;
  email: string;
  displayName: string;
  role: Role;
}

declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

const secret = process.env.JWT_SECRET ?? "";
if (secret.length < 32) {
  throw new Error("JWT_SECRET must be set to at least 32 characters.");
}

export function createToken(user: AuthUser): string {
  return jwt.sign(user, secret, { expiresIn: "8h" });
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const authorization = req.header("authorization");
  if (!authorization?.startsWith("Bearer ")) {
    res.status(401).json({ error: "Sign in to continue." });
    return;
  }

  try {
    req.user = jwt.verify(authorization.slice(7), secret) as AuthUser;
    next();
  } catch {
    res.status(401).json({ error: "Your session has expired. Please sign in again." });
  }
}

export function requireRole(...roles: Role[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user || !roles.includes(req.user.role)) {
      res.status(403).json({ error: "You are not allowed to perform this action." });
      return;
    }
    next();
  };
}
