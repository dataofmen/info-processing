#!/bin/zsh
# launchd가 실행: 키 파일에서 실행용 API 키를 읽어 tunnel-client를 띄운다. 키는 출력하지 않는다.
set -e
KEY_FILE="$HOME/.config/tunnel-client/info-knowledge.key"
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
[ -s "$KEY_FILE" ] || { echo "키 파일 없음: $KEY_FILE (scripts/setup-chatgpt-tunnel.sh 를 먼저 실행)" >&2; exit 1; }
export CONTROL_PLANE_API_KEY="$(<"$KEY_FILE")"
exec tunnel-client run --profile info-knowledge
