import { pino, type Logger } from "pino";

export function createLogger(nodeEnv: string): Logger {
  const isDev = nodeEnv !== "production";
  return pino({
    level: isDev ? "debug" : "info",
    base: { app: "zaphelper" },
    timestamp: pino.stdTimeFunctions.isoTime,
    transport: isDev
      ? {
          target: "pino-pretty",
          options: {
            colorize: true,
            translateTime: "SYS:HH:MM:ss",
            ignore: "pid,hostname,app",
          },
        }
      : undefined,
  });
}
