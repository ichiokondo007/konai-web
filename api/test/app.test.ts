import { describe, it, expect, beforeEach, vi } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { createApp } from "../src/app.js";
import { LightService } from "../src/service/LightService.js";
import { DeviceTimeoutError, MqttUnavailableError } from "../src/errors.js";
import { StubGateway } from "./helpers/stubGateway.js";

let gw: StubGateway;
let app: Express;

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  gw = new StubGateway();
  app = createApp({ service: new LightService(["living1"], gw), gateway: gw });
});

describe("GET /lights", () => {
  it("returns names", async () => {
    const r = await request(app).get("/lights");
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ lights: ["living1"] });
  });
});

describe("GET /lights/:name", () => {
  it("returns state", async () => {
    const r = await request(app).get("/lights/living1");
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ name: "living1", state: "ON", brightness: 254, updatedAt: "2026-10-26T12:00:00.000Z" });
  });

  it("404 for unknown light", async () => {
    const r = await request(app).get("/lights/living9");
    expect(r.status).toBe(404);
    expect(r.body).toEqual({ error: { code: "LIGHT_NOT_FOUND", message: "unknown light: living9" } });
  });
});

describe("PUT /lights/:name/state", () => {
  it("sets ON and returns state", async () => {
    const r = await request(app).put("/lights/living1/state").send({ state: "ON" });
    expect(r.status).toBe(200);
    expect(gw.calls).toEqual([{ method: "setState", name: "living1", command: { state: "ON" } }]);
    expect(r.body).toEqual({ name: "living1", state: "ON", brightness: 254, updatedAt: "2026-10-26T12:00:00.000Z" });
  });

  it("sets OFF", async () => {
    await request(app).put("/lights/living1/state").send({ state: "OFF" });
    expect(gw.calls[0]).toEqual({ method: "setState", name: "living1", command: { state: "OFF" } });
  });

  it("state only: forwards exactly { state } without brightness", async () => {
    await request(app).put("/lights/living1/state").send({ state: "ON" });
    expect(gw.calls[0].command).toEqual({ state: "ON" });
    expect(gw.calls[0].command).not.toHaveProperty("brightness");
  });

  it("brightness only: forwards { brightness }", async () => {
    const r = await request(app).put("/lights/living1/state").send({ brightness: 100 });
    expect(r.status).toBe(200);
    expect(gw.calls).toEqual([{ method: "setState", name: "living1", command: { brightness: 100 } }]);
  });

  it("state and brightness: forwards both", async () => {
    const r = await request(app).put("/lights/living1/state").send({ state: "ON", brightness: 0 });
    expect(r.status).toBe(200);
    expect(gw.calls).toEqual([{ method: "setState", name: "living1", command: { state: "ON", brightness: 0 } }]);
  });

  it("accepts the upper bound 254", async () => {
    const r = await request(app).put("/lights/living1/state").send({ brightness: 254 });
    expect(r.status).toBe(200);
  });

  it("ignores unknown body fields", async () => {
    await request(app).put("/lights/living1/state").send({ state: "ON", color_temp: 300 });
    expect(gw.calls[0].command).toEqual({ state: "ON" });
  });

  it.each([
    {},
    { state: "on" },
    { state: "TOGGLE" },
    { state: 1 },
    { brightness: 255 },
    { brightness: -1 },
    { brightness: 1.5 },
    { brightness: "100" },
    { brightness: null },
    { state: "ON", brightness: 300 },
    { state: "on", brightness: 100 },
  ])("400 for body %j", async (body) => {
    const r = await request(app).put("/lights/living1/state").send(body);
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe("INVALID_REQUEST");
    expect(gw.calls).toEqual([]);
  });

  it("malformed JSON body returns 400", async () => {
    const r = await request(app)
      .put("/lights/living1/state")
      .set("content-type", "application/json")
      .send("{bad");
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe("INVALID_REQUEST");
  });

  it("404 for unknown light", async () => {
    const r = await request(app).put("/lights/living9/state").send({ state: "ON" });
    expect(r.status).toBe(404);
  });

  it("503 when gateway throws MqttUnavailableError", async () => {
    gw.failWith = new MqttUnavailableError();
    const r = await request(app).put("/lights/living1/state").send({ state: "ON" });
    expect(r.status).toBe(503);
    expect(r.body.error.code).toBe("MQTT_UNAVAILABLE");
  });

  it("504 when gateway throws DeviceTimeoutError", async () => {
    gw.failWith = new DeviceTimeoutError("living1", 5000);
    const r = await request(app).put("/lights/living1/state").send({ state: "ON" });
    expect(r.status).toBe(504);
    expect(r.body).toEqual({ error: { code: "DEVICE_TIMEOUT", message: "no response from living1 within 5000ms" } });
  });

  it("500 without stack for unknown errors", async () => {
    gw.failWith = new Error("boom secret");
    const r = await request(app).put("/lights/living1/state").send({ state: "ON" });
    expect(r.status).toBe(500);
    expect(r.body).toEqual({ error: { code: "INTERNAL_ERROR", message: "internal error" } });
    expect(JSON.stringify(r.body)).not.toContain("boom");
  });
});

describe("GET /health", () => {
  it("200 when connected", async () => {
    const r = await request(app).get("/health");
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ status: "ok", mqtt: "connected" });
  });

  it("503 when disconnected", async () => {
    gw.connected = false;
    const r = await request(app).get("/health");
    expect(r.status).toBe(503);
    expect(r.body).toEqual({ status: "degraded", mqtt: "disconnected" });
  });
});

it("unknown route returns JSON 404", async () => {
  const r = await request(app).delete("/lights/living1");
  expect(r.status).toBe(404);
  expect(r.body).toEqual({ error: { code: "NOT_FOUND", message: "not found" } });
});
