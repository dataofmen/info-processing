#!/bin/zsh
# ChatGPT 터널(tunnel-client)이 띄우는 MCP 로컬 연결(stdio).
# 표준 출력은 MCP 메시지 전용이므로 이 스크립트는 아무것도 출력하지 않는다(로그는 표준 오류로).
ROOT="${0:A:h:h}"
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
exec node --env-file-if-exists="$ROOT/.env" "$ROOT/src/cli.ts" mcp
