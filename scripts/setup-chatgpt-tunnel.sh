#!/bin/zsh
# ChatGPT ↔ 맥미니 MCP 연결 (OpenAI Secure MCP Tunnel). 맥미니 터미널에서 직접 실행한다.
#   ./scripts/setup-chatgpt-tunnel.sh <tunnel_id>           설치·설정·검사·상주 실행 등록
#   ./scripts/setup-chatgpt-tunnel.sh <tunnel_id> --reinit  설정(프로필)을 다시 만든다
# 준비: https://platform.openai.com/settings/organization/tunnels 에서 터널을 만들고 ChatGPT 워크스페이스와 연결,
#       실행용 API 키(Tunnels Read+Use 권한)를 발급. 키는 이 스크립트가 물을 때만 입력한다(화면에 표시되지 않음).
set -e
ROOT="${0:A:h:h}"
TUNNEL_ID="$1"
PROFILE=info-knowledge
CONF_DIR="$HOME/.config/tunnel-client"
KEY_FILE="$CONF_DIR/$PROFILE.key"
[[ "$TUNNEL_ID" == tunnel_* ]] || { echo "사용법: $0 <tunnel_id>  (tunnel_ 로 시작하는 ID)"; exit 1; }

echo "== 1. tunnel-client 설치"
command -v tunnel-client >/dev/null || brew install openai/tools/tunnel-client
tunnel-client --version 2>/dev/null || true

echo "== 2. 실행용 API 키"
mkdir -p "$CONF_DIR" && chmod 700 "$CONF_DIR"
if [ ! -s "$KEY_FILE" ]; then
  read -rs "KEY?실행용 API 키를 붙여 넣고 Enter (화면에 보이지 않음): "; echo
  [ -n "$KEY" ] || { echo "키가 비었습니다."; exit 1; }
  (umask 077; print -rn -- "$KEY" > "$KEY_FILE"); unset KEY
  echo "  저장: $KEY_FILE (권한 600)"
else
  echo "  기존 키 파일 사용: $KEY_FILE"
fi
export CONTROL_PLANE_API_KEY="$(<"$KEY_FILE")"

echo "== 3. 터널 설정(프로필 $PROFILE)"
chmod +x "$ROOT/scripts/mcp-stdio.sh" "$ROOT/scripts/tunnel-run.sh"
if [[ "$2" == "--reinit" ]]; then rm -f "$CONF_DIR/$PROFILE.yaml"; fi
if [ ! -f "$CONF_DIR/$PROFILE.yaml" ]; then
  tunnel-client init --sample sample_mcp_stdio_local --profile "$PROFILE" --tunnel-id "$TUNNEL_ID" --mcp-command "$ROOT/scripts/mcp-stdio.sh"
else
  echo "  기존 프로필 사용 (다시 만들려면 --reinit)"
fi

echo "== 4. 검사"
tunnel-client doctor --profile "$PROFILE" --explain

echo "== 5. 상주 실행(launchd)"
mkdir -p "$ROOT/data"
PLIST=~/Library/LaunchAgents/com.hm.info-tunnel.plist
sed -e "s#__ROOT__#$ROOT#g" "$ROOT/scripts/com.hm.info-tunnel.plist" > "$PLIST"
launchctl bootout gui/$(id -u) "$PLIST" 2>/dev/null || true
launchctl bootstrap gui/$(id -u) "$PLIST"
sleep 5
tail -n 5 "$ROOT/data/tunnel.log" 2>/dev/null || true

cat <<MSG

== 다음: ChatGPT에서 연결
 1. https://chatgpt.com/plugins → + → Add custom MCP server
 2. 이름: knowledge / Connection: Tunnel → 목록에서 이 터널 선택 (또는 $TUNNEL_ID 입력)
 3. 인증: No authentication (맥미니 안의 로컬 연결이라 토큰을 쓰지 않음)
 4. 도구 7개는 읽기 전용, capture_url·promote 는 쓰기(호출 때 확인)로 보인다
 상태 확인: tail -f $ROOT/data/tunnel.log
 끄기:      launchctl bootout gui/\$(id -u) $PLIST
MSG
