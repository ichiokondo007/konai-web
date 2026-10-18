# Zigbee 基盤(Zigbee2MQTT + Mosquitto)実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** side3(Raspberry Pi 5)上で Zigbee2MQTT + Mosquitto を Docker Compose で起動し、Hue 電球をペアリングして MQTT 経由でオンオフできる状態にする。

**Architecture:** リポジトリに `compose.yaml` と Mosquitto 設定を置き、GitHub(public)経由で side3 に clone する。Zigbee2MQTT の設定は環境変数で渡し、書き込み領域 `zigbee2mqtt/data/` は gitignore する。side3 ではファイルを編集せず `git pull && docker compose up -d` だけで更新する。

**Tech Stack:** Docker Compose、`eclipse-mosquitto`、`ghcr.io/koenkk/zigbee2mqtt`(ember アダプタ)、GitHub CLI

**Spec:** `docs/superpowers/specs/2026-10-18-zigbee-infra-design.md`

## Global Constraints

- ホスト: side3(ssh 設定済み)。Raspberry Pi 5、Debian 13(trixie)、aarch64
- ドングルの固定パス: `/dev/serial/by-id/usb-1a86_USB_Single_Serial_5B33027897-if00`(コンテナ内では `/dev/ttyACM0`)
- Zigbee2MQTT アダプタ: `ember`、ボーレート `115200`、`rtscts: false`。ファームウェアは EmberZNet 7.4 以上が必要
- MQTT: 認証なし、ポート 1883 を LAN に公開。Zigbee2MQTT フロントエンドはポート 8080
- 電球の friendly name: `hue-bulb-1`
- GitHub リポジトリ: `ichiokondo007/konai-web`、public
- 開発機の作業は worktree + ブランチ `feature/zigbee-infra`、完了後 main にマージ。設計書・計画書は main が正本
- side3 の OS 変更(apt、グループ追加)は実行前に利用者へ確認する
- 設定ファイルは side3 側で編集しない

## Review Focus

1. ドングルを抜き差しして `/dev/ttyACM0` の番号が変わっても起動できること(by-id パスを使う。Task 1 で `devices:` が by-id であることを確認)
2. side3 を再起動しても 2 コンテナが自動復帰すること(`restart: unless-stopped`。Task 4 で再起動後の `docker compose ps` を確認)
3. ペアリング後に permit join が閉じていること(開けっぱなしだと近隣の Zigbee 機器が勝手に参加する。Task 5 で `permit_join: false` を確認)
4. 初回起動時にオンボーディング画面で止まらないこと(`Z2M_ONBOARD_NO_SERVER=1`。Task 4 のログ確認)
5. ファームウェアが古い場合に黙って再起動ループしないこと(Task 4 でログの EZSP バージョン不一致を判定し、該当なら Task 5 へ進まず利用者へ報告)

---

### Task 1: compose と Mosquitto 設定をリポジトリに追加

**Files:**
- Create: `compose.yaml`
- Create: `mosquitto/mosquitto.conf`
- Modify: `.gitignore`(末尾に追記)

**Interfaces:**
- Produces: compose サービス名 `mosquitto`(ポート 1883)、`zigbee2mqtt`(ポート 8080)。Task 4 以降は `docker compose` でこの 2 サービスを操作する

- [ ] **Step 1: worktree を作る**

`superpowers:using-git-worktrees` スキルで、ブランチ `feature/zigbee-infra` の worktree を作る。以降の Task 1 の作業はその worktree で行う。

- [ ] **Step 2: `mosquitto/mosquitto.conf` を書く**

内容は次の 3 行のみ。

```
listener 1883
allow_anonymous true
persistence false
```

- [ ] **Step 3: `compose.yaml` を書く**

設計書 4.2 と 4.3 のとおり。決め打ちの値:

- `mosquitto`: image `eclipse-mosquitto:2`、ports `1883:1883`、volumes `./mosquitto/mosquitto.conf:/mosquitto/config/mosquitto.conf:ro`、`restart: unless-stopped`
- `zigbee2mqtt`: image `ghcr.io/koenkk/zigbee2mqtt:2`、ports `8080:8080`、volumes `./zigbee2mqtt/data:/app/data` と `/run/udev:/run/udev:ro`、devices `/dev/serial/by-id/usb-1a86_USB_Single_Serial_5B33027897-if00:/dev/ttyACM0`、`depends_on: [mosquitto]`、`restart: unless-stopped`
- `zigbee2mqtt` の `environment:` は設計書 4.3 の表の 9 変数をそのまま

- [ ] **Step 4: `.gitignore` に追記**

末尾に次を追加する。

```
# Zigbee2MQTT の書き込み領域(ネットワークキー、デバイス一覧、ログ)
zigbee2mqtt/data/
```

- [ ] **Step 5: compose の構文を検証する**

Run: `docker compose config --quiet && echo OK`
Expected: `OK`(開発機には Docker Compose v5 が入っている。デバイスパスの実在は検証されない)

- [ ] **Step 6: 環境変数が設計書の表と一致することを確認する**

Run: `docker compose config | grep -c 'ZIGBEE2MQTT_CONFIG_\|Z2M_ONBOARD_NO_SERVER\|TZ:'`
Expected: `9`

- [ ] **Step 7: Commit**

```bash
git add compose.yaml mosquitto/mosquitto.conf .gitignore
git commit -m "feat: Zigbee2MQTT + Mosquitto の compose 構成を追加"
```

---

### Task 2: main へマージし GitHub に public リポジトリを作る

**Files:**
- なし(Git 操作のみ)

**Interfaces:**
- Consumes: Task 1 のブランチ `feature/zigbee-infra`
- Produces: `https://github.com/ichiokondo007/konai-web`(main を push 済み)。Task 4 が clone する

- [ ] **Step 1: main にマージする**

`superpowers:finishing-a-development-branch` スキルに従い、`feature/zigbee-infra` を main に fast-forward マージし、worktree とブランチを片付ける。

Run: `git -C /home/ichio/zz-feature-project/konai-web log --oneline -1`
Expected: Task 1 のコミットが main の先頭

- [ ] **Step 2: GitHub にリポジトリを作って push する**

Run(main の作業ツリーで): `gh repo create ichiokondo007/konai-web --public --source . --push --description "Raspberry Pi + Zigbee2MQTT で Philips Hue を操作する HomeLab API"`
Expected: `https://github.com/ichiokondo007/konai-web` が表示され、`git remote -v` に origin が出る

- [ ] **Step 3: push を確認する**

Run: `gh repo view ichiokondo007/konai-web --json visibility,defaultBranchRef -q '.visibility + " " + .defaultBranchRef.name'`
Expected: `PUBLIC main`

---

### Task 3: side3 に Docker をインストールする

**Files:**
- なし(side3 の OS 変更のみ)

**Interfaces:**
- Produces: side3 で `docker compose` が ichio ユーザーから実行できる状態

- [ ] **Step 1: 利用者に実行確認をとる**

「side3 に Docker 公式 apt リポジトリを登録し、docker-ce / docker-ce-cli / containerd.io / docker-compose-plugin をインストールして ichio を docker グループに追加します。実行してよいですか」と聞き、了承を得てから次へ進む。

- [ ] **Step 2: Docker 公式リポジトリを登録してインストールする**

side3 で Docker 公式ドキュメント(Install on Debian)の手順どおり: `ca-certificates curl` を入れ、`/etc/apt/keyrings/docker.asc` に GPG 鍵を置き、`/etc/apt/sources.list.d/docker.sources` にリポジトリ(Suite は `$(. /etc/os-release && echo "$VERSION_CODENAME")` = `trixie`、Architecture は `arm64`)を書き、`apt-get update && apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin` を実行する。

- [ ] **Step 3: ichio を docker グループに追加する**

Run: `ssh side3 'sudo usermod -aG docker ichio'`

- [ ] **Step 4: 動作確認(新しいログインセッションでグループが効くこと)**

Run: `ssh side3 'docker compose version && docker info --format "{{.ServerVersion}} {{.Architecture}}"'`
Expected: `Docker Compose version v2.x.x` と `2x.x.x aarch64` が出る。`permission denied` が出たらグループ反映前なので ssh を張り直す

---

### Task 4: side3 で起動し coordinator 接続を確認する

**Files:**
- なし(side3 上の `~/konai-web` を clone)

**Interfaces:**
- Consumes: Task 2 の GitHub リポジトリ、Task 3 の Docker
- Produces: side3 で `mosquitto` と `zigbee2mqtt` が稼働。Task 5 がこの上でペアリングする

- [ ] **Step 1: clone する**

Run: `ssh side3 'git clone https://github.com/ichiokondo007/konai-web ~/konai-web && ls ~/konai-web'`
Expected: `compose.yaml` と `mosquitto` が一覧に出る

- [ ] **Step 2: ドングルの by-id パスがあることを確認する**

Run: `ssh side3 'ls -l /dev/serial/by-id/usb-1a86_USB_Single_Serial_5B33027897-if00'`
Expected: `-> ../../ttyACM0`(番号は変わってよい)

- [ ] **Step 3: 起動する**

Run: `ssh side3 'cd ~/konai-web && docker compose up -d'`
Expected: 2 つのコンテナが Started になる(初回はイメージ取得に数分かかる)

- [ ] **Step 4: 両方 running であることを確認する**

Run: `ssh side3 'cd ~/konai-web && docker compose ps --format "{{.Service}} {{.State}}"'`
Expected:
```
mosquitto running
zigbee2mqtt running
```

- [ ] **Step 5: coordinator 接続とファームウェアバージョンをログで確認する**

Run: `ssh side3 'cd ~/konai-web && docker compose logs zigbee2mqtt | grep -iE "ember|ezsp|coordinator|onboard|error" | head -30'`
Expected: `Zigbee2MQTT started!` と、`ember` が報告するファームウェア / EZSP バージョン行が出る。`onboard` を含む行は出ない。
判定:
- `NCP EZSP protocol version of XX does not match Host version` が出たらファームウェアが古い。設計書 7 の対応(SONOFF Dongle Flasher での更新)を利用者へ報告し、**Task 5 へは進まない**
- serial port open エラーなら Step 2 のパスと `compose.yaml` の `devices:` を見直す

- [ ] **Step 6: フロントエンドが開くことを確認する**

Run: `ssh side3 'curl -s -o /dev/null -w "%{http_code}\n" http://localhost:8080/'`
Expected: `200`。あわせて利用者に `http://side3:8080` をブラウザで開いてもらう

- [ ] **Step 7: 再起動後に自動復帰することを確認する(Review Focus 2)**

Run: `ssh side3 'sudo reboot'` のあと 60 秒ほど待ち、`ssh side3 'cd ~/konai-web && docker compose ps --format "{{.Service}} {{.State}}"'`
Expected: Step 4 と同じく 2 行とも `running`

---

### Task 5: Hue 電球をペアリングし MQTT で操作する

**Files:**
- Modify: `プロジェクト概要書.md`(項目 11 の次のアクション 1 を完了にする)
- Modify: `docs/superpowers/specs/2026-10-18-zigbee-infra-design.md`(確認結果のファームウェアバージョン等を 2 の前提表に追記)

**Interfaces:**
- Consumes: Task 4 の稼働中コンテナ
- Produces: MQTT トピック `zigbee2mqtt/hue-bulb-1`(状態)と `zigbee2mqtt/hue-bulb-1/set`(操作)。後続の Express API はこのトピックを使う

- [ ] **Step 1: 利用者に電球を取り付けてもらう**

「Hue 電球をソケットに取り付けて電源を入れてください」と伝え、完了の返事を待つ。

- [ ] **Step 2: permit join を開く(254 秒)**

Run: `ssh side3 'cd ~/konai-web && docker compose exec mosquitto mosquitto_pub -h localhost -t zigbee2mqtt/bridge/request/permit_join -m "{\"time\": 254}"'`
Expected: エラーなし

- [ ] **Step 3: 電球が参加するのを待つ**

Run: `ssh side3 'cd ~/konai-web && timeout 180 docker compose exec mosquitto mosquitto_sub -h localhost -t zigbee2mqtt/bridge/event -C 3'`
Expected: `"type":"device_joined"` と `"type":"device_interview"`(`"status":"successful"`)を含む JSON。電球が 2 分出てこなければ電球の電源を 5 回オンオフしてリセットし、Step 2 からやり直す

- [ ] **Step 4: friendly name を `hue-bulb-1` にする**

Step 3 の JSON から `ieee_address`(`0x` で始まる)を取り、次を実行する。

Run: `ssh side3 'cd ~/konai-web && docker compose exec mosquitto mosquitto_pub -h localhost -t zigbee2mqtt/bridge/request/device/rename -m "{\"from\": \"<ieee_address>\", \"to\": \"hue-bulb-1\"}"'`
Expected: エラーなし

- [ ] **Step 5: デバイス一覧に `hue-bulb-1` があることを確認する**

Run: `ssh side3 'cd ~/konai-web && docker compose exec mosquitto mosquitto_sub -h localhost -t zigbee2mqtt/bridge/devices -C 1 | grep -o "\"friendly_name\":\"hue-bulb-1\""'`
Expected: `"friendly_name":"hue-bulb-1"`

- [ ] **Step 6: MQTT でトグルし、電球が点滅することを確認する**

Run: `ssh side3 'cd ~/konai-web && docker compose exec mosquitto mosquitto_pub -h localhost -t zigbee2mqtt/hue-bulb-1/set -m "{\"state\": \"TOGGLE\"}"'` を 2 回、数秒空けて実行する。
Expected: 利用者が「電球が消えて、また点いた」と確認する。あわせて `mosquitto_sub -t zigbee2mqtt/hue-bulb-1 -C 1` で `"state":"ON"` または `"OFF"` が返る

- [ ] **Step 7: permit join が閉じていることを確認する(Review Focus 3)**

Run: `ssh side3 'cd ~/konai-web && docker compose exec mosquitto mosquitto_sub -h localhost -t zigbee2mqtt/bridge/info -C 1 | grep -o "\"permit_join\":[a-z]*"'`
Expected: `"permit_join":false`(254 秒のタイムアウト後。まだ true なら `permit_join` リクエストで `{"time": 0}` を送る)

- [ ] **Step 8: 結果を文書に反映して main にコミットする**

main の作業ツリーで:
- 設計書 2 の前提表に「ファームウェア: EmberZNet x.y.z(Task 4 Step 5 のログから)」と「電球の ieee_address」を追記する
- `プロジェクト概要書.md` 項目 11 の 1 行目を `- [完了 2026-MM-DD] ...` の形にする(日付は `date +%Y-%m-%d`)

```bash
git add プロジェクト概要書.md docs/superpowers/specs/2026-10-18-zigbee-infra-design.md
git commit -m "docs: Zigbee 基盤の稼働結果を記録"
git push origin main
```
