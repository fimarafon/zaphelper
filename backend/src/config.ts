import dotenv from "dotenv";
import { z } from "zod";

// Load .env from the backend directory (dev workflow), then from the monorepo
// root. Later calls don't overwrite earlier values (dotenv default).
dotenv.config({ path: ".env" });
dotenv.config({ path: "../.env" });

const configSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.string().default("0.0.0.0"),

  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),

  EVOLUTION_API_URL: z.string().url("EVOLUTION_API_URL must be a URL"),
  EVOLUTION_API_KEY: z.string().min(1),
  EVOLUTION_INSTANCE_NAME: z.string().min(1).default("zaphelper-main"),

  WEBHOOK_URL: z.string().url("WEBHOOK_URL must be a public URL"),

  ADMIN_USER: z.string().min(1).default("admin"),
  ADMIN_PASSWORD_HASH: z.string().min(1, "ADMIN_PASSWORD_HASH required (bcrypt)"),
  JWT_SECRET: z.string().min(16, "JWT_SECRET must be at least 16 chars"),

  BE_HOME_LEADS_GROUP_NAME: z.string().default("Be Home Leads Scheduled"),

  SELF_PHONE_NUMBER: z
    .string()
    .optional()
    .transform((v) => (v ? v.replace(/\D/g, "") : undefined)),

  TZ: z.string().default("America/New_York"),

  COOKIE_SECURE: z
    .string()
    .optional()
    .transform((v) => v !== "false"),
});

export type AppConfig = z.infer<typeof configSchema>;

let cached: AppConfig | null = null;

export function loadConfig(): AppConfig {
  if (cached) return cached;
  const parsed = configSchema.safeParse(process.env);
  if (!parsed.success) {
    console.error("Invalid environment configuration:");
    for (const issue of parsed.error.issues) {
      console.error(`  - ${issue.path.join(".")}: ${issue.message}`);
    }
    process.exit(1);
  }
  cached = parsed.data;
  // Side-effect: align Node's TZ with our config so logs match.
  if (!process.env.TZ) {
    process.env.TZ = cached.TZ;
  }
  return cached;
}
