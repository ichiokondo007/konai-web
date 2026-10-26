import { createApp } from "./app.js";
import { loadConfig, type Config } from "./config.js";
import { LightService } from "./service/LightService.js";
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
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal} received, shutting down`);
  const forceExit = setTimeout(() => {
    console.error("shutdown timed out");
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);

  await new Promise<void>((resolve) => server.close(() => resolve()));
  await gateway.close();
  clearTimeout(forceExit);
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
