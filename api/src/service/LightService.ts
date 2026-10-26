import { LightNotFoundError } from "../errors.js";
import type { LightGateway, LightPower, LightState } from "../zigbee/LightGateway.js";

export interface LightResponse {
  name: string;
  state: LightPower;
  brightness?: number;
  updatedAt: string;
}

export class LightService {
  private readonly lights: readonly string[];
  private readonly gateway: LightGateway;

  constructor(lights: readonly string[], gateway: LightGateway) {
    this.lights = lights;
    this.gateway = gateway;
  }

  listLights(): string[] {
    return [...this.lights];
  }

  async getState(name: string): Promise<LightResponse> {
    this.assertKnown(name);
    return toResponse(name, await this.gateway.getState(name));
  }

  async setState(name: string, state: LightPower): Promise<LightResponse> {
    this.assertKnown(name);
    return toResponse(name, await this.gateway.setState(name, state));
  }

  private assertKnown(name: string): void {
    if (!this.lights.includes(name)) {
      throw new LightNotFoundError(name);
    }
  }
}

function toResponse(name: string, s: LightState): LightResponse {
  const response: LightResponse = { name, state: s.state, updatedAt: s.receivedAt.toISOString() };
  if (s.brightness !== undefined) response.brightness = s.brightness;
  return response;
}
