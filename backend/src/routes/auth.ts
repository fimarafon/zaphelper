import bcrypt from "bcryptjs";
import type { FastifyPluginAsync } from "fastify";
import type { AppConfig } from "../config.js";
import { AUTH_COOKIE, requireAuth, signAuthToken } from "../middleware/auth.js";

export interface AuthRoutesDeps {
  config: AppConfig;
}

export const authRoutes: FastifyPluginAsync<AuthRoutesDeps> = async (fastify, { config }) => {
  fastify.post<{ Body: { username: string; password: string } }>(
    "/api/auth/login",
    async (req, reply) => {
      const body = req.body;
      if (
        !body ||
        typeof body.username !== "string" ||
        typeof body.password !== "string"
      ) {
        return reply.code(400).send({ error: "username and password required" });
      }

      if (body.username !== config.ADMIN_USER) {
        return reply.code(401).send({ error: "Invalid credentials" });
      }

      const ok = await bcrypt.compare(body.password, config.ADMIN_PASSWORD_HASH);
      if (!ok) {
        return reply.code(401).send({ error: "Invalid credentials" });
      }

      const token = signAuthToken(config, body.username);
      reply.setCookie(AUTH_COOKIE, token, {
        path: "/",
        httpOnly: true,
        secure: config.COOKIE_SECURE,
        sameSite: "strict",
        maxAge: 60 * 60 * 24 * 7,
      });

      return { ok: true, user: { username: body.username } };
    },
  );

  fastify.post("/api/auth/logout", async (_req, reply) => {
    reply.clearCookie(AUTH_COOKIE, { path: "/" });
    return { ok: true };
  });

  fastify.get("/api/auth/me", async (req, reply) => {
    try {
      requireAuth(req);
    } catch {
      return reply.code(401).send({ error: "Unauthorized" });
    }
    return { user: { username: req.authUser?.sub } };
  });
};
