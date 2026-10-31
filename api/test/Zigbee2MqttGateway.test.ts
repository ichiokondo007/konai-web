import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Zigbee2MqttGateway } from "../src/zigbee/Zigbee2MqttGateway.js";
import { DeviceTimeoutError, MqttUnavailableError } from "../src/errors.js";
import { startTestBroker, type TestBroker } from "./helpers/testBroker.js";

async function waitFor(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("waitFor: condition not met in time");
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("Zigbee2MqttGateway", () => {
  let broker: TestBroker;
  let gateway: Zigbee2MqttGateway;

  beforeEach(async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    broker = await startTestBroker();
    gateway = new Zigbee2MqttGateway({ url: broker.url, baseTopic: "zigbee2mqtt", timeoutMs: 200, reconnectPeriodMs: 50 });
    gateway.connect();
    await waitFor(() => gateway.isConnected());
  });

  afterEach(async () => {
    await gateway.close();
    await broker.close();
  });

  it("setState publishes to <name>/set and resolves with the reported state", async () => {
    const published = broker.nextPublish("zigbee2mqtt/living1/set");
    const pending = gateway.setState("living1", { state: "ON" });
    expect(JSON.parse(await published)).toEqual({ state: "ON" });
    await broker.publish("zigbee2mqtt/living1", JSON.stringify({ state: "ON", brightness: 200, linkquality: 100 }));
    const s = await pending;
    expect(s.state).toBe("ON");
    expect(s.brightness).toBe(200);
    expect(s.receivedAt).toBeInstanceOf(Date);
  });

  it("setState publishes state and brightness together when both are given", async () => {
    const published = broker.nextPublish("zigbee2mqtt/living1/set");
    const pending = gateway.setState("living1", { state: "ON", brightness: 100 });
    expect(JSON.parse(await published)).toEqual({ state: "ON", brightness: 100 });
    await broker.publish("zigbee2mqtt/living1", JSON.stringify({ state: "ON", brightness: 100 }));
    expect(await pending).toMatchObject({ state: "ON", brightness: 100 });
  });

  it("setState publishes only brightness when state is omitted", async () => {
    const published = broker.nextPublish("zigbee2mqtt/living1/set");
    const pending = gateway.setState("living1", { brightness: 50 });
    expect(JSON.parse(await published)).toEqual({ brightness: 50 });
    await broker.publish("zigbee2mqtt/living1", JSON.stringify({ state: "ON", brightness: 50 }));
    expect(await pending).toMatchObject({ state: "ON", brightness: 50 });
  });

  it('getState publishes {"state":""} to <name>/get', async () => {
    const published = broker.nextPublish("zigbee2mqtt/living1/get");
    const pending = gateway.getState("living1");
    expect(JSON.parse(await published)).toEqual({ state: "" });
    await broker.publish("zigbee2mqtt/living1", JSON.stringify({ state: "OFF" }));
    const s = await pending;
    expect(s).toMatchObject({ state: "OFF" });
    expect(s).not.toHaveProperty("brightness");
  });

  it("rejects with DeviceTimeoutError when no response", async () => {
    await expect(gateway.setState("living1", { state: "ON" })).rejects.toThrow(new DeviceTimeoutError("living1", 200).message);
  });

  it("ignores messages for other lights", async () => {
    const pending = gateway.setState("living1", { state: "ON" });
    await broker.publish("zigbee2mqtt/living2", JSON.stringify({ state: "ON" }));
    await expect(pending).rejects.toBeInstanceOf(DeviceTimeoutError);
  });

  it("rejects immediately with MqttUnavailableError when not connected", async () => {
    const offline = new Zigbee2MqttGateway({ url: "mqtt://127.0.0.1:1", baseTopic: "zigbee2mqtt", timeoutMs: 200, reconnectPeriodMs: 50 });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    offline.connect();
    const started = Date.now();
    await expect(offline.setState("living1", { state: "ON" })).rejects.toBeInstanceOf(MqttUnavailableError);
    expect(Date.now() - started).toBeLessThan(100);
    await offline.close();
  });

  it("resolves concurrent waiters for the same light with one message", async () => {
    const a = gateway.setState("living1", { state: "ON" });
    const b = gateway.getState("living1");
    await broker.publish("zigbee2mqtt/living1", JSON.stringify({ state: "ON" }));
    expect((await a).state).toBe("ON");
    expect((await b).state).toBe("ON");
  });

  it("ignores malformed JSON and resolves on the next valid message", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const pending = gateway.setState("living1", { state: "ON" });
    await broker.publish("zigbee2mqtt/living1", "{not json");
    await broker.publish("zigbee2mqtt/living1", JSON.stringify({ brightness: 10 }));
    await broker.publish("zigbee2mqtt/living1", JSON.stringify({ state: "ON" }));
    expect((await pending).state).toBe("ON");
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it("late response after timeout is ignored", async () => {
    await expect(gateway.setState("living1", { state: "ON" })).rejects.toBeInstanceOf(DeviceTimeoutError);
    await broker.publish("zigbee2mqtt/living1", JSON.stringify({ state: "ON" }));
    await new Promise((r) => setTimeout(r, 50));
    expect(gateway.pendingWaiterCount()).toBe(0);
  });

  it("leaves no waiters after resolve or reject", async () => {
    const p = gateway.setState("living1", { state: "ON" });
    await broker.publish("zigbee2mqtt/living1", JSON.stringify({ state: "ON" }));
    await p;
    await expect(gateway.getState("living1")).rejects.toBeInstanceOf(DeviceTimeoutError);
    expect(gateway.pendingWaiterCount()).toBe(0);
  });

  it("close rejects pending waiters", async () => {
    const pending = gateway.setState("living1", { state: "ON" });
    const rejected = expect(pending).rejects.toBeInstanceOf(MqttUnavailableError);
    await gateway.close();
    await rejected;
    await expect(gateway.setState("living1", { state: "ON" })).rejects.toBeInstanceOf(MqttUnavailableError);
  });

  it("reconnects and resubscribes after the broker restarts", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const port = broker.port;
    await broker.close();
    await waitFor(() => !gateway.isConnected());
    broker = await startTestBroker(port);
    await waitFor(() => gateway.isConnected());
    const pending = gateway.getState("living1");
    await broker.publish("zigbee2mqtt/living1", JSON.stringify({ state: "OFF" }));
    expect((await pending).state).toBe("OFF");
  });
});
