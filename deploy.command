#!/bin/zsh
# 席決めの儀 — サーバーをDeno Deployへデプロイするスクリプト
# (ダブルクリック or `open deploy.command` で実行)
cd "$(dirname "$0")/server" || exit 1
echo "🥂 サーバーをデプロイします…"
deno deploy --prod
echo ""
echo "=============================================="
echo " 上に「Successfully deployed」と出ていれば完了!"
echo " このウィンドウは閉じてOKです"
echo "=============================================="
