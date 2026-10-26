import { createServer, type AddressInfo, type Server } from "node:net";
import { Aedes } from "aedes";

export interface TestBroker {
  port: number;
  url: string;
  /** テスト側が Zigbee2MQTT のふりをして応答を流す */
  publish(topic: string, payload: string): Promise<void>;
  /** クライアントがそのトピックに次に publish した payload を返す */
  nextPublish(topic: string): Promise<string>;
  close(): Promise<void>;
}

export async function startTestBroker(port = 0): Promise<TestBroker> {
  const broker = await Aedes.createBroker();
  const server: Server = createServer(broker.handle);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve());
  });
  const actualPort = (server.address() as AddressInfo).port;

  return {
    port: actualPort,
    url: `mqtt://127.0.0.1:${actualPort}`,
    publish(topic, payload) {
      return new Promise((resolve, reject) => {
        broker.publish(
          { cmd: "publish", topic, payload, qos: 0, retain: false, dup: false },
          (err) => (err ? reject(err) : resolve()),
        );
      });
    },
    nextPublish(topic) {
      return new Promise((resolve) => {
        const listener = (packet: { topic: string; payload: Buffer | string }, client: unknown) => {
          if (client === null || packet.topic !== topic) return;
          broker.removeListener("publish", listener);
          resolve(packet.payload.toString());
        };
        broker.on("publish", listener);
      });
    },
    close() {
      return new Promise((resolve) => {
        broker.close(() => {
          server.close(() => resolve());
        });
      });
    },
  };
}
