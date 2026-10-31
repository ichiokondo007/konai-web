/**
 * docs/api/openapi.yaml(API の契約)と実装のズレを検出する契約テスト。
 * - 文書そのものが有効な OpenAPI 3.1 か
 * - 実装が持つルート(Express のルーター層から取り出す)と文書のパスが一致するか
 * - 実装が返し得るエラーコード(errors.ts + 観測)と文書の enum が一致するか
 * - 実際のレスポンスが文書のスキーマに適合するか
 * - リクエストボディの受理 / 拒否が文書のスキーマと一致するか
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormatsModule from "ajv-formats";
import { Validator } from "@seriousme/openapi-schema-validator";
import { createApp } from "../src/app.js";
import { LightService } from "../src/service/LightService.js";
import * as errors from "../src/errors.js";
import { DeviceTimeoutError, MqttUnavailableError } from "../src/errors.js";
import { StubGateway } from "./helpers/stubGateway.js";

// ajv-formats は CommonJS で default export のみなので、NodeNext の ESM からは .default で取り出す
const addFormats = addFormatsModule.default;

const SPEC_PATH = fileURLToPath(new URL("../../docs/api/openapi.yaml", import.meta.url));
const HTTP_METHODS = new Set(["get", "put", "post", "delete", "patch", "head", "options", "trace"]);

type Json = Record<string, unknown>;
interface Spec {
  openapi: string;
  paths: Record<string, Record<string, Json>>;
  components: { schemas: Record<string, Json> };
}

let spec: Spec;
let ajv: Ajv2020;

/** OpenAPI 内のスキーマ片を、`#/components/...` 参照を解決できる形にして検証関数にする */
function compile(schema: Json) {
  return ajv.compile({ ...schema, components: spec.components });
}

/** `{ $ref: "#/components/responses/X" }` のような文書内参照を 1 段たどる(この文書では多段参照を使わない) */
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

/** 文書のルートを "GET /lights/{name}" の形で列挙する */
function documentedRoutes(): string[] {
  return Object.entries(spec.paths)
    .flatMap(([path, item]) =>
      Object.keys(item)
        .filter((key) => HTTP_METHODS.has(key)) // path item には parameters などメソッド以外のキーもある
        .map((m) => `${m.toUpperCase()} ${path}`),
    )
    .sort();
}

// Express 5(router 2.x)の内部構造。公開 API ではないので最小限の形だけ宣言する
interface RouteLayer {
  route?: { path: string; methods: Record<string, boolean> };
  handle?: { stack?: RouteLayer[] };
  matchers?: Array<(path: string) => { path: string } | false>;
}

/**
 * 実装が持つルートを "GET /lights/{name}" の形で列挙する。
 * `app.use(prefix, router)` のマウント位置は matcher の中にしか残らないため、
 * 文書に出てくる先頭セグメントを候補にして照合する。候補のどれにも一致しないマウントは「文書にないルーター」として失敗させる。
 */
function servedRoutes(app: Express): string[] {
  const candidates = [...new Set(Object.keys(spec.paths).map((p) => "/" + p.split("/")[1]))];
  const toDoc = (expressPath: string) => expressPath.replace(/:([A-Za-z0-9_]+)/g, "{$1}").replace(/\/$/, "");
  const routes: string[] = [];

  const collect = (layers: RouteLayer[], prefix: string) => {
    for (const layer of layers) {
      if (layer.route) {
        for (const method of Object.keys(layer.route.methods)) {
          routes.push(`${method.toUpperCase()} ${toDoc(prefix + layer.route.path) || "/"}`);
        }
      } else if (layer.handle?.stack) {
        const mount = candidates.find((c) => layer.matchers?.some((m) => m(c) !== false));
        if (mount === undefined) throw new Error("a router is mounted at a path that openapi.yaml does not document");
        collect(layer.handle.stack, prefix + mount);
      }
    }
  };
  collect((app as unknown as { router: { stack: RouteLayer[] } }).router.stack, "");
  return routes.sort();
}

beforeAll(() => {
  spec = parse(readFileSync(SPEC_PATH, "utf8")) as Spec;
  ajv = new Ajv2020({ allErrors: true });
  ajv.addKeyword("components"); // compile() が参照解決のために root に埋め込む。strict モードは残す
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
    expect(servedRoutes(app)).toEqual(
      ["GET /health", "GET /lights", "GET /lights/{name}", "PUT /lights/{name}/state"].sort(),
    );
    expect(documentedRoutes()).toEqual(servedRoutes(app));
  });

  it("every documented route is actually served (not the catch-all 404)", async () => {
    for (const route of documentedRoutes()) {
      const [method, path] = route.split(" ");
      const url = path.replace("{name}", "living1");
      const r = await request(app)[method.toLowerCase() as "get" | "put"](url).send({ state: "ON" });
      expect(r.body?.error?.code, route).not.toBe("NOT_FOUND");
    }
  });

  it("lists every error code the app can return", async () => {
    // errors.ts が export する全クラスの code(引数は余分でも無害)
    const fromClasses = Object.values(errors).map(
      (Cls) => new (Cls as unknown as new (...args: unknown[]) => { code: string })("x", 1).code,
    );
    // app.ts に直書きされている 2 つは、実際に起こして観測する
    const notFound = await request(app).get("/no-such-path");
    gw.failWith = new Error("boom");
    const internal = await request(app).get("/lights/living1");
    const observed = [notFound.body.error.code, internal.body.error.code];

    const documented = (spec.components.schemas.ErrorCode as { enum: string[] }).enum;
    expect([...documented].sort()).toEqual([...new Set([...fromClasses, ...observed])].sort());
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

  it("GET /lights/{name} 500", async () => {
    gw.failWith = new Error("boom");
    const r = await request(app).get("/lights/living1");
    expect(r.status).toBe(500);
    expectMatchesSpec("get", "/lights/{name}", 500, r.body);
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
