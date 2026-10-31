import { Router } from "express";
import { InvalidRequestError } from "../errors.js";
import type { LightService } from "../service/LightService.js";
import type { LightCommand } from "../zigbee/LightGateway.js";

const BRIGHTNESS_MIN = 0;
const BRIGHTNESS_MAX = 254;

function isBrightness(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= BRIGHTNESS_MIN && value <= BRIGHTNESS_MAX;
}

/**
 * body から変更指示を取り出す。`state`(ON/OFF)と `brightness`(0〜254 の整数)はどちらも任意だが、
 * 少なくとも一方が必要。それ以外のフィールドは無視する。
 */
function parseCommand(body: unknown): LightCommand {
  if (typeof body !== "object" || body === null) {
    throw new InvalidRequestError("body must be a JSON object");
  }
  const { state, brightness } = body as { state?: unknown; brightness?: unknown };
  const command: LightCommand = {};

  if (state !== undefined) {
    if (state !== "ON" && state !== "OFF") throw new InvalidRequestError('state must be "ON" or "OFF"');
    command.state = state;
  }
  if (brightness !== undefined) {
    if (!isBrightness(brightness)) {
      throw new InvalidRequestError(`brightness must be an integer between ${BRIGHTNESS_MIN} and ${BRIGHTNESS_MAX}`);
    }
    command.brightness = brightness;
  }
  if (command.state === undefined && command.brightness === undefined) {
    throw new InvalidRequestError("state or brightness is required");
  }
  return command;
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
    const command = parseCommand(req.body);
    res.json(await service.setState(req.params.name, command));
  });

  return router;
}
