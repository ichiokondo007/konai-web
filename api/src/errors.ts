export class InvalidRequestError extends Error {
  readonly code = "INVALID_REQUEST";
  constructor(message: string) {
    super(message);
    this.name = "InvalidRequestError";
  }
}

export class LightNotFoundError extends Error {
  readonly code = "LIGHT_NOT_FOUND";
  constructor(name: string) {
    super(`unknown light: ${name}`);
    this.name = "LightNotFoundError";
  }
}

export class MqttUnavailableError extends Error {
  readonly code = "MQTT_UNAVAILABLE";
  constructor() {
    super("mqtt broker is not connected");
    this.name = "MqttUnavailableError";
  }
}

export class DeviceTimeoutError extends Error {
  readonly code = "DEVICE_TIMEOUT";
  constructor(name: string, timeoutMs: number) {
    super(`no response from ${name} within ${timeoutMs}ms`);
    this.name = "DeviceTimeoutError";
  }
}
