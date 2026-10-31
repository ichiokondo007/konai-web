import { describe, it, expect, beforeEach } from "vitest";
import { LightService } from "../src/service/LightService.js";
import { LightNotFoundError } from "../src/errors.js";
import { StubGateway } from "./helpers/stubGateway.js";

describe("LightService", () => {
  let gw: StubGateway;
  let service: LightService;

  beforeEach(() => {
    gw = new StubGateway();
    service = new LightService(["living1"], gw);
  });

  it("lists configured lights", () => {
    expect(new LightService(["living1", "living2"], gw).listLights()).toEqual(["living1", "living2"]);
  });

  it("setState forwards to gateway and shapes response", async () => {
    const r = await service.setState("living1", { state: "OFF", brightness: 10 });
    expect(gw.calls).toEqual([{ method: "setState", name: "living1", command: { state: "OFF", brightness: 10 } }]);
    expect(r).toEqual({ name: "living1", state: "ON", brightness: 254, updatedAt: "2026-10-26T12:00:00.000Z" });
  });

  it("getState forwards to gateway", async () => {
    await service.getState("living1");
    expect(gw.calls).toEqual([{ method: "getState", name: "living1" }]);
  });

  it("omits brightness when gateway has none", async () => {
    gw.next = { state: "OFF", receivedAt: new Date() };
    expect(await service.getState("living1")).not.toHaveProperty("brightness");
  });

  it("rejects unknown light without calling gateway", async () => {
    await expect(service.setState("living9", "ON")).rejects.toBeInstanceOf(LightNotFoundError);
    await expect(service.getState("living9")).rejects.toThrow("unknown light: living9");
    expect(gw.calls).toEqual([]);
  });
});
