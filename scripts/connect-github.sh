#!/bin/zsh
# knowledge / assets-YYYY 비공개 저장소를 만들고 연결한다. 실행 전에 내용을 확인하세요.
set -e
cd "$(dirname "$0")/.."
source .env 2>/dev/null || true
K=${KNOWLEDGE_DIR:-./data/knowledge}; A=${ASSETS_DIR:-./data/assets}; Y=$(date +%Y)
gh repo create knowledge --private --source "$K" --remote origin --push
gh repo create "assets-$Y" --private --source "$A" --remote origin --push
grep -q '^GIT_PUSH=1' .env || sed -i '' 's/^GIT_PUSH=.*/GIT_PUSH=1/' .env
echo "연결 완료. GIT_PUSH=1 — 이후 commit마다 push합니다."
