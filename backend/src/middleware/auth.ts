import type { FastifyInstance, FastifyRequest } from "fastify";
import jwt from "jsonwebtoken";
import type { AppConfig } from "../config.js";

export interface AuthUser {
  sub: string; // username
}

declare module "fastify" {
  interface FastifyRequest {
    authUser?: AuthUser;
  }
}

export const AUTH_COOKIE = "zaphelper_auth";

/**
 * Registers a preHandler hook on the given Fastify instance that reads the
 * auth cookie and attaches `authUser` to the request. Route handlers that
 * need auth should call `requireAuth(req)` themselves.
 *
 * Note: we register at the root (not a scoped plugin) so the decoration
 * propagates to every route including nested ones.
 */
export function registerAuthHook(app: FastifyInstance, config: AppConfig): void {
  app.addHook("preHandler", async (req) => {
    const token = req.cookies?.[AUTH_COOKIE];
    if (!token) return;
    try {
      const decoded = jwt.verify(token, config.JWT_SECRET);
      if (typeof decoded === "object" && decoded !== null && "sub" in decoded) {
        req.authUser = { sub: String((decoded as jwt.JwtPayload).sub) };
      }
    } catch {
      // invalid / expired — leave authUser undefined
    }
  });
}

export function requireAuth(req: FastifyRequest): void {
  if (!req.authUser) {
    const err = new Error("Unauthorized") as Error & { statusCode: number };
    err.statusCode = 401;
    throw err;
  }
}

export function signAuthToken(config: AppConfig, username: string): string {
  return jwt.sign({ sub: username }, config.JWT_SECRET, {
    expiresIn: "7d",
  });
}
