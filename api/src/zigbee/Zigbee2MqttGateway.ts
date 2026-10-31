import mqtt, { type MqttClient } from "mqtt";
import { DeviceTimeoutError, MqttUnavailableError } from "../errors.js";
import type { LightCommand, LightGateway, LightState } from "./LightGateway.js";

export interface Zigbee2MqttGatewayOptions {
  url: string;
  baseTopic: string;
  timeoutMs: number;
  /** mqtt.js の reconnectPeriod。既定 1000ms */
  reconnectPeriodMs?: number;
}

interface Waiter {
  resolve: (state: LightState) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

export class Zigbee2MqttGateway implements LightGateway {
  private readonly options: Required<Zigbee2MqttGatewayOptions>;
  private client: MqttClient | null = null;
  /** `${baseTopic}/+` の購読が完了しているか。応答を受け取れる状態の判定に使う */
  private subscribed = false;
  private readonly waiters = new Map<string, Set<Waiter>>();

  constructor(options: Zigbee2MqttGatewayOptions) {
    this.options = { reconnectPeriodMs: 1000, ...options };
  }

  connect(): void {
    // resubscribe は無効にし、購読は connect ごとに自前で行う。
    // 有効のままだと mqtt.js が再接続時に内部で SUBSCRIBE を送り、こちらの subscribe() は
    // 登録済みとして SUBACK を待たずにコールバックされるため、購読完了前に接続済みと判定してしまう。
    const client = mqtt.connect(this.options.url, {
      reconnectPeriod: this.options.reconnectPeriodMs,
      resubscribe: false,
    });
    this.client = client;

    client.on("connect", () => {
      console.log(`mqtt connected: ${this.options.url}`);
      client.subscribe(`${this.options.baseTopic}/+`, (err) => {
        if (err) {
          console.warn(`mqtt subscribe failed: ${err.message}`);
          return;
        }
        this.subscribed = true;
      });
    });
    client.on("close", () => {
      this.subscribed = false;
      console.warn("mqtt connection closed");
    });
    client.on("error", (err) => console.warn(`mqtt error: ${err.message}`));
    client.on("message", (topic, payload) => this.onMessage(topic, payload));
  }

  async close(): Promise<void> {
    const client = this.client;
    this.client = null;
    for (const name of this.waiters.keys()) {
      this.rejectWaiters(name, new MqttUnavailableError());
    }
    if (client) await client.endAsync();
  }

  isConnected(): boolean {
    return this.client?.connected === true && this.subscribed;
  }

  /** 保留中の応答待ちの数(テスト・診断用) */
  pendingWaiterCount(): number {
    let n = 0;
    for (const set of this.waiters.values()) n += set.size;
    return n;
  }

  setState(name: string, command: LightCommand): Promise<LightState> {
    return this.request(name, `${this.options.baseTopic}/${name}/set`, JSON.stringify(command));
  }

  getState(name: string): Promise<LightState> {
    return this.request(name, `${this.options.baseTopic}/${name}/get`, JSON.stringify({ state: "" }));
  }

  private request(name: string, topic: string, payload: string): Promise<LightState> {
    const client = this.client;
    if (!client || !this.isConnected()) {
      return Promise.reject(new MqttUnavailableError());
    }
    const pending = this.waitForState(name);
    client.publish(topic, payload, (err) => {
      if (err) this.rejectWaiters(name, new MqttUnavailableError());
    });
    return pending;
  }

  private waitForState(name: string): Promise<LightState> {
    return new Promise<LightState>((resolve, reject) => {
      const set = this.waiters.get(name) ?? new Set<Waiter>();
      this.waiters.set(name, set);
      const waiter: Waiter = {
        resolve,
        reject,
        timer: setTimeout(() => {
          set.delete(waiter);
          reject(new DeviceTimeoutError(name, this.options.timeoutMs));
        }, this.options.timeoutMs),
      };
      set.add(waiter);
    });
  }

  private onMessage(topic: string, payload: Buffer): void {
    const prefix = `${this.options.baseTopic}/`;
    if (!topic.startsWith(prefix)) return;
    const name = topic.slice(prefix.length);
    if (name === "" || name.includes("/")) return;

    const state = parseState(payload);
    if (!state) {
      console.warn(`ignoring malformed state message on ${topic}`);
      return;
    }
    const set = this.waiters.get(name);
    if (!set) return;
    for (const w of set) {
      clearTimeout(w.timer);
      w.resolve(state);
    }
    set.clear();
  }

  private rejectWaiters(name: string, err: Error): void {
    const set = this.waiters.get(name);
    if (!set) return;
    for (const w of set) {
      clearTimeout(w.timer);
      w.reject(err);
    }
    set.clear();
  }
}

function parseState(payload: Buffer): LightState | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload.toString());
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const { state, brightness } = parsed as { state?: unknown; brightness?: unknown };
  if (state !== "ON" && state !== "OFF") return null;
  const result: LightState = { state, receivedAt: new Date() };
  if (typeof brightness === "number") result.brightness = brightness;
  return result;
}
