# Zigbee 基盤(Zigbee2MQTT + Mosquitto)設計

作成日: 2026-10-18
対応する概要書の項目: 次のアクション 1「Raspberry Pi 5 で ZBDongle-E を認識させ、Zigbee2MQTT + Mosquitto を Docker で起動して Hue 電球をペアリングする」

## 1. 目的

Raspberry Pi 5(ホスト名 side3)上に、Philips Hue 電球を MQTT 経由で操作できる Zigbee 基盤を Docker Compose で立てる。
後続の Express API サーバはこの基盤の MQTT ブローカーに接続して電球を操作する。
あわせて、概要書のリスク項目(ドングルのファームウェア、電球のペアリング、コンテナへの USB 受け渡し)を実機で洗い出す。

## 2. 前提(確認済み)

| 項目 | 内容 |
|---|---|
| ホスト | side3 = Raspberry Pi 5、aarch64、Debian 13(trixie)ベースの Raspberry Pi OS(CLI のみ) |
| Docker | 未インストール |
| ドングル | SONOFF ZBDongle-E(EFR32MG21)。USB 延長ケーブル経由で接続済み。CH343 USB シリアル(1a86:55d4)として `/dev/ttyACM0` に認識 |
| 固定デバイスパス | `/dev/serial/by-id/usb-1a86_USB_Single_Serial_5B33027897-if00` |
| 権限 | ユーザー ichio は dialout / sudo グループ所属。パスワードなし sudo 可 |
| GitHub | 開発機で `ichiokondo007` としてログイン済み。side3 は HTTPS で GitHub に到達可。public リポジトリとする |
| 電球 | Philips Hue スマート電球 E26 ホワイトグラデーション 1 個。純正ブリッジは使わない |
| ファームウェア(確認済み 2026-10-18) | EmberZNet 7.4.5 [GA]、EZSP 13。ember の要件を満たし更新不要 |
| 電球の識別(確認済み 2026-10-18) | モデル 929002335105「Hue white ambiance E26 1600lm with Bluetooth」、IEEE アドレス `0x001788010d9550fb`、シリアル `6541E0`、friendly name `hue-bulb-1` |

## 3. 決定事項

- Zigbee 層は Zigbee2MQTT + Mosquitto(概要書 項目 7「その他」)
- Zigbee2MQTT の設定は **環境変数(`ZIGBEE2MQTT_CONFIG_*`)で渡す**。`configuration.yaml` は Git 管理しない
  - 理由: Zigbee2MQTT は起動時にネットワークキーやデバイス一覧を `configuration.yaml` に書き込む。Git 管理すると side3 側で差分が出て `git pull` が衝突する
  - 副作用: 環境変数で渡した値は `configuration.yaml` に永続化されず、Zigbee2MQTT の設定マイグレーションの対象外になる(公式ドキュメントの注意書き)。設定項目が少ないので許容する
- Docker は **Docker 公式 apt リポジトリ**から docker-ce / docker-ce-cli / containerd.io / docker-compose-plugin を入れる
- リポジトリは GitHub に **public** で作り、side3 は HTTPS で clone / pull する。side3 上でファイルは編集しない
- 設計書の置き場は `docs/superpowers/specs/`

## 4. 構成

### 4.1 ファイル配置

```
konai-web/
├── compose.yaml                      # mosquitto + zigbee2mqtt(Express は後続で追加)
├── mosquitto/
│   └── mosquitto.conf                # listener 1883、匿名接続許可、永続化なし
├── zigbee2mqtt/
│   └── data/                         # Zigbee2MQTT の書き込み領域。gitignore
├── docs/superpowers/specs/2026-10-18-zigbee-infra-design.md
├── .gitignore                        # zigbee2mqtt/data/ を追加
└── プロジェクト概要書.md
```

### 4.2 mosquitto サービス

- イメージ: `eclipse-mosquitto`(公式)
- 設定 `mosquitto/mosquitto.conf`:
  - `listener 1883`
  - `allow_anonymous true`(概要書 項目 7「認証なし、ローカル内のみ」)
  - 永続化なし(DB なしの方針)
- ポート: ホストの 1883 を LAN に公開。将来の Pico / ローカル LLM クライアントが直接 MQTT に繋げるようにする
- `restart: unless-stopped`

### 4.3 zigbee2mqtt サービス

- イメージ: `ghcr.io/koenkk/zigbee2mqtt`(公式)
- `devices:` で `/dev/serial/by-id/usb-1a86_USB_Single_Serial_5B33027897-if00` をコンテナの `/dev/ttyACM0` に渡す
- ボリューム: `./zigbee2mqtt/data:/app/data`、`/run/udev:/run/udev:ro`
- ポート: 8080(フロントエンド)
- 環境変数:

| 変数 | 値 | 意味 |
|---|---|---|
| `TZ` | `Asia/Tokyo` | タイムゾーン |
| `Z2M_ONBOARD_NO_SERVER` | `1` | 初回起動時のオンボーディング画面を出さず、環境変数の設定で起動する |
| `ZIGBEE2MQTT_CONFIG_SERIAL_PORT` | `/dev/ttyACM0` | コンテナ内のデバイスパス |
| `ZIGBEE2MQTT_CONFIG_SERIAL_ADAPTER` | `ember` | EFR32MG21 用アダプタ。EmberZNet 7.4 以上のファームウェアが必要 |
| `ZIGBEE2MQTT_CONFIG_SERIAL_BAUDRATE` | `115200` | |
| `ZIGBEE2MQTT_CONFIG_SERIAL_RTSCTS` | `false` | ZBDongle-E はソフトウェアフロー制御のみ(公式ドキュメント) |
| `ZIGBEE2MQTT_CONFIG_MQTT_SERVER` | `mqtt://mosquitto:1883` | compose 内のサービス名で解決 |
| `ZIGBEE2MQTT_CONFIG_FRONTEND_ENABLED` | `true` | Web フロントエンド有効 |
| `ZIGBEE2MQTT_CONFIG_PERMIT_JOIN` | `false` | ペアリングはフロントエンドから都度許可する |

- `depends_on: mosquitto`、`restart: unless-stopped`

### 4.4 データの流れ

```
Hue 電球 ──Zigbee──▶ ZBDongle-E ──USB──▶ zigbee2mqtt コンテナ ──MQTT──▶ mosquitto コンテナ
                                                                           ▲
                                        (後続) Express API / Pico / LLM ───┘
```

操作トピック(Zigbee2MQTT の既定):
- 状態取得: `zigbee2mqtt/hue-bulb-1`(購読)
- 操作: `zigbee2mqtt/hue-bulb-1/set` に `{"state":"ON"}`、`{"brightness":128}` などを発行

電球の friendly name はペアリング後にフロントエンドで `hue-bulb-1` に変更する(Express から使う名前を固定するため)。

## 5. 作業手順

### 5.1 開発機(worktree-per-feature → main)

1. worktree でブランチ `feature/zigbee-infra` を切る
2. `compose.yaml`、`mosquitto/mosquitto.conf`、`.gitignore` 追記を作る
3. main にマージ
4. `gh repo create ichiokondo007/konai-web --public --source . --push` で GitHub に public リポジトリを作り、main を push

### 5.2 side3(ssh 経由)

1. Docker 公式 apt リポジトリを登録し、docker-ce / docker-ce-cli / containerd.io / docker-compose-plugin をインストール。ichio を docker グループに追加(実行前に利用者へ確認する)
2. `git clone https://github.com/ichiokondo007/konai-web ~/konai-web`
3. `cd ~/konai-web && docker compose up -d`

以後の更新は side3 で `git pull && docker compose up -d`。

## 6. 完了条件(すべて side3 で確認)

1. `docker compose ps` で mosquitto と zigbee2mqtt が両方 running
2. zigbee2mqtt のログに coordinator 接続成功と EZSP / EmberZNet のバージョンが出る
3. ブラウザで `http://side3:8080`(Zigbee2MQTT フロントエンド)が開く
4. フロントエンドで permit join を有効にし、Hue 電球をペアリング。デバイス一覧に現れ、friendly name を `hue-bulb-1` にする
5. mosquitto コンテナ内から `mosquitto_pub -h localhost -t zigbee2mqtt/hue-bulb-1/set -m '{"state":"TOGGLE"}'` を送ると電球が点滅する

## 7. 失敗時の扱い

| 事象 | 判断材料 | 対応 |
|---|---|---|
| ember で接続できない(ファームウェアが古い) | ログに `NCP EZSP protocol version of XX does not match Host version` | Zigbee2MQTT 公式が案内する SONOFF Dongle Flasher(Web ベース、Chrome + USB)でファームウェア 7.4.x 以上に更新する。別作業として切り出し、本設計書に結果を追記する |
| 電球がペアリングできない | permit join 中に 2 分待ってもデバイスが現れない | **実機で判明(2026-10-18)**: Hue 電球は電源の 5 回オンオフではリセットされず、permit join だけでは参加してこなかった。`zigbee2mqtt/bridge/request/action` に `{"action":"philips_hue_factory_reset","params":{"serial_numbers":["<電球のシリアル>"]}}` を送る(電球本体に印刷された 6 桁)と即座に参加した。Touchlink スキャンは 1 m 離れていると見つからない |
| コンテナからドングルが見えない | ログに serial port open エラー | `ls -l /dev/serial/by-id/` で by-id パスを確認し、`compose.yaml` の `devices:` を直す |
| オンボーディングが起動して止まる | ログにオンボーディング URL が出る | `Z2M_ONBOARD_NO_SERVER=1` が渡っているか確認 |

## 8. テスト方針

インフラ構成のため自動テストは書かない。6 の完了条件を手動で確認する。
API の自動テストは Express の段階(次のアクション 2、3)で書く。

## 9. スコープ外

- Express API サーバ本体(次のアクション 2、3)
- 調色、複数電球、認証、Web UI(概要書 項目 5「やらないこと」)
- ドングルのファームウェア更新(必要になった場合のみ別作業)
