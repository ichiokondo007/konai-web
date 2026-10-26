import { describe, it, expect } from "vitest";
import { loadConfig } from "../src/config.js";

const base = { MQTT_URL: "mqtt://broker:1883", LIGHTS: "living1" };

describe("loadConfig", () => {
  it("applies defaults", () => {
    const c = loadConfig(base);
    expect(c).toEqual({
      port: 3000,
      mqttUrl: "mqtt://broker:1883",
      mqttBaseTopic: "zigbee2mqtt",
      lights: ["living1"],
      deviceTimeoutMs: 5000,
    });
  });

  it("splits LIGHTS by comma and trims", () => {
    expect(loadConfig({ ...base, LIGHTS: "living1, living2" }).lights).toEqual(["living1", "living2"]);
  });

  it("reads overrides", () => {
    const c = loadConfig({ ...base, PORT: "8081", MQTT_BASE_TOPIC: "z2m", DEVICE_TIMEOUT_MS: "250" });
    expect(c.port).toBe(8081);
    expect(c.mqttBaseTopic).toBe("z2m");
    expect(c.deviceTimeoutMs).toBe(250);
  });

  it("fails without MQTT_URL", () => {
    expect(() => loadConfig({ LIGHTS: "living1" })).toThrow("MQTT_URL is required");
  });

  it("fails without LIGHTS", () => {
    expect(() => loadConfig({ MQTT_URL: base.MQTT_URL })).toThrow("LIGHTS is required");
  });

  it("fails on empty light name", () => {
    expect(() => loadConfig({ ...base, LIGHTS: "living1,,living2" })).toThrow("LIGHTS contains an empty name");
  });

  it("fails on non-numeric PORT", () => {
    expect(() => loadConfig({ ...base, PORT: "abc" })).toThrow("PORT must be a positive integer");
  });

  it("fails on zero DEVICE_TIMEOUT_MS", () => {
    expect(() => loadConfig({ ...base, DEVICE_TIMEOUT_MS: "0" })).toThrow("DEVICE_TIMEOUT_MS must be a positive integer");
  });
});
