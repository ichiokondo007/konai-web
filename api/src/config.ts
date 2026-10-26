export interface Config {
  port: number;
  mqttUrl: string;
  mqttBaseTopic: string;
  lights: string[];
  deviceTimeoutMs: number;
}

function requireString(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key];
  if (value === undefined || value.trim() === "") {
    throw new Error(`${key} is required`);
  }
  return value;
}

function positiveInteger(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = env[key];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`${key} must be a positive integer`);
  }
  return n;
}

function parseLights(raw: string): string[] {
  const names = raw.split(",").map((s) => s.trim());
  if (names.some((n) => n === "")) {
    throw new Error("LIGHTS contains an empty name");
  }
  return names;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    port: positiveInteger(env, "PORT", 3000),
    mqttUrl: requireString(env, "MQTT_URL"),
    mqttBaseTopic: env.MQTT_BASE_TOPIC?.trim() || "zigbee2mqtt",
    lights: parseLights(requireString(env, "LIGHTS")),
    deviceTimeoutMs: positiveInteger(env, "DEVICE_TIMEOUT_MS", 5000),
  };
}
