# Info Processing — 계획 (v1, 2026-09-29)

## 한 줄
어느 기기에서든 텔레그램으로 URL을 보내면, 맥미니가 원문을 그대로 저장하고 AI가 증류해 주제별 지식으로 엮는다. 사람은 웹 UI로, AI는 MCP로 꺼내 쓴다.

## 해결하려는 실패 3가지
| 실패 원인 | 해법 |
|---|---|
| 1. 기기·환경에 구속 | 기기에서 하는 일은 "텔레그램에 URL 보내기" 하나. 나머지는 맥미니가 한다. |
| 2. 원문 클리핑 품질 | Obsidian Web Clipper의 추출 엔진 Defuddle을 맥미니의 로그인된 브라우저(Playwright)에서 실행. |
| 3. 로컬 프로그램·저장소 구속 | 정본은 GitHub의 plain Markdown. DB·UI는 파생물이라 지워도 재색인으로 복원. |

## 결정 기록
| # | 결정 | 이유 |
|---|---|---|
| D1 | 공개 웹 글·PDF만 넣는다. 사내 정보 금지 | 보안 경계. 외부 모델 사용 가능 조건 |
| D2 | 정본 = GitHub 비공개 `knowledge` 저장소. Obsidian은 선택 뷰어 | 기기 독립 |
| D3 | git 쓰기 주체는 맥미니 파이프라인 하나 | 충돌 원천 차단 |
| D4 | 진입점 = 텔레그램 봇(URL·파일·`!`·메모). 무료 | 설치·동기화 불필요 |
| D5 | 추출 = Playwright(자동화 전용 Chrome 프로필, 본인 계정 로그인) + Defuddle. **Threads는 로그인 없이 공개 글만**(2026-10-02: 맥미니에서 로그인 실패, 비로그인으로 실제 글 추출 확인) | 로그인 필요한 글도 원문 그대로 |
| D6 | 3층 구조: `raw/`(불변) → `notes/`(출처·원자 노트) → `topics/`(MOC, 자동 갱신) | 증류 + 연결 |
| D7 | 증류 방법론 = arscontexta의 6R(reduce/reflect/reweave/verify). **플러그인 자체는 실행하지 않고 방법론을 코드로 구현**(2026-09-29 정정). LLM은 JSON만 반환, 파일 쓰기·검증은 코드 | 플러그인은 대화형 세션 전제라 무인 실행·다중 프로바이더와 맞지 않음. 모델이 파일을 직접 못 건드리게 해 안정성 확보 |
| D8 | 단계별 실행 주체 분리(아래 표). 한도 오류는 실패가 아니라 대기 | 사용량 제한 회피 |
| D9 | 3등급 분류: 깊게(~20%)/가볍게(~50%)/보관만(~30%). `!`는 강제 깊게 | 하루 30~40건 규모 |
| D10 | 관심사 프로필은 클립 200건 시점에 AI가 제안 | 처음엔 일반 기준 |
| D11 | 이미지: 원본은 `assets-YYYY`(GitHub) + 맥미니, 문서엔 Imgur URL(OAuth 계정 업로드), `ops/image-map.json`으로 교체 가능 | 어디서나 표시 + 이탈 가능 |
| D12 | 파생 색인 `index.db`(SQLite, FTS5 trigram + 링크 + 임베딩)가 MCP·웹 UI를 함께 받침 | DB 허용, 재생성 가능 |
| D13 | 웹 UI = 읽기 전용 자체 앱(노트·역링크·로컬 그래프·MOC·검색·운영 화면). 언제든 Quartz로 교체 가능 | 단일 작성자 원칙, 의미 검색·운영 화면 필요 |
| D14 | MCP 1차부터. 쓰기 도구는 `ops/` 대기열에만 넣는다. 접근은 Tailscale 전용 | 확장성, 두 번째 작성자 방지 |
| D15 | 텔레그램 질의응답은 2차 | 봇 단순화 |
| D16 | 노트·주제는 한국어, 원문·인용은 원어, 용어집 `self/glossary.md` | 표기 일관성 |
| D17 | 언어 TypeScript 하나(Node ≥22.13, 타입 스트리핑), `pipeline` 저장소는 `knowledge`와 분리 | Defuddle·Playwright·MCP SDK 모두 TS |

## 실행 주체
| 작업 | 1순위 | 대체 |
|---|---|---|
| 캡처·변환·검증·색인 | 스크립트 | — |
| 임베딩 | 로컬 Ollama(bge-m3 등) | Gemini |
| 분류 | 로컬 LLM(PoC) | Gemini |
| reduce | Gemini(Antigravity/Gemini CLI) | Codex → Claude |
| reflect / reweave | Claude(증분, reweave 1회 10개 상한) | 한도 풀릴 때까지 대기 |

## 흐름
```
텔레그램 URL ─▶ ops/queue ─▶ capture(Playwright+Defuddle) ─▶ raw/ + assets + Imgur ─▶ git
                                   ▼
                         triage ─▶ reduce ─▶ verify ─▶ git       (하루 3회)
                                   ▼
                         reflect/reweave(Claude) ─▶ verify ─▶ git (새벽 1회)
                                   ▼
                         indexer ─▶ index.db ─▶ MCP 서버 · 웹 UI (Tailscale)
```

## 저장소 구조 (`knowledge/`)
```
AGENTS.md            에이전트 입구: 구조·읽는 순서
self/                관심사 프로필, 용어집, 방법론
raw/YYYY/MM/<id>.md  원문(불변)
notes/sources/<id>.md   출처 노트(요약·인용·등급)
notes/<slug>.md      원자 노트(주장 한 문장 제목, 출처 링크 필수)
topics/<slug>.md     MOC(주제 지도)
ops/image-map.json   이미지 대응표
```

## 안정성 규칙
- 대기열은 맥미니 로컬 `data/queue/*.json`(knowledge 저장소 밖, 2026-09-29 정정). 상태 `queued → captured → triaged → reduced → reflected` / `failed` / `waiting`(한도). 멱등·재시작 가능.
- 파이프라인 전역 잠금 1개. 단계마다 verify 통과 후에만 commit, 실패 시 되돌림.
- `raw/`는 쓰기 금지(검증기가 수정 감지 시 차단).
- 일일 상태 알림(아무 일 없어도), 주간 주제 변경 요약.
- 비밀값은 키체인/`.env`만. commit 전 비밀값 검사.

## 예외 기본값
중복 URL은 정규화로 판정 · X 본인 스레드는 한 문서 · LinkedIn 접힌 본문 펼침(실패 시 부분 저장) · 동영상은 링크 · 원문 삭제돼도 보존 · 추출 실패 1회 재시도 후 수동 Web Clipper 파일 → 봇 · 큰 PDF는 URL · 봇은 본인 chat ID만.

## 단계와 합격 기준
| 단계 | 합격 기준 |
|---|---|
| 0 PoC | 플랫폼별 원문 충실도 90%↑, Antigravity 헤드리스, FTS5 trigram(✅ 2026-09-29 확인), 임베딩, 분류 일치율, Imgur OAuth |
| 1 캡처 | 2주 연속 URL 유실 0, 자동 성공률 95%↑ |
| 2 색인+MCP | 회사 노트북 Claude Code에서 MCP 검색, DB 삭제→재색인 복원 시연 |
| 3 분류+reduce | verify 100%, 1주 Claude 한도 미도달 |
| 4 reflect | 주제 문장 출처 누락 0, 200건 시점 프로필 제안 |
| 5 웹 UI | 아이폰 검색→노트→원문→이미지 막힘없음 |

"2주 연속" 등 운영 기준은 신뢰 기준이다. 코드는 전 단계를 얇게 먼저 만든다(2026-09-29 결정).

## 사람이 해야 하는 일 (맥미니)
1. 텔레그램 BotFather로 봇 생성 → 토큰을 맥미니 `.env`에만.
2. 자동화 전용 Chrome 프로필로 X·LinkedIn·Threads 로그인 (`npm run login`).
3. GitHub `knowledge`, `assets-2026` 비공개 저장소 생성 승인.
4. Imgur OAuth 1회 승인.
5. Tailscale 로그인(맥미니·아이폰·노트북).
6. (선택) arscontexta setup으로 `self/` 관심사·방법론 초안 받기 — 파이프라인 동작에는 필요 없음.

## 2026-09-29 구현 현황
| 항목 | 상태 |
|---|---|
| 전 단계 코드(캡처·분류·reduce·reflect/reweave·verify·색인·MCP·웹 UI·봇·일정) | 작성, 노트북에서 end-to-end 1회 통과 |
| PoC ② agy 헤드리스 | ✅ (`agy -p`, 분류·reduce 실제 수행) |
| PoC ③ FTS5 trigram 한국어 | ✅ |
| 대체 순서(Gemini 인증 없음 → agy) | ✅ |
| DB 삭제 → 재색인 복원 | ✅ |
| MCP stdio·HTTP 도구 9개 | ✅ |
| PoC ① 플랫폼 충실도(로그인 상태 X·LinkedIn·Threads) | ❌ 미검증 — 맥미니에서. Threads 테스트 URL이 다른 계정 글로 저장된 사례 있음 → 실제 글로 첫 검증 |
| PoC ④ 로컬 임베딩 / ⑤ 로컬 분류 일치율 | ❌ 미검증(이 노트북에 Ollama 없음) |
| PoC ⑥ Imgur OAuth | ❌ 미검증(refresh token 필요) |
| Codex CLI | ❌ 미설치 기기에서 테스트 |
| assets-YYYY 연 1GB 자동 분할 | 미구현(2차) |

## PDF 원칙 (참고: LLM Wiki for Scientists 1부 4장, 2026-09-29 반영)
| 원칙 | 구현 |
|---|---|
| 정본 PDF는 복사 후 고치지 않는다 | `assets/…/source.pdf` 불변, `raw/` 불변 ✅ |
| 추출기는 두 단 순서를 섞고 표·수식·위첨자를 잃는다 | `pdftotext` 읽기 순서 모드(-layout 제거) ✅, 쪽 표시 `<!-- p.N -->` ✅ |
| 어떤 도구로 언제 어떤 인자로 추출했는지 기록 | raw frontmatter `extract_log`(tool·version·args·at·pages) ✅ |
| 결론을 좌우하는 수치·부호·표 비교군은 원문과 대조 | 해당 원자 노트에 `verify: 수치 원문 대조 필요` + 경고 줄, 본문에 (p.N) ✅ |
| DOI | 본문에서 추출해 frontmatter `doi` ✅ |
| 저자-연도-제목 토큰 stem | 2차: 출처 노트에 `stem` 필드(LLM 제안 → 검증) |
| 프리프린트 vs 출판본 정본 판단, 교체 시 stem 유지 | 2차: DOI로 출판본 조회, 교체는 새 raw + 출처 노트 링크 교체 |
| 보충 자료는 저자가 직접 쓴 문장이 있는 것만 | 2차: 봇에 여러 파일을 보낼 때 규칙 적용 |
| 스캔 PDF | `pdftotext:empty` 표시 → 2차: Gemini로 변환 |
