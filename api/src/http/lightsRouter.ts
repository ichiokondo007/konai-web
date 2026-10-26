import { Router } from "express";
import { InvalidRequestError } from "../errors.js";
import type { LightService } from "../service/LightService.js";
import type { LightPower } from "../zigbee/LightGateway.js";

function parsePower(body: unknown): LightPower {
  if (typeof body === "object" && body !== null) {
    const state = (body as { state?: unknown }).state;
    if (state === "ON" || state === "OFF") return state;
  }
  throw new InvalidRequestError('state must be "ON" or "OFF"');
}

export function createLightsRouter(service: LightService): Router {
  const router = Router();

  router.get("/", (_req, res) => {
    res.json({ lights: service.listLights() });
  });

  router.get("/:name", async (req, res) => {
    res.json(await service.getState(req.params.name));
  });

  router.put("/:name/state", async (req, res) => {
    const state = parsePower(req.body);
    res.json(await service.setState(req.params.name, state));
  });

  return router;
}
