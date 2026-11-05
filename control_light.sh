#!/bin/bash
set -euo pipefail

# --- 設定 ---
API_BASE="http://10.20.10.5:3000"

# --- 引数の処理 ---
ACTION="${1:-ON}"      # 第 1 引数: ON | OFF(省略時は ON)
LIGHT="${2:-living1}"  # 第 2 引数: 電球名(省略時は living1。例: desk)

case "${ACTION^^}" in
ON)
  PAYLOAD='{"state":"ON"}'
  ;;
OFF)
  PAYLOAD='{"state":"OFF"}'
  ;;
*)
  echo "エラー: 第 1 引数には 'ON' または 'OFF' を指定してください (指定値: $ACTION)" >&2
  echo "使用例: $0 [ON|OFF] [電球名]" >&2
  echo "        $0 ON          # living1 を ON" >&2
  echo "        $0 OFF desk    # desk を OFF" >&2
  exit 1
  ;;
esac

TARGET_URL="${API_BASE}/lights/${LIGHT}/state"

# --- リクエスト送信 ---
echo "${LIGHT} の状態を ${ACTION^^} に変更します..."

# HTTPステータスコードのチェック(本文は失敗時の原因表示に使う)
RESPONSE=$(curl -s -w '\n%{http_code}' -X PUT "$TARGET_URL" \
  -H 'Content-Type: application/json' \
  -d "$PAYLOAD")
HTTP_STATUS="${RESPONSE##*$'\n'}"
BODY="${RESPONSE%$'\n'*}"

if [[ "$HTTP_STATUS" =~ ^2 ]]; then
  echo "成功しました (HTTP $HTTP_STATUS)"
else
  echo "リクエストが失敗しました (HTTP $HTTP_STATUS): $BODY" >&2
  exit 1
fi
