import fs from 'node:fs';
import { config, kpath } from './config.ts';
import { ensureDir, gitCommit, gitInit, writeFile } from './util.ts';

const AGENTS = `# knowledge — 에이전트 입구

개인 지식 저장소. 공개 웹 글·PDF만 들어 있다(사내 정보 없음).
정본은 이 Markdown 파일들이다. 검색 색인·웹 UI·MCP 서버는 여기서 파생된다.

## 구조
| 경로 | 무엇 | 누가 씀 |
|---|---|---|
| \`topics/\` | 주제 지도(MOC). 개요 + 노트 목록 + 참고 자료 | AI(reflect), 새벽 1회 |
| \`notes/*.md\` | 원자 노트. 제목 = 주장 한 문장. 끝에 \`출처: [[id]]\` | AI(reduce) |
| \`notes/sources/<id>.md\` | 출처 노트. 요약·인용·등급(tier)·원자 노트 목록 | AI(reduce) |
| \`raw/YYYY/MM/<id>.raw.md\` | 원문(Defuddle 추출). **불변** | 캡처 스크립트 |
| \`self/\` | 관심사 프로필, 용어집, 방법론 | 사람 승인 |

## 읽는 순서
1. \`topics/\`에서 주제를 찾는다.
2. 주제의 \`[[노트]]\`를 따라 원자 노트를 읽는다.
3. 근거가 필요하면 노트 끝의 \`출처: [[id]]\` → 출처 노트 → \`raw/\` 원문.

## 규칙
- 원자 노트는 AI가 증류한 것이다. 중요한 주장은 원문으로 확인하고, 답할 때 원문 URL을 밝힌다.
- 이 저장소에 직접 쓰지 않는다. 수집·등급 변경은 MCP 도구(\`capture_url\`, \`promote\`)로 대기열에 넣는다.
- 등급: deep(원자 노트까지) · light(출처 노트만, 주제의 참고 자료) · archive(원문만).
`;

const METHOD = `# 방법론 (arscontexta 6R 기반)

1. Record — 텔레그램/MCP/웹으로 URL을 받아 원문을 raw/에 그대로 저장
2. Reduce — 글 하나에서 원자 노트(한 파일 한 생각)와 출처 노트를 뽑는다
3. Reflect — 새 노트를 주제 지도(MOC)에 엮는다
4. Reweave — 새 노트와 기존 노트 사이에 관련 링크를 양방향으로 건다
5. Verify — 스키마·출처 링크·깨진 링크·raw 불변을 스크립트로 검사
6. Rethink — (2차) 주기적으로 주제 구조를 다시 본다

LLM은 JSON만 돌려주고 파일은 코드가 쓴다. 그래서 어떤 모델을 쓰든 같은 형식과 검증을 거친다.
`;

const GLOSSARY = `# 용어집

표기를 고정한다. 처음 나올 때 한국어(영어) 병기, 이후 이 표기를 쓴다.

| 표기 | 영어 | 메모 |
|---|---|---|
| 에이전트 | agent | "에이전틱"은 형용사로만 |
| 검색 증강 생성(RAG) | retrieval-augmented generation | |
| 대규모 언어 모델(LLM) | large language model | 두 번째부터 LLM |
`;

const INTERESTS = ``; // 클립 200건 시점에 AI가 제안 → 사람이 승인 후 채운다

export function initKnowledge() {
  gitInit(config.knowledgeDir);
  for (const d of ['raw', 'notes/sources', 'topics', 'self', 'ops']) ensureDir(kpath(d));
  const put = (rel: string, s: string) => {
    if (!fs.existsSync(kpath(rel))) writeFile(kpath(rel), s);
  };
  put('AGENTS.md', AGENTS);
  put('CLAUDE.md', 'AGENTS.md를 먼저 읽는다.\n');
  put('self/methodology.md', METHOD);
  put('self/glossary.md', GLOSSARY);
  put('.gitignore', '.obsidian/workspace*\n.DS_Store\n');
  if (INTERESTS) put('self/interests.md', INTERESTS);
  ensureDir(config.assetsDir);
  gitInit(config.assetsDir);
  gitCommit(config.knowledgeDir, 'init: knowledge scaffold');
}
