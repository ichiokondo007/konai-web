# 電球操作 API(Express + TypeScript)設計

作成日: 2026-10-26
対応する概要書の項目: 次のアクション 2「API の仕様を決める」、3「Express サーバの雛形を Docker で立て、MQTT 経由でオンオフが通るところまで作る」
前提となる設計書: `2026-10-18-zigbee-infra-design.md`(Zigbee2MQTT + Mosquitto は side3 で稼働中)

## 1. 目的

side3(Raspberry Pi 5)上の HTTP API に curl でリクエストを送ると、Philips Hue 電球が実際にオン / オフになり、現在状態を取得できるようにする。
将来のローカル LLM / Raspberry Pi Pico コントローラーも同じ API をクライアントとして使う。

## 2. スコープ

### やること

- 電球のオン / オフ(`PUT /lights/:name/state`)
- 電球の現在状態の取得(`GET /lights/:name`)
- 登録済み電球名の一覧(`GET /lights`)
- 生存確認(`GET /health`)
- Express サーバを compose に `api` サービスとして追加し、side3 で稼働させる
- 自動テスト(ユニット、ゲートウェイ統合)

### やらないこと(次のイテレーション以降)

- 明るさの変更(レスポンスには Zigbee2MQTT が返す `brightness` をそのまま載せるが、変更は受け付けない)
- `TOGGLE`
- ペアリング(permit join)の API 化
- 調色、認証、Web UI(概要書 項目 5)
- Zigbee2MQTT / Mosquitto を含む E2E の自動テスト

## 3. 決定事項

| 項目 | 決定 | 理由 |
|---|---|---|
| 言語 | TypeScript(`strict: true`、ESM) | 本設計での決定。概要書は Node.js / Express とだけ記載 |
| パス設計 | `/lights/:name` 形式。`:name` は Zigbee2MQTT の friendly name と同一 | MQTT トピックが `zigbee2mqtt/<friendly name>/...` と名前ベースなので、そのまま写せる。電球を増やしても API の形が変わらない |
| 電球名 | `living1`。将来 `living2` を追加 | 利用者の決定 |
| 名前の対応 | API 側に対応表は持たず、環境変数 `LIGHTS` に存在する電球名の一覧だけを持つ。一覧にない名前は 404 | 名前が 2 系統あるとデバッグ時に混乱する。Zigbee2MQTT 側の friendly name を `hue-bulb-1` → `living1` に変更する |
| 操作の応答 | 同期。`set` 発行後に `zigbee2mqtt/<name>` の応答を待ち、反映後の実際の状態を 200 で返す。応答がなければ 504 | curl を叩いた時点で結果が分かる。電球の電源断に気づける。GET も同じ待ち受け部品で実装できる |
| 内部構成 | HTTP 層 / サービス層 / ゲートウェイ層の 3 層。ゲートウェイはインターフェースで切る | 難所である MQTT の要求応答を 1 ファイルに閉じ、層ごとに独立してテストする |
| HTTP フレームワーク | Express 5 | 概要書どおり。5 系は async ハンドラの例外を自動でエラーハンドラに渡す |
| MQTT クライアント | mqtt.js(`mqtt`) | 標準的。自動再接続あり |
| 入力検証 | 手書き | 検証対象が `state` 1 項目のみ。明るさ追加時に見直す |
| ログ | `console.log` / `console.error` のみ | 最小構成の方針に合わせる |

## 4. API 仕様

ベース URL: `http://side3:3000`。JSON のみ。認証なし。

### 4.1 エンドポイント

| メソッド | パス | 役割 |
|---|---|---|
| `GET` | `/lights` | 登録済みの電球名一覧を返す |
| `GET` | `/lights/:name` | 電球に `get` を発行し、現在状態を返す |
| `PUT` | `/lights/:name/state` | 電球のオン / オフと明るさを変え、反映後の状態を返す |
| `GET` | `/health` | API の生存確認。MQTT 接続状態を含む |

### 4.2 リクエスト / レスポンス

```
GET /lights
200 {"lights":["living1"]}

GET /lights/living1
200 {"name":"living1","state":"ON","brightness":254,"updatedAt":"2026-10-26T12:00:00.000Z"}

PUT /lights/living1/state
body {"state":"ON"}                    ← "ON" | "OFF"
body {"brightness":100}                ← 0〜254 の整数(2026-10-31 追加)
body {"state":"ON","brightness":100}   ← 併用可。state と brightness の少なくとも一方が必要
200 {"name":"living1","state":"ON","brightness":254,"updatedAt":"2026-10-26T12:00:00.000Z"}

GET /health
200 {"status":"ok","mqtt":"connected"}
503 {"status":"degraded","mqtt":"disconnected"}
```

- `brightness` は Zigbee2MQTT が返す値(0〜254)をそのまま載せる。応答に含まれない場合は省略する
- リクエストの `brightness` も変換せずそのまま Zigbee2MQTT の `set` に渡す。`state` だけのリクエストは従来どおりで、電球が記憶している明るさで点灯する。`state` と `brightness` 以外のフィールドは無視する
- `updatedAt` は API が Zigbee2MQTT の応答を受け取った時刻(ISO 8601)

### 4.3 エラー応答

全エンドポイント共通の形:

```
{"error":{"code":"LIGHT_NOT_FOUND","message":"unknown light: living9"}}
```

| 状況 | ステータス | code |
|---|---|---|
| 一覧にない電球名 | 404 | `LIGHT_NOT_FOUND` |
| body が不正(`state` が ON / OFF 以外、`brightness` が 0〜254 の整数以外、JSON でない、`state` と `brightness` の両方がない) | 400 | `INVALID_REQUEST` |
| MQTT ブローカーに未接続 | 503 | `MQTT_UNAVAILABLE` |
| 電球からの応答がタイムアウト | 504 | `DEVICE_TIMEOUT` |
| その他 | 500 | `INTERNAL_ERROR` |

## 5. 内部構成

### 5.1 ディレクトリ構成

```
konai-web/
├── compose.yaml                 # api サービスを追加
├── api/
│   ├── Dockerfile
│   ├── package.json
│   ├── tsconfig.json
│   ├── src/
│   │   ├── index.ts             # 起動: 設定読込 → ゲートウェイ接続 → Express listen → 終了処理
│   │   ├── config.ts            # 環境変数の読込と検証
│   │   ├── app.ts               # Express アプリ組み立て(ルーター登録、エラーハンドラ)
│   │   ├── errors.ts            # 例外クラス定義
│   │   ├── http/
│   │   │   ├── lightsRouter.ts  # /lights 系。入力検証と HTTP 変換のみ
│   │   │   └── healthRouter.ts
│   │   ├── service/
│   │   │   └── LightService.ts  # 名前チェック、ゲートウェイ呼び出し、レスポンス整形
│   │   └── zigbee/
│   │       ├── LightGateway.ts        # インターフェース定義(型のみ)
│   │       └── Zigbee2MqttGateway.ts  # mqtt.js 実装。要求応答、タイムアウト、再接続
│   └── test/
└── docs/superpowers/specs/2026-10-26-light-api-design.md
```

### 5.2 各層の責務と依存

- `http/`: Express に依存。body の形を検査し、サービスを呼び、例外を HTTP ステータスに変換する。MQTT を知らない
- `service/LightService`: 電球名の一覧を持ち、知らない名前は `LightNotFoundError` を投げる。`LightGateway` インターフェースにだけ依存する
- `zigbee/Zigbee2MqttGateway`: mqtt.js に依存。`LightGateway` を実装する唯一の場所。トピック名の組み立て(`zigbee2mqtt/<name>/set` など)もここに閉じる

### 5.3 `LightGateway` インターフェース

```ts
type LightPower = "ON" | "OFF";

interface LightState {
  state: LightPower;
  brightness?: number;
  receivedAt: Date;
}

/** 変更指示。少なくとも一方を指定する(2026-10-31 に brightness を追加) */
interface LightCommand {
  state?: LightPower;
  brightness?: number; // 0〜254
}

interface LightGateway {
  setState(name: string, command: LightCommand): Promise<LightState>;
  getState(name: string): Promise<LightState>;
  isConnected(): boolean;
}
```

### 5.4 要求応答の流れ(`PUT /lights/living1/state` の場合)

1. ルーターが body を検証し、`LightService.setState("living1", { state: "ON" })` を呼ぶ(`brightness` があればそれも `LightCommand` に載せる)
2. サービスが名前を一覧と照合し、`gateway.setState` を呼ぶ
3. ゲートウェイは接続時に `zigbee2mqtt/+` を一度購読している。`setState` では `zigbee2mqtt/living1` 宛ての **次の 1 メッセージ**を待つ Promise を先に作り、その後 `zigbee2mqtt/living1/set` に `LightCommand` をそのまま JSON にして(例 `{"state":"ON"}`、`{"brightness":100}`)発行する(待ち受けを先に作るのは応答の取りこぼしを防ぐため)
4. Zigbee2MQTT が電球に反映し、`zigbee2mqtt/living1` に `{"state":"ON","brightness":254,...}` を流す
5. ゲートウェイが受信して Promise を解決。JSON のうち `state` と `brightness` だけを取り出して返す
6. サービスが `name` と `updatedAt` を付けてルーターに返し、200 で応答する

`getState` は手順 3 の発行先が `zigbee2mqtt/living1/get`、body が `{"state":""}` になるだけで、残りは同じ。

### 5.5 同時リクエストの扱い

同じ電球に対して複数の要求が同時に来た場合、各要求は「次の 1 メッセージ」を待つので、1 つの応答で複数の Promise が同時に解決されることがある。Zigbee2MQTT の応答には電球の最新状態がすべて入っているため、どの要求も正しい状態を受け取れる。Zigbee2MQTT の応答に要求 ID はないため、要求ごとの対応付けはしない。

### 5.6 購読トピックが `zigbee2mqtt/+` である理由

電球を増やしたときに再購読が不要。`zigbee2mqtt/bridge/...` 系は `+` に `/` が含まれないため自然に除外される。

## 6. エラー処理と接続管理

### 6.1 MQTT 接続

- 起動時に mqtt.js で `MQTT_URL` に接続。mqtt.js の自動再接続(既定 1 秒間隔)をそのまま使う
- 接続を待たずに Express を listen する。未接続の間は `/health` が 503、操作系は `MQTT_UNAVAILABLE`(503)を返す。compose の `depends_on` が準備完了を待たない問題はこれで吸収する
- `zigbee2mqtt/+` の購読は `connect` イベントごとに実行する(再接続後も購読が復活するように)

### 6.2 タイムアウト

- 応答待ちは `DEVICE_TIMEOUT_MS`(既定 5000ms)。超えたら `DeviceTimeoutError` → 504
- 待ち受け中の Promise は必ず解決か却下で終わらせ、タイマーとリスナーを解除する

### 6.3 例外から HTTP への変換(`app.ts` のエラーハンドラ 1 箇所に集約)

| 例外クラス | 発生場所 | HTTP |
|---|---|---|
| `InvalidRequestError` | ルーターの入力検証 | 400 |
| `LightNotFoundError` | サービス | 404 |
| `MqttUnavailableError` | ゲートウェイ(未接続時に即時) | 503 |
| `DeviceTimeoutError` | ゲートウェイ | 504 |
| その他 | どこでも | 500。ログにスタックを出し、レスポンスには出さない |

### 6.4 壊れた応答

Zigbee2MQTT からのメッセージが JSON でない、または `state` が `ON` / `OFF` でない場合、その電球宛ての応答としては扱わず、待ち続けてタイムアウトに任せる。ログに warn を 1 行出す。

### 6.5 終了処理

SIGTERM / SIGINT で HTTP サーバーを閉じ、MQTT を `end()` してから終了する。`docker compose stop` で素直に止まるようにするため。

### 6.6 ログ

構造化ログライブラリは入れない。起動、接続・切断、要求ごとの 1 行(メソッド、パス、ステータス、所要 ms)、warn / error のみ。

## 7. 設定と実行環境

### 7.1 環境変数(`config.ts` で起動時に検証。不正なら起動失敗)

| 変数 | 既定 | 意味 |
|---|---|---|
| `PORT` | `3000` | HTTP ポート |
| `MQTT_URL` | (必須) | 例 `mqtt://mosquitto:1883`(compose 内)、`mqtt://10.20.10.5:1883`(開発機から。`side3` は ssh の alias で DNS では解決できないため IP を使う) |
| `MQTT_BASE_TOPIC` | `zigbee2mqtt` | Zigbee2MQTT のベーストピック |
| `LIGHTS` | (必須) | カンマ区切りの電球名。`living1`、将来 `living1,living2`。空要素は不正 |
| `DEVICE_TIMEOUT_MS` | `5000` | 応答待ちの上限 |

### 7.2 ツール選定

| 区分 | 選定 |
|---|---|
| ランタイム | Node.js 22(LTS)。compose のイメージは `node:22-slim` |
| 言語 | TypeScript、`strict: true`、ESM |
| HTTP | Express 5 |
| MQTT | mqtt.js(`mqtt`) |
| 開発実行 | `tsx`(`npm run dev` で `src/index.ts` を直接起動) |
| テスト | Vitest、supertest(HTTP)、aedes(テスト内 MQTT ブローカー) |

### 7.3 compose.yaml への追加

```yaml
  api:
    build: ./api
    restart: unless-stopped
    logging: *default-logging
    depends_on:
      - mosquitto
    ports:
      - "3000:3000"
    environment:
      MQTT_URL: mqtt://mosquitto:1883
      LIGHTS: living1
```

### 7.4 Dockerfile

2 段ビルド。1 段目で `npm ci` と `tsc`、2 段目は `node:22-slim` に `dist/` と本番依存だけをコピーして `node dist/index.js` で起動する。

### 7.5 開発の流れ

1. 開発機で `cd api && MQTT_URL=mqtt://10.20.10.5:1883 LIGHTS=living1 npm run dev`。side3 の Mosquitto は LAN に 1883 を公開済みなので、デプロイ前に開発機から実機の電球を操作できる(`side3` というホスト名は ssh の alias なので、Node からは IP で指定する)
2. `npm test` で自動テスト
3. main にマージ後、`ssh side3 'cd ~/konai-web && git pull && docker compose up -d --build'`

### 7.6 事前作業(side3 の Zigbee2MQTT)

- 電球の friendly name を `hue-bulb-1` から `living1` に変更する。フロントエンドからでもよいが、実施時は Zigbee2MQTT の bridge API を MQTT 経由で使った(再現可能なため):

  ```bash
  ssh side3 'cd ~/konai-web && docker compose exec -T mosquitto mosquitto_pub -h localhost \
    -t zigbee2mqtt/bridge/request/device/rename \
    -m "{\"from\":\"hue-bulb-1\",\"to\":\"living1\"}"'
  # 応答は zigbee2mqtt/bridge/response/device/rename に {"status":"ok",...} で届く
  ```

- `2026-10-18-zigbee-infra-design.md` の「再開時の確認手順」などに書かれたトピック名を `living1` に更新する

## 8. テスト方針

TDD で進める。1 と 2 は自動、3 は手動。

### 8.1 ユニットテスト(Vitest)

- `config.ts`: 必須変数の欠落で失敗する、`LIGHTS` のカンマ区切りが配列になる、既定値が入る
- `LightService`: 一覧にない名前で `LightNotFoundError`、一覧にある名前でゲートウェイが正しい引数で呼ばれる、`name` と `updatedAt` が付く。ゲートウェイは手書きのスタブ
- `http/`(supertest): スタブのゲートウェイを差した `app` に対して、各エンドポイントのステータスと JSON の形、body 不正(`state` 不正、`brightness` の範囲外・小数・文字列、両方なし)で 400、`brightness` のみ / `state` との併用がそのままゲートウェイに渡ること、例外クラスごとの HTTP 変換(404 / 503 / 504 / 500)、500 のときレスポンスにスタックが出ないこと

### 8.2 ゲートウェイの統合テスト(Vitest + aedes)

テスト内で aedes をランダムポートで起動し、本物の mqtt.js で `Zigbee2MqttGateway` を接続する。テスト側は Zigbee2MQTT のふりをするクライアントとして同じブローカーに繋ぐ。

- `setState` が `zigbee2mqtt/living1/set` に `{"state":"ON"}` を発行し、テスト側が `zigbee2mqtt/living1` に状態を返すと Promise がその値で解決する
- `setState` に `{ state, brightness }` や `{ brightness }` を渡すと、その JSON がそのまま `set` に発行される
- `getState` が `zigbee2mqtt/living1/get` に `{"state":""}` を発行する
- 応答がなければ `DEVICE_TIMEOUT_MS` 後に `DeviceTimeoutError`(テストでは 200ms 程度に設定)
- 壊れた JSON や `state` のない応答は無視され、その後の正しい応答で解決する
- 未接続時に `MqttUnavailableError` が即時に返る
- ブローカーを止めて再起動すると再接続し、購読が復活して再び応答を受け取れる
- 解決後にリスナーとタイマーが残らない

### 8.3 実機確認(手動、side3)

開発機で `side3` が DNS 解決できない場合は `10.20.10.5` に置き換える。

```bash
curl -s http://side3:3000/health
curl -s http://side3:3000/lights
curl -s -X PUT http://side3:3000/lights/living1/state -H 'content-type: application/json' -d '{"state":"ON"}'
curl -s -X PUT http://side3:3000/lights/living1/state -H 'content-type: application/json' -d '{"brightness":50}'       # 暗くなる
curl -s -X PUT http://side3:3000/lights/living1/state -H 'content-type: application/json' -d '{"state":"ON","brightness":254}'
curl -s -X PUT http://side3:3000/lights/living1/state -H 'content-type: application/json' -d '{"brightness":300}'      # 400 を確認
curl -s -X PUT http://side3:3000/lights/living1/state -H 'content-type: application/json' -d '{"state":"OFF"}'
curl -s http://side3:3000/lights/living1
curl -s http://side3:3000/lights/living9        # 404 を確認
```

## 9. 完了条件

1. `npm test` が開発機で全件成功する
2. side3 で `docker compose ps` に `api` が running として現れる
3. 8.3 の curl で電球が実際に点いて消え、GET が直前の操作と一致する
4. 存在しない電球名で 404 が返る
5. `docker compose stop api` が数秒以内に止まる

## 10. 将来の拡張(設計上の見通しのみ。今回は実装しない)

- `living2` の追加: compose の `LIGHTS` に追記し、Zigbee2MQTT でペアリングと friendly name 設定をする。コード変更なし
- [完了 2026-10-31] 明るさ変更: `PUT /lights/:name/state` の body に `brightness`(0〜254)を追加。`LightGateway.setState` の引数を `LightCommand = { state?, brightness? }` に広げた。入力検証ライブラリは入れず、手書きの検証(`isBrightness`)で足りた。結果は 12 章

## 11. 稼働確認の結果(2026-10-26)

完了条件 9 章の 5 項目はすべて満たした。side3 で `api` コンテナが稼働中。

| 完了条件 | 結果 |
|---|---|
| 1. `npm test` 全件成功 | 43 件 PASS(5 ファイル)、`tsc --noEmit` エラーなし |
| 2. side3 で `api` が running | `docker compose up -d --build` 後に running。ログに `listening on 3000`、`mqtt connected: mqtt://mosquitto:1883` |
| 3. curl で電球が点いて消え、GET が一致 | `PUT ON` 200(94ms)→ 電球点灯、`PUT OFF` 200(33ms)→ 消灯、`GET` が `OFF`。応答に `brightness: 254` を含む |
| 4. 存在しない電球名で 404 | `GET /lights/living9` → 404 `LIGHT_NOT_FOUND`。未知のパス(`DELETE /lights/living1`)も JSON の 404 `NOT_FOUND`、`{"state":"on"}` は 400 `INVALID_REQUEST` |
| 5. `docker compose stop api` が数秒以内 | 254ms。ログに `shutdown complete` |

### 実装中に判明した事項

- **再接続直後の応答取りこぼし**: mqtt.js は既定で再接続時に内部で再購読(`resubscribe`)するため、こちらが `connect` イベントで呼ぶ `subscribe()` は SUBACK を待たずにコールバックされる。その数 ms の間に届いた応答は捨てられ 504 になる(テスト用ブローカーで再現)。対策として `resubscribe: false` にして購読を自前で行い、`isConnected()` は購読完了(SUBACK 受信)後に true とした。6.1 の「`connect` イベントごとに購読」はこの前提で成立している
- **終了処理の順序**: `server.close()` の完了を待ってから `gateway.close()` を呼ぶと、電球応答を待つリクエストがタイムアウト(5 秒)まで終了を遅らせる。先にゲートウェイを閉じて待ち受けを即時却下し(進行中のリクエストは 503 で返る)、その後サーバーの close 完了を待つ順序にした(`api/src/shutdown.ts`)。実機で「応答待ち中に SIGTERM → 即時 503 → 正常終了」を確認
- **ホスト名**: `side3` は開発機の ssh alias(10.20.10.5)で DNS では解決できない。Node から接続する際は IP を使う(7.1、7.5 に反映)
- **friendly name の変更**は Zigbee2MQTT の bridge API(`zigbee2mqtt/bridge/request/device/rename`)で実施した(7.6 に手順を記載)

### 未対応事項(レビューで指摘、今回は見送り)

| 事項 | 影響 | 対応の目安 |
|---|---|---|
| 待ち受け中にブローカー接続が切れても waiter を却下せず、5 秒後に 504 `DEVICE_TIMEOUT` になる | 原因がブローカー側なのに電球の不調に見える | `close` イベントで全 waiter を `MqttUnavailableError` で却下すれば即時 503 |
| 待ち受けのない電球のメッセージにも「malformed」の warn を出す | 将来センサー類を追加するとログが増える | waiter がある名前のときだけ warn |
| body パーサーの JSON 構文エラー以外(サイズ超過、charset 不正)が 500 になる | クライアント起因なのに error ログが出る | body-parser の `status` が 4xx なら 400 に寄せる |
| `LIGHTS` の名前に `/` `+` `#` や重複を許す | 設定ミスが常に 504 として現れる | 起動時に検証して失敗させる |
| publish 失敗時に同名の全 waiter を却下する | 並行リクエストの一方だけ失敗しても両方 503 | 当該 waiter のみ却下 |
| `server.on("error")` がなく、`EADDRINUSE` 時にスタックトレースで終了 | ログが読みにくい | 1 行メッセージ + exit 1 |
| `MQTT_BASE_TOPIC` を変えたケースのテストがない | 既定値以外での動作が未検証 | `baseTopic: "z2m"` で 1 ケース追加 |

### 再開時の確認手順

```bash
ssh side3 'cd ~/konai-web && git pull && docker compose up -d --build && docker compose ps'
curl -s http://10.20.10.5:3000/health
curl -s -X PUT http://10.20.10.5:3000/lights/living1/state -H 'content-type: application/json' -d '{"state":"ON"}'
```
