/**
 * docs/api/openapi.yaml(API の契約)と実装のズレを検出する契約テスト。
 * - 文書そのものが有効な OpenAPI 3.1 か
 * - 実装が持つルートと文書のパスが一致するか
 * - 実際のレスポンスが文書のスキーマに適合するか
 * - リクエストボディの受理 / 拒否が文書のスキーマと一致するか
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import AjvModule from "ajv/dist/2020.js";
import type { Ajv2020 as AjvInstance } from "ajv/dist/2020.js";
import addFormatsModule from "ajv-formats";

// ajv と ajv-formats は CommonJS なので、NodeNext の ESM からは default 経由で取り出す
const Ajv2020 = AjvModule.default;
const addFormats = addFormatsModule.default;
import { Validator } from "@seriousme/openapi-schema-validator";
import { createApp } from "../src/app.js";
import { LightService } from "../src/service/LightService.js";
import { DeviceTimeoutError, MqttUnavailableError } from "../src/errors.js";
import { StubGateway } from "./helpers/stubGateway.js";

const SPEC_PATH = fileURLToPath(new URL("../../docs/api/openapi.yaml", import.meta.url));

type Json = Record<string, unknown>;
interface Spec {
  openapi: string;
  paths: Record<string, Record<string, Json>>;
  components: { schemas: Record<string, Json> };
}

let spec: Spec;
let ajv: AjvInstance;

/** OpenAPI 内のスキーマ片を、`#/components/...` 参照を解決できる形にして検証関数にする */
function compile(schema: Json) {
  return ajv.compile({ ...schema, components: spec.components });
}

/** `{ $ref: "#/components/responses/X" }` のような文書内参照を 1 段たどる */
function deref(node: Json): Json {
  const ref = node.$ref;
  if (typeof ref !== "string") return node;
  if (!ref.startsWith("#/")) throw new Error(`only local refs are supported: ${ref}`);
  let cur: unknown = spec;
  for (const key of ref.slice(2).split("/")) cur = (cur as Record<string, unknown>)[key];
  if (cur === undefined) throw new Error(`unresolved ref: ${ref}`);
  return cur as Json;
}

function responseSchema(method: string, path: string, status: number): Json {
  const op = spec.paths[path]?.[method];
  if (!op) throw new Error(`spec has no operation ${method.toUpperCase()} ${path}`);
  const responses = op.responses as Record<string, Json>;
  const res = responses[String(status)];
  if (!res) throw new Error(`spec has no response ${status} for ${method.toUpperCase()} ${path}`);
  const content = deref(res).content as Record<string, Json>;
  return content["application/json"].schema as Json;
}

function expectMatchesSpec(method: string, path: string, status: number, body: unknown) {
  const validate = compile(responseSchema(method, path, status));
  const ok = validate(body);
  expect(validate.errors ?? [], `${method.toUpperCase()} ${path} ${status}: ${JSON.stringify(body)}`).toEqual([]);
  expect(ok).toBe(true);
}

beforeAll(() => {
  spec = parse(readFileSync(SPEC_PATH, "utf8")) as Spec;
  ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);
});

let gw: StubGateway;
let app: Express;

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  gw = new StubGateway();
  app = createApp({ service: new LightService(["living1", "desk"], gw), gateway: gw });
});

describe("openapi.yaml document", () => {
  it("is a valid OpenAPI 3.1 document", async () => {
    const result = await new Validator().validate(SPEC_PATH);
    expect(result.errors, JSON.stringify(result.errors, null, 2)).toBeUndefined();
    expect(result.valid).toBe(true);
    expect(spec.openapi).toMatch(/^3\.1\./);
  });

  it("documents exactly the routes the app serves", () => {
    const HTTP_METHODS = new Set(["get", "put", "post", "delete", "patch", "head", "options", "trace"]);
    const documented = Object.entries(spec.paths)
      .flatMap(([path, item]) =>
        Object.keys(item)
          .filter((key) => HTTP_METHODS.has(key)) // path item には parameters などメソッド以外のキーもある
          .map((m) => `${m.toUpperCase()} ${path}`),
      )
      .sort();
    expect(documented).toEqual(
      ["GET /health", "GET /lights", "GET /lights/{name}", "PUT /lights/{name}/state"].sort(),
    );
  });

  it("lists every error code the app can return", () => {
    const codes = (spec.components.schemas.ErrorCode as { enum: string[] }).enum.sort();
    expect(codes).toEqual(
      ["INVALID_REQUEST", "LIGHT_NOT_FOUND", "MQTT_UNAVAILABLE", "DEVICE_TIMEOUT", "NOT_FOUND", "INTERNAL_ERROR"].sort(),
    );
  });
});

describe("responses conform to openapi.yaml", () => {
  it("GET /lights 200", async () => {
    const r = await request(app).get("/lights");
    expect(r.status).toBe(200);
    expectMatchesSpec("get", "/lights", 200, r.body);
  });

  it("GET /lights/{name} 200 with brightness", async () => {
    const r = await request(app).get("/lights/living1");
    expect(r.status).toBe(200);
    expectMatchesSpec("get", "/lights/{name}", 200, r.body);
  });

  it("GET /lights/{name} 200 without brightness", async () => {
    gw.next = { state: "OFF", receivedAt: new Date("2026-10-26T12:00:00.000Z") };
    const r = await request(app).get("/lights/living1");
    expect(r.status).toBe(200);
    expectMatchesSpec("get", "/lights/{name}", 200, r.body);
  });

  it("GET /lights/{name} 404", async () => {
    const r = await request(app).get("/lights/living9");
    expect(r.status).toBe(404);
    expectMatchesSpec("get", "/lights/{name}", 404, r.body);
  });

  it("PUT /lights/{name}/state 200", async () => {
    const r = await request(app).put("/lights/desk/state").send({ state: "ON", brightness: 100 });
    expect(r.status).toBe(200);
    expectMatchesSpec("put", "/lights/{name}/state", 200, r.body);
  });

  it("PUT /lights/{name}/state 400", async () => {
    const r = await request(app).put("/lights/living1/state").send({ brightness: 300 });
    expect(r.status).toBe(400);
    expectMatchesSpec("put", "/lights/{name}/state", 400, r.body);
  });

  it("PUT /lights/{name}/state 404", async () => {
    const r = await request(app).put("/lights/living9/state").send({ state: "ON" });
    expect(r.status).toBe(404);
    expectMatchesSpec("put", "/lights/{name}/state", 404, r.body);
  });

  it("PUT /lights/{name}/state 503", async () => {
    gw.failWith = new MqttUnavailableError();
    const r = await request(app).put("/lights/living1/state").send({ state: "ON" });
    expect(r.status).toBe(503);
    expectMatchesSpec("put", "/lights/{name}/state", 503, r.body);
  });

  it("PUT /lights/{name}/state 504", async () => {
    gw.failWith = new DeviceTimeoutError("living1", 5000);
    const r = await request(app).put("/lights/living1/state").send({ state: "ON" });
    expect(r.status).toBe(504);
    expectMatchesSpec("put", "/lights/{name}/state", 504, r.body);
  });

  it("GET /health 200", async () => {
    const r = await request(app).get("/health");
    expect(r.status).toBe(200);
    expectMatchesSpec("get", "/health", 200, r.body);
  });

  it("GET /health 503", async () => {
    gw.connected = false;
    const r = await request(app).get("/health");
    expect(r.status).toBe(503);
    expectMatchesSpec("get", "/health", 503, r.body);
  });
});

describe("LightCommand request schema agrees with the implementation", () => {
  const bodies: unknown[] = [
    { state: "ON" },
    { state: "OFF" },
    { brightness: 0 },
    { brightness: 254 },
    { state: "ON", brightness: 100 },
    { state: "ON", extra: true },
    {},
    { state: "on" },
    { state: "TOGGLE" },
    { state: 1 },
    { brightness: 255 },
    { brightness: -1 },
    { brightness: 1.5 },
    { brightness: "100" },
    { brightness: null },
    { state: "ON", brightness: 300 },
    { state: "on", brightness: 100 },
    [],
  ];

  for (const body of bodies) {
    it(`body ${JSON.stringify(body)}`, async () => {
      const validate = compile({ $ref: "#/components/schemas/LightCommand" });
      const r = await request(app).put("/lights/living1/state").send(body as object);
      expect(validate(body), `spec and implementation disagree for ${JSON.stringify(body)}`).toBe(r.status === 200);
    });
  }
});
