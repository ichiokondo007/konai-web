import { createApp } from "./app.js";
import { loadConfig, type Config } from "./config.js";
import { LightService } from "./service/LightService.js";
import { gracefulShutdown } from "./shutdown.js";
import { Zigbee2MqttGateway } from "./zigbee/Zigbee2MqttGateway.js";

const SHUTDOWN_TIMEOUT_MS = 10_000;

function readConfig(): Config {
  try {
    return loadConfig();
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

const config = readConfig();

const gateway = new Zigbee2MqttGateway({
  url: config.mqttUrl,
  baseTopic: config.mqttBaseTopic,
  timeoutMs: config.deviceTimeoutMs,
});
gateway.connect();

const app = createApp({ service: new LightService(config.lights, gateway), gateway });
const server = app.listen(config.port, () => {
  console.log(`listening on ${config.port}`);
});

let shuttingDown = false;
function onSignal(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal} received, shutting down`);
  void gracefulShutdown(server, gateway, {
    timeoutMs: SHUTDOWN_TIMEOUT_MS,
    exit: (code) => process.exit(code),
    log: (m) => console.log(m),
    error: (m) => console.error(m),
  });
}

process.on("SIGTERM", () => onSignal("SIGTERM"));
process.on("SIGINT", () => onSignal("SIGINT"));
