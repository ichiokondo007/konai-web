export type LightPower = "ON" | "OFF";

export interface LightState {
  state: LightPower;
  brightness?: number;
  receivedAt: Date;
}

/** 電球への変更指示。少なくとも一方を指定する。brightness は Zigbee2MQTT の生値(0〜254) */
export interface LightCommand {
  state?: LightPower;
  brightness?: number;
}

export interface LightGateway {
  setState(name: string, command: LightCommand): Promise<LightState>;
  getState(name: string): Promise<LightState>;
  isConnected(): boolean;
}
