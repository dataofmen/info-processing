# Info Processing

텔레그램으로 URL을 보내면 맥미니가 원문을 그대로 저장하고(Defuddle = Obsidian Web Clipper 엔진), AI가 원자 노트와 주제 지도로 증류한다. 사람은 웹 UI로, AI는 MCP로 꺼내 쓴다. 설계와 결정 기록은 [PLAN.md](PLAN.md)에 있다.

## 구조
```
pipeline (이 저장소, 코드)          data/ (맥미니 로컬, git 제외)
  src/capture   Playwright+Defuddle    knowledge/   ← 정본 Markdown (GitHub 비공개 knowledge)
  src/stages    capture·process·reflect assets/      ← 이미지·PDF (GitHub 비공개 assets-YYYY)
  src/llm       CLI 실행기·대체 순서    queue/       ← 대기열 상태 (JSON)
  src/indexer   SQLite 색인             index.db     ← 파생 색인. 지워도 됨
  src/mcp.ts    MCP 서버                browser-profile/ ← 자동화 전용 Chrome 프로필
  src/web       웹 UI (읽기 전용 + 수집)
```

## 명령
| 명령 | 하는 일 |
|---|---|
| `npm run serve` | 상주 실행: 텔레그램 봇 + 웹 UI(:4321) + MCP HTTP(:4322) + 일정 |
| `npm run cli -- add <url> [--deep] [--memo 메모]` | 대기열에 추가 |
| `npm run cli -- capture` / `process` / `reflect` / `run` | 단계별 또는 전 단계 즉시 실행 |
| `npm run cli -- index` | 색인 재생성 (`rm data/index.db` 후 실행해도 완전 복원) |
| `npm run cli -- verify` | 스키마·출처 링크·깨진 링크·raw 불변 검사 |
| `npm run cli -- retry [--waiting]` | 실패(와 보류) 항목 재시도 |
| `npm run login` | 자동화 브라우저에서 X·LinkedIn 로그인 (Threads는 공개 글을 로그인 없이 받음. 필요하면 `-- --threads`) |
| `npm run mcp` | MCP stdio 모드 (같은 기기의 에이전트용) |
| `npm run imgur:auth [-- --check \| --test-upload]` | Imgur refresh token 발급·확인 |

## 일정 (맥미니 로컬 시각)
| 시각 | 작업 | 실행 주체 |
|---|---|---|
| 수시 | 새 URL 수집 직후 분류·증류·노트 생성까지 즉시 처리 | 스크립트 |
| 12:00 · 19:00 · 02:00 | 누락·밀린 항목 분류 + reduce 복구 배치 | Ollama → agy → Codex → Claude |
| 03:30 | reflect + reweave (증분) | Claude (한도면 다음 날로) |
| 08:00 | 일일 상태 + 최근 3일 품질 진단 알림 (텔레그램) | 스크립트 |
| 08:10 | 로그인 대기 항목 재시도 | 스크립트 |

## 수집 방법
- **텔레그램**: 봇에 URL 전송. 여러 개 가능. 앞에 `!`를 붙이면 "깊게". URL 외 텍스트는 메모. 아이폰은 공유 시트 → 텔레그램.
- **파일**: PDF, Web Clipper로 "파일로 저장"한 `.md`, `.html`을 봇에 보낸다(20MB 이하). 캡션에 `!`를 붙이면 깊게.
- **웹 UI**: 홈 상단 입력칸.
- **MCP**: `capture_url` 도구.

## MCP 연결 (Tailscale 안에서)
```bash
# 회사 노트북·맥미니의 Claude Code
claude mcp add --transport http knowledge http://<맥미니-tailscale-ip>:4322/mcp --header "Authorization: Bearer <MCP_TOKEN>"
# 맥미니 로컬(stdio)
claude mcp add knowledge -- node /path/to/pipeline/src/cli.ts mcp
```
도구: `search`, `get_note`, `get_source`, `list_topics`, `get_backlinks`, `list_recent`, `capture_url`, `promote`, `status`

## 맥미니 설치
```bash
git clone <pipeline 저장소> && cd pipeline
./scripts/setup-macmini.sh     # 의존성·Ollama 모델·launchd 등록
npm run login                  # 자동화 브라우저 로그인
vi .env                        # 텔레그램 토큰, HOST=Tailscale IP, MCP_TOKEN
./scripts/connect-github.sh    # (선택) knowledge·assets 비공개 저장소 생성·연결
```
비밀값(텔레그램 토큰, Imgur, MCP 토큰)은 `.env`에만 둔다. `.env`는 git에 올라가지 않는다.

## Imgur 연결 (선택)
이미지를 문서 안에서 Imgur URL로 보여 주려면 계정 연결 토큰이 필요하다. 없으면 이미지는 맥미니에 저장되고 웹 UI에서만 보인다.
1. https://imgur.com/account/settings/apps 에서 앱의 **Authorization callback URL**을 `http://localhost:8765/imgur/callback` 으로 바꾼다.
2. 같은 화면의 Client ID와 Client Secret(없으면 "generate new secret")을 `.env`의 `IMGUR_CLIENT_ID`, `IMGUR_CLIENT_SECRET`에 **직접** 넣는다.
3. 맥미니에서 `npm run imgur:auth` 를 실행한다. 브라우저가 열리면 Allow를 누른다. refresh token은 `.env`에 바로 저장되고 화면에는 출력되지 않는다.
4. `npm run imgur:auth -- --test-upload` 로 확인한다. 작은 테스트 이미지를 올렸다가 바로 지운다.
5. 서비스를 재시작한다: `launchctl kickstart -k gui/$(id -u)/com.hm.info-pipeline`

`npm run imgur:auth -- --check` 는 저장된 토큰이 아직 유효한지만 확인한다. 브라우저 콜백이 localhost라서 **스크립트와 브라우저가 같은 기기**에 있어야 한다(맥미니 화면 또는 화면 공유로 실행).

## 설계 원칙 (요약)
- 정본은 Markdown. DB·UI는 파생물이라 지워도 복원된다.
- git에 쓰는 것은 맥미니 파이프라인 하나. MCP·웹·봇은 대기열에만 넣는다.
- LLM은 JSON만 돌려주고 파일은 코드가 쓴다. 어떤 모델이든 같은 검증을 거친다.
- 사용량 제한은 실패가 아니라 "보류". 다음 프로바이더로 넘기거나 다음 실행으로 미룬다.
- `raw/`는 불변. 주제 지도의 모든 목록 줄은 노트 링크를 가진다.

## 운영 품질 대시보드

`/ops`에서 최근 3일 수집 성공률, 부분 저장률, 플랫폼별 실패·보류, 생성 원자 노트 수, 증류 provider, 검증 문제와 자동 개선 제안을 확인합니다. 08:00 일일 상태 알림에도 핵심 품질 지표와 우선 진단 1건이 포함됩니다.

운영 화면 `/ops`에서 MCP 상태와 연결 방법, 외부/로컬 주소, Claude Code 등록 명령을 확인할 수 있습니다. 토큰 값은 화면에 노출하지 않습니다.
