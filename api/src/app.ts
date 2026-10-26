import express from "express";
import type { ErrorRequestHandler, Express, RequestHandler } from "express";
import { DeviceTimeoutError, InvalidRequestError, LightNotFoundError, MqttUnavailableError } from "./errors.js";
import { createHealthRouter } from "./http/healthRouter.js";
import { createLightsRouter } from "./http/lightsRouter.js";
import type { LightService } from "./service/LightService.js";
import type { LightGateway } from "./zigbee/LightGateway.js";

export interface AppDeps {
  service: LightService;
  gateway: LightGateway;
}

const requestLog: RequestHandler = (req, res, next) => {
  const started = Date.now();
  res.on("finish", () => {
    console.log(`${req.method} ${req.originalUrl} ${res.statusCode} ${Date.now() - started}ms`);
  });
  next();
};

const notFound: RequestHandler = (_req, res) => {
  res.status(404).json({ error: { code: "NOT_FOUND", message: "not found" } });
};

function statusFor(err: unknown): { status: number; code: string; message: string } | null {
  if (err instanceof InvalidRequestError) return { status: 400, code: err.code, message: err.message };
  if (err instanceof LightNotFoundError) return { status: 404, code: err.code, message: err.message };
  if (err instanceof MqttUnavailableError) return { status: 503, code: err.code, message: err.message };
  if (err instanceof DeviceTimeoutError) return { status: 504, code: err.code, message: err.message };
  if (isBodyParseError(err)) return { status: 400, code: "INVALID_REQUEST", message: "body must be valid JSON" };
  return null;
}

function isBodyParseError(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { type?: unknown }).type === "entity.parse.failed";
}

const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  const mapped = statusFor(err);
  if (mapped) {
    res.status(mapped.status).json({ error: { code: mapped.code, message: mapped.message } });
    return;
  }
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  res.status(500).json({ error: { code: "INTERNAL_ERROR", message: "internal error" } });
};

export function createApp(deps: AppDeps): Express {
  const app = express();
  app.disable("x-powered-by");
  app.use(requestLog);
  app.use(express.json());
  app.use("/lights", createLightsRouter(deps.service));
  app.use("/health", createHealthRouter(deps.gateway));
  app.use(notFound);
  app.use(errorHandler);
  return app;
}
