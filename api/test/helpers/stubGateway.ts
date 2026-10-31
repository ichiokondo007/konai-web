import type { LightCommand, LightGateway, LightState } from "../../src/zigbee/LightGateway.js";

export class StubGateway implements LightGateway {
  calls: Array<{ method: "setState" | "getState"; name: string; command?: LightCommand }> = [];
  next: LightState = { state: "ON", brightness: 254, receivedAt: new Date("2026-10-26T12:00:00.000Z") };
  failWith: Error | null = null;
  connected = true;

  async setState(name: string, command: LightCommand): Promise<LightState> {
    this.calls.push({ method: "setState", name, command });
    if (this.failWith) throw this.failWith;
    return this.next;
  }

  async getState(name: string): Promise<LightState> {
    this.calls.push({ method: "getState", name });
    if (this.failWith) throw this.failWith;
    return this.next;
  }

  isConnected(): boolean {
    return this.connected;
  }
}
