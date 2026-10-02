#!/bin/zsh
# 맥미니 설치 스크립트. 여러 번 실행해도 안전(멱등).
set -e
cd "$(dirname "$0")/.."
ROOT=$(pwd)

echo "== 1. 의존성"
command -v node >/dev/null || brew install node
command -v pdftotext >/dev/null || brew install poppler
command -v ollama >/dev/null || brew install ollama
npm ci --no-audit --no-fund

echo "== 2. 로컬 모델 (임베딩·분류)"
(brew services start ollama >/dev/null 2>&1 || true)
sleep 3
ollama pull bge-m3
ollama pull qwen3:14b

echo "== 3. 설정 파일"
[ -f .env ] || { cp .env.example .env; echo "  .env 생성 — 텔레그램 토큰 등을 채워 주세요 (이 파일은 git에 올라가지 않습니다)"; }

echo "== 4. knowledge 저장소 초기화"
node --env-file-if-exists=.env src/cli.ts init

echo "== 5. 상주 실행(launchd)"
PLIST=~/Library/LaunchAgents/com.hm.info-pipeline.plist
sed -e "s#__ROOT__#$ROOT#g" -e "s#__NODE__#$(command -v node)#g" -e "s#__PATH__#$PATH#g" scripts/com.hm.info-pipeline.plist > "$PLIST"
launchctl bootout gui/$(id -u) "$PLIST" 2>/dev/null || true
launchctl bootstrap gui/$(id -u) "$PLIST"
echo "  시작됨. 로그: $ROOT/data/serve.log"

cat <<'MSG'

== 사람이 할 일 (한 번씩)
 a. 절전 끄기:            sudo pmset -a sleep 0 disksleep 0 && sudo pmset -a autorestart 1
 b. 자동화 브라우저 로그인: npm run login   (X·LinkedIn·Threads 로그인 후 창 닫기)
 c. .env 채우기:           TELEGRAM_BOT_TOKEN, TELEGRAM_ALLOWED_CHAT_IDS, HOST(Tailscale IP), MCP_TOKEN
 d. GitHub 비공개 저장소 연결(선택): scripts/connect-github.sh
 e. CLI 로그인 확인:       agy / codex / claude 를 한 번씩 실행해 로그인
MSG
