import { Router } from "express";
import type { LightGateway } from "../zigbee/LightGateway.js";

export function createHealthRouter(gateway: LightGateway): Router {
  const router = Router();

  router.get("/", (_req, res) => {
    if (gateway.isConnected()) {
      res.json({ status: "ok", mqtt: "connected" });
    } else {
      res.status(503).json({ status: "degraded", mqtt: "disconnected" });
    }
  });

  return router;
}
