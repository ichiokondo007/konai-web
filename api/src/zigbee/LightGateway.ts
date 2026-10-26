export type LightPower = "ON" | "OFF";

export interface LightState {
  state: LightPower;
  brightness?: number;
  receivedAt: Date;
}

export interface LightGateway {
  setState(name: string, state: LightPower): Promise<LightState>;
  getState(name: string): Promise<LightState>;
  isConnected(): boolean;
}
