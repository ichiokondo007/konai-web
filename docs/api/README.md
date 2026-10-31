# konai-web Light API リファレンス

Raspberry Pi 上の API サーバに HTTP で指示を送り、Philips Hue 電球を操作する。このディレクトリが API の「契約」と「使い方」の置き場所。

| ファイル | 役割 | 読者 |
|---|---|---|
| [`openapi.yaml`](./openapi.yaml) | 契約(機械可読)。エンドポイント、スキーマ、エラーコードの正式な定義 | クライアント生成ツール、契約テスト、人 |
| この `README.md` | 使い方。実機で確認した挙動、クライアント実装の注意、curl 例 | クライアントを作る人 |

実装と `openapi.yaml` のズレは `api/test/openapi.test.ts` の契約テストで検出する(`npm test`)。API を変えるときは **先に `openapi.yaml` を更新し、契約テストが通る状態で実装を変える**。

設計の経緯や内部構成(MQTT との対応、タイムアウトの実装など)は [`docs/superpowers/specs/2026-10-26-light-api-design.md`](../superpowers/specs/2026-10-26-light-api-design.md) を参照。

## 1. 概要

| 項目 | 値 |
|---|---|
| ベース URL | `http://10.20.10.5:3000`(自宅 LAN の Raspberry Pi 5、ホスト名 side3) |
| 形式 | JSON のみ。リクエストには `Content-Type: application/json` を付ける |
| 認証 | なし。ローカルネットワーク内でのみ提供し、外部公開しない |
| バージョン | `openapi.yaml` の `info.version`(現在 1.1.0)。互換性を壊す変更ではメジャーを上げ、`/v2` のようなパス接頭辞の導入を検討する |
| 電球名 | `GET /lights` が返す名前(現在 `living1`、`desk`)。API の環境変数 `LIGHTS` で登録する |

## 2. エンドポイント一覧

| メソッド | パス | 役割 | 電球と通信するか |
|---|---|---|---|
| `GET` | `/lights` | 登録済みの電球名一覧 | しない |
| `GET` | `/lights/{name}` | 電球の現在状態(電球に問い合わせる) | する |
| `PUT` | `/lights/{name}/state` | オン / オフと明るさを変更し、反映後の状態を返す | する |
| `GET` | `/health` | API の生存確認と MQTT 接続状態 | しない |

「電球と通信する」エンドポイントは Zigbee を往復するため 50ms 前後かかり、電球が応答しなければ 504 になる。

## 3. 各エンドポイント

### 3.1 `GET /lights` 電球名一覧

```bash
curl -s http://10.20.10.5:3000/lights
```

```json
{"lights":["living1","desk"]}
```

電球名を固定で埋め込まず、起動時にこの一覧を取ってから操作対象を選ぶのが安全。

### 3.2 `GET /lights/{name}` 現在状態

```bash
curl -s http://10.20.10.5:3000/lights/living1
```

```json
{"name":"living1","state":"ON","brightness":254,"updatedAt":"2026-10-31T12:00:00.000Z"}
```

| フィールド | 型 | 説明 |
|---|---|---|
| `name` | string | 電球名 |
| `state` | `"ON"` / `"OFF"` | 電源状態 |
| `brightness` | integer 0〜254 | 明るさ。電球の応答に含まれなければ省略される。**省略を前提に実装する** |
| `updatedAt` | string(ISO 8601、UTC) | API が電球の応答を受け取った時刻 |

### 3.3 `PUT /lights/{name}/state` 変更

body は `state` と `brightness` のどちらか、または両方。それ以外のフィールドは無視される。

```bash
# 点灯(電球が記憶している明るさ)
curl -s -X PUT http://10.20.10.5:3000/lights/living1/state \
  -H 'Content-Type: application/json' -d '{"state":"ON"}'

# 消灯
curl -s -X PUT http://10.20.10.5:3000/lights/living1/state \
  -H 'Content-Type: application/json' -d '{"state":"OFF"}'

# 明るさだけ変える(消灯中なら点く)
curl -s -X PUT http://10.20.10.5:3000/lights/desk/state \
  -H 'Content-Type: application/json' -d '{"brightness":100}'

# 点灯と明るさを同時に
curl -s -X PUT http://10.20.10.5:3000/lights/desk/state \
  -H 'Content-Type: application/json' -d '{"state":"ON","brightness":100}'
```

応答は `GET /lights/{name}` と同じ形で、変更後の状態が入る。

#### 明るさの単位

`brightness` は Zigbee2MQTT の生値 **0〜254** で、API は変換しない。255 は Zigbee の予約値のため 400 になる。パーセントで扱いたいクライアントは自分で変換する。

```
percent  = round(brightness / 254 * 100)
brightness = round(percent / 100 * 254)
```

#### 実機で確認した挙動(2026-10-31、Hue White 電球)

電球(Zigbee2MQTT)側の仕様による挙動。API では変えていないので、クライアントが前提にしてよい。

| 送った body | 結果 | 注意 |
|---|---|---|
| `{"state":"ON"}` | 記憶している明るさで点灯 | 直前に設定した `brightness` が復元される |
| `{"brightness":100}`(消灯中) | **点灯して** 100 になる | 消灯したまま明るさだけ変えることはできない |
| `{"state":"OFF","brightness":10}` | 消灯。`brightness` は無視され記憶値も変わらない | 「次に点けたときの明るさ」の予約には使えない |
| `{"brightness":0}` | **消灯**(応答は `state: "OFF"`) | 暗くしたいだけなら 1〜254 を送る |

### 3.4 `GET /health` 生存確認

```bash
curl -s -w '\n%{http_code}\n' http://10.20.10.5:3000/health
```

| 状態 | HTTP | 本文 | 意味 |
|---|---|---|---|
| 正常 | 200 | `{"status":"ok","mqtt":"connected"}` | 電球操作ができる |
| 縮退 | 503 | `{"status":"degraded","mqtt":"disconnected"}` | API は生きているが MQTT 未接続。電球操作は 503 `MQTT_UNAVAILABLE` になる |

電球とは通信しないので、監視で頻繁に叩いてよい。デプロイ直後は MQTT 接続前に 503 を返すことがある(数秒で回復する)。

## 4. エラー応答

すべてのエラーは同じ形で返る。クライアントは `message` ではなく `code` で分岐する(`message` は人が読む用で、文言は変わり得る)。

```json
{"error":{"code":"LIGHT_NOT_FOUND","message":"unknown light: living9"}}
```

| code | HTTP | いつ起きるか | クライアントの対処 |
|---|---|---|---|
| `INVALID_REQUEST` | 400 | body が JSON でない、`state` が `ON` / `OFF` 以外、`brightness` が 0〜254 の整数以外、`state` も `brightness` も無い、body が配列 | リクエストを直す。再送しても結果は同じ |
| `LIGHT_NOT_FOUND` | 404 | パスの電球名が未登録 | `GET /lights` で名前を確認する |
| `NOT_FOUND` | 404 | 存在しないパス(例 `/light/living1`) | URL を確認する |
| `MQTT_UNAVAILABLE` | 503 | API が MQTT ブローカーに未接続 | `GET /health` が 200 になるまで待って再送 |
| `DEVICE_TIMEOUT` | 504 | 電球が `DEVICE_TIMEOUT_MS`(既定 5 秒)以内に応答しない。電球の電源が切れている、Zigbee の電波が届かない | 数秒おいて再送。続くなら電球の電源や設置場所を確認 |
| `INTERNAL_ERROR` | 500 | API 内部の予期しないエラー。どのエンドポイントでも起き得る | API のログ(`docker compose logs api`)を確認 |

再送してよいのは `MQTT_UNAVAILABLE` と `DEVICE_TIMEOUT` のみ。`PUT` は冪等(同じ body を 2 回送っても結果は同じ)なので再送で状態が壊れることはない。

## 5. クライアント実装の注意

将来の呼び出し元(ローカル LLM、Raspberry Pi Pico 製コントローラー、他のサービス)が共通して守ること。

- **電球名は決め打ちしない**: 起動時に `GET /lights` で取得する。名前は運用で増減する
- **`brightness` の省略に備える**: `GET` の応答に `brightness` が無いことがある
- **連打しない**: 同じ電球への同時リクエストは API 内で「次の 1 応答」を待つ形で処理され、1 つの応答で複数の要求が同時に解決されることがある。そのため **応答が自分の指示を反映していないことがある**(先の要求の応答で後の要求も解決される)。ロータリーエンコーダーのような高頻度入力は、クライアント側で間引く(例: 100ms ごとに最後の値だけ送る)。表示に使う値は、入力が落ち着いてから `GET /lights/{name}` で取り直すのが確実
- **ブラウザから直接呼ぶ場合**: API は CORS に対応していない(`Access-Control-Allow-Origin` を返さない)。別オリジンの Web ページから `fetch` するには、同一オリジンで配信するか API 側に CORS の追加が必要
- **リトライは 503 / 504 のみ**、間隔は数秒。400 / 404 はリトライしない
- **タイムアウトはクライアント側でも持つ**: API の電球待ちは既定 5 秒。クライアントは 7〜10 秒程度で打ち切る
- **状態の真実は電球側**: API は状態を保存しない。表示を更新したいときは `PUT` の応答か `GET` の結果を使い、クライアント側で推測しない
- **LLM のツール定義に使う場合**: `openapi.yaml` の `components.schemas.LightCommand` をそのまま function calling の引数スキーマに流用できる。`brightness` の挙動(3.3 の表)はツール説明文に書いておくと誤操作が減る

## 6. 付属ツール

- リポジトリ直下の `control_light.sh`: `./control_light.sh [ON|OFF] [電球名]` でオン / オフを送る簡易スクリプト(git 管理外)
- `openapi.yaml` の確認・活用例
  - 文書の妥当性検証と契約テスト: `cd api && npm test`(`test/openapi.test.ts`)
  - TypeScript 型の生成: `npx openapi-typescript docs/api/openapi.yaml -o light-api.d.ts`
  - ブラウザで閲覧: Swagger Editor(https://editor.swagger.io/)に貼り付ける。API からの配信(`/docs`)は現時点では行っていない

## 7. 変更履歴

| version | 日付 | 内容 |
|---|---|---|
| 1.0.0 | 2026-10-26 | オン / オフ、状態取得、一覧、health |
| 1.1.0 | 2026-10-31 | `PUT /lights/{name}/state` に `brightness`(0〜254)を追加。`state` は任意になった(どちらか一方が必須) |
