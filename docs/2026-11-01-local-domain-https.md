# konai web をローカル専用ドメイン + HTTPS で公開する(konai.kd1-tech.net)

作成日: 2026-11-01
対象: side3(Raspberry Pi 5, 10.20.10.5)上の konai-web(Docker Compose)
結果: 家の中の端末から `https://konai.kd1-tech.net/` で konai web が開ける(Let's Encrypt 正規証明書、警告なし)

## 1. 目的と経緯

- 家族の iPhone / iPad から `http://10.20.10.5:8088/` を開くのは IP とポートの入力が難しいため、名前で開けるようにしたかった。
- 最初は granada(ルータ Pi、dnsmasq)でローカル DNS を立てる案を調査したが、ブラウザを使う端末が granada の上流(192.168.0.x、TP-Link ルータの DNS)に居るため、granada の DNS だけでは届かないことが分かり、設定が複雑になるので一度断念。
- 既に Cloudflare で運用している独自ドメイン kd1-tech.net を使えば、公開 DNS にプライベート IP を書くだけで全端末が名前解決でき、Let's Encrypt の DNS-01 認証で HTTPS 化もできると判断して採用。

## 2. 最終構成

```
[iPhone/iPad/PC (192.168.0.x)]
   │ 名前解決: TP-Link 192.168.0.1 → ISP → Cloudflare 権威 DNS
   │   konai.kd1-tech.net = 10.20.10.5 (A, Proxy OFF)
   ▼
[granada 10.20.10.1] 192.168.0.x → 10.20.10.x へルーティング(設定変更なし)
   ▼
[side3 10.20.10.5]  Docker Compose (~/konai-web)
   caddy  :80 → https へ 308 リダイレクト
          :443 TLS 終端(Let's Encrypt, DNS-01 via Cloudflare API)
            └─ reverse_proxy → web:80
   web    nginx: 静的配信 + /api/ → api:3000  (従来の :8088 も継続公開)
   api    Express(:3000)
   zigbee2mqtt(:8080), mosquitto(:1883)
```

ポイント

- **名前解決はすべて公開 DNS**。granada の dnsmasq も TP-Link の DNS 設定も変えていないので、granada が止まっても名前解決には影響しない。
- **外部からは到達不能**。インターネット側で konai.kd1-tech.net を引いても 10.20.10.5 というプライベート IP が返るだけ。Cloudflare のプロキシ(橙色の雲)は OFF にしてある。ON にすると Cloudflare がプライベート IP に接続しようとして失敗する。
- **証明書は公的 CA**。端末にルート証明書を入れる必要がない。Caddy が約 60 日ごとに自動更新する。
- **ホスト名は公開情報になる**。Certificate Transparency ログに konai.kd1-tech.net が載る(到達はできないので実害なし)。

## 3. 作業手順(実施順)

### 3.1 side3 の k3s を停止(80/443 を空ける)

k3s の traefik が ServiceLB 経由で 10.20.10.5:80/443 を占有していた(`ss` には見えず、iptables の DNAT で奪っている)。145 日間ワークロードが無かったため停止。

```bash
sudo systemctl disable --now k3s
sudo /usr/local/bin/k3s-killall.sh   # 残った pod・iptables(KUBE-/CNI-/flannel)・cni0/flannel.1 を掃除
sudo iptables-save | grep -cE "KUBE-|CNI-|flannel"   # 0 を確認
sudo ss -lntp | grep -E ":80 |:443 "                  # 空を確認
```

バイナリと `/var/lib/rancher`(1.3GB)は残してある。戻す: `sudo systemctl enable --now k3s`。消す: `sudo /usr/local/bin/k3s-uninstall.sh`。
killall スクリプトは Docker の iptables(DOCKER チェーン)には触らないことを事前に確認した。

### 3.2 Cloudflare API トークンの作成(ダッシュボード)

My Profile → API Tokens → Create Token → テンプレート「ゾーン DNS を編集する」
→ Zone Resources: Include / Specific zone / kd1-tech.net → 作成。
権限は「Zone / DNS / Edit」のみ、対象ゾーンは kd1-tech.net のみに限定する。

side3 に保存:

```bash
# ~/konai-web/.env  (chmod 600、.gitignore 済み)
CF_API_TOKEN=cfut_xxxxxxxx
```

注意: `KEY=値` の形式で書く。トークン単体で書くと compose から参照できない(今回最初にそうなっていた)。

### 3.3 Cloudflare に A レコードを追加(API)

```bash
cd ~/konai-web
TOKEN=$(sed -n 's/^CF_API_TOKEN=//p' .env)
H="Authorization: Bearer $TOKEN"
# トークン確認
curl -s -H "$H" https://api.cloudflare.com/client/v4/user/tokens/verify
# ゾーン ID 取得
curl -s -H "$H" "https://api.cloudflare.com/client/v4/zones?name=kd1-tech.net"
# A レコード作成(proxied=false が重要)
curl -s -X POST -H "$H" -H "Content-Type: application/json" \
  "https://api.cloudflare.com/client/v4/zones/<ZONE_ID>/dns_records" \
  --data '{"type":"A","name":"konai","content":"10.20.10.5","ttl":1,"proxied":false,"comment":"konai web on side3 (LAN only)"}'
```

ダッシュボードで追加する場合: DNS → Records → Add record → Type A、Name `konai`、IPv4 `10.20.10.5`、Proxy status を **DNS only**(灰色)。

### 3.4 Caddy を compose に追加

`~/konai-web/caddy/Caddyfile`:

```caddyfile
konai.kd1-tech.net {
	tls {
		dns cloudflare {env.CF_API_TOKEN}
		resolvers 1.1.1.1 8.8.8.8   # LAN 内なので DNS 伝播チェックは公開リゾルバで
	}
	encode gzip
	reverse_proxy web:80
}
```

`~/konai-web/compose.yaml` に追記したサービス:

```yaml
  caddy:
    image: ghcr.io/caddybuilds/caddy-cloudflare:latest   # Cloudflare DNS モジュール入り
    restart: unless-stopped
    logging: *default-logging
    depends_on:
      - web
    ports:
      - "80:80"
      - "443:443"
      - "443:443/udp"
    environment:
      CF_API_TOKEN: ${CF_API_TOKEN}
    volumes:
      - ./caddy/Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy_data:/data        # 証明書と ACME アカウント。消すと再取得になる
      - caddy_config:/config

volumes:
  caddy_data:
  caddy_config:
```

起動と確認:

```bash
sudo docker compose config --quiet && sudo docker compose up -d caddy
sudo docker compose logs -f caddy   # "certificate obtained successfully" が出れば完了(1〜2 分)
```

### 3.5 動作確認

```bash
# 名前解決(家のルータ経由)
dig +short konai.kd1-tech.net @192.168.0.1        # → 10.20.10.5
# HTTPS(名前解決を迂回して先に試す場合)
curl -sI --resolve konai.kd1-tech.net:443:10.20.10.5 https://konai.kd1-tech.net/
# 証明書
echo | openssl s_client -connect 10.20.10.5:443 -servername konai.kd1-tech.net 2>/dev/null \
  | openssl x509 -noout -subject -issuer -dates
```

結果: HTTPS 200、`http://` は 308 で `https://` へ、証明書は Let's Encrypt 発行 CN=konai.kd1-tech.net(2027-01-29 まで、自動更新)。

## 4. つまずいた点

- **負キャッシュ**: A レコード作成前に `konai.kd1-tech.net` を引いてしまい、ISP 側リゾルバに「存在しない」が約 30 分キャッシュされた(Cloudflare の SOA minimum TTL = 1800 秒)。レコードを作る前に名前を引かないこと。待てば解消する。
- **DNS リバインド保護**: ルータによっては公開名がプライベート IP を返す応答を捨てる。TP-Link(192.168.0.1)は捨てないことを `dig 10.20.10.5.nip.io @192.168.0.1` で確認した(nip.io は任意の IP を返す公開サービスで、キャッシュに依存しないテストができる)。
- **k3s が 80/443 を見えない形で占有**: `ss -lntp` に listener が出ないのに Docker で `80:80` が衝突する。原因は ServiceLB の iptables DNAT。`iptables -t nat -S | grep dport` で発見。
- **Caddyfile の検証**: `caddy validate` にダミートークンを渡すと「token appears invalid」で止まるが、これは形式チェックで構文は通っている。本番トークンでの検証は起動ログで行う。

## 5. 運用メモ

- 名前を追加したい時(例: Zigbee2MQTT の UI): Cloudflare に `z2m` の A レコード(10.20.10.5、DNS only)を足し、Caddyfile にブロックを追加して `docker compose restart caddy`。
  ```caddyfile
  z2m.kd1-tech.net {
  	tls { dns cloudflare {env.CF_API_TOKEN} resolvers 1.1.1.1 8.8.8.8 }
  	reverse_proxy zigbee2mqtt:8080
  }
  ```
- トークンを更新した時: `.env` を書き換えて `sudo docker compose up -d caddy`。
- ロールバック: `sudo docker compose rm -sf caddy` で `:8088` だけの状態に戻る。Cloudflare の A レコードは残っていても害はない。
- iPhone / iPad: Safari で開き、共有 → 「ホーム画面に追加」。manifest(standalone)があるのでアプリ風に起動する。

## 6. 関連ホストと役割(2026-11-01 時点)

| ホスト | IP | 役割 |
|---|---|---|
| granada | 10.20.10.1 | Pi ルータ(wlan0 → eth0 NAT)、dnsmasq は DHCP のみ(DNS 無効) |
| next | 10.20.10.2 | Nextcloud(office.kd1-tech.net、Cloudflare プロキシ経由で公開) |
| jaburo | 10.20.10.4 | |
| side3 | 10.20.10.5 | konai-web(本ドキュメント)。k3s は停止済み |
| von-braun | 10.20.10.198 | DHCP リース |
| TP-Link | 192.168.0.1 | 上流ルータ。家の端末の DHCP/DNS |
