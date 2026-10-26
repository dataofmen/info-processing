/**
 * 증류 테스트가 LLM CLI 대신 넣는 고정 JSON.
 * parseJson 을 거치도록 펜스로 감싸서 돌려준다.
 */

export type LlmCall = { stage: string; title: string };

export const llmCalls: LlmCall[] = [];

export const DROPPED_CLAIM = '이 문장은 가벼운 등급이라 저장되면 안 된다.';

export function resetLlmCalls() {
  llmCalls.length = 0;
}

const titleOf = (prompt: string) => prompt.match(/^제목: (.*)$/m)?.[1]?.trim() || '';

function fence(value: unknown): string {
  return `설명은 무시하세요.\n\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``;
}

function reflectValue(prompt: string) {
  const claimBlock = prompt.split('## 새 참고 자료')[0] || '';
  const claims = [...claimBlock.matchAll(/^### (.+)$/gm)].map((m) => m[1].trim()).filter(Boolean);
  const lightBlock = (prompt.split('## 새 참고 자료')[1] || '').split('## 기존 주제')[0] || '';
  const lights = [...lightBlock.matchAll(/^- ([^|\n]+?)\s+\|/gm)].map((m) => m[1].trim()).filter(Boolean);
  if (!claims.length) throw new Error('fixture reflect: 프롬프트에서 원자 노트를 찾지 못했다');
  const [a, b] = claims;
  const overview = [
    `[[${a}]]가 정답률보다 실패 유형을 먼저 보라고 말한다.`,
    b ? `[[${b}#기준]]는 채점 기준의 공개를 다룬다.` : '',
    '[[없는 노트]]는 지운다.',
    '[[없는 노트#절|빠진 절]]도 지운다.',
  ]
    .filter(Boolean)
    .join(' ');
  return {
    topics: [
      {
        title: 'LLM 평가',
        description: '실패 유형을 먼저 보는 평가',
        overview,
        notes: claims.map((note) => ({ note, line: '이 주장을 주제 지도에 둔다' })),
        refs: lights.map((source) => ({ source, line: '가볍게 저장한 참고' })),
      },
    ],
    related: b ? [{ note: a, related: [b, '없는 노트'] }] : [],
  };
}

export function llmText(prompt: string): string {
  if (prompt.includes('개인 지식 저장소의 분류기')) {
    const title = titleOf(prompt);
    llmCalls.push({ stage: 'triage', title });
    const tier = title.includes('체크리스트') ? 'light' : 'deep';
    const reason = tier === 'light' ? '참고할 절차이지만 따로 떼어 둘 주장은 없다' : '재사용할 주장과 근거가 본문에 있다';
    return fence({ tier, reason });
  }

  if (prompt.includes('개인 지식 저장소의 증류기')) {
    const title = titleOf(prompt);
    llmCalls.push({ stage: 'reduce', title });
    const deep = prompt.includes('원자 노트 1~5개');
    // The PDF branch of the prompt does not repeat the extractor name. It adds the page-number instructions.
    if (prompt.includes('PDF에서 추출한 제목')) {
      return fence({
        title: '실무에서의 평가 실패',
        summary: [
          '정답률만 보면 회귀가 숨는다.',
          '표 2는 점수 대신 실패 구성의 변화를 보여 준다.',
          '부호는 원문과 대조해야 한다.',
        ],
        why_saved: '수치를 원문과 대조하려고',
        quotes: [{ text: 'Accuracy alone hid the regression.', gloss: '정답률만 보면 회귀가 숨는다.' }],
        tags: ['LLM 평가', 'PDF'],
        claims: [
          {
            title: '정답률만으로는 회귀를 구분할 수 없다.',
            body: '표 2에서 정답률은 유지됐고 실패 유형의 구성만 바뀌었다 (p.2). 증감의 부호는 원본 PDF와 대조해야 한다.',
            verify_numbers: true,
          },
        ],
      });
    }
    if (!deep) {
      const clipper = title.includes('클리퍼');
      return fence({
        summary: clipper
          ? ['용어는 한국어를 먼저 쓰고 영어를 괄호에 둔다.', '클리퍼 파일은 브라우저 추출이 아니다.', '참고만 하고 원자 노트는 만들지 않는다.']
          : ['배포 전에 실패 유형을 적는다.', '점수판이 그대로여도 구성이 바뀌었는지 본다.', '체크리스트로만 보관한다.'],
        why_saved: clipper ? '표기를 맞춰 두려고' : '배포 전 점검 목록',
        quotes: [{ text: 'Write the failure mode before the score.', gloss: '점수보다 먼저 실패 유형을 적는다.' }],
        tags: clipper ? ['용어', '클리퍼'] : ['체크리스트', '배포'],
        claims: [{ title: DROPPED_CLAIM, body: '검증용으로 넣은 문장이다. 가벼운 등급에서는 비워야 한다.' }],
      });
    }
    if (title.includes('짧은')) {
      return fence({
        summary: ['사용자가 깊게를 지정한 짧은 글이다.', '분량 규칙보다 그 지정이 우선한다.', '주장은 하나면 된다.'],
        why_saved: '분량과 무관하게 남기려고',
        quotes: [],
        tags: ['강제 심층'],
        claims: [{ title: '짧은 글도 깊게 지정하면 원자 노트가 된다.', body: '본문이 짧아도 사용자가 깊게를 지정하면 보관만이 되지 않는다. 이 노트는 그 분기를 남긴다.' }],
      });
    }
    return fence({
      summary: ['정답률보다 실패 유형을 먼저 나눈다.', '채점 기준은 공개되어야 나중에 비교할 수 있다.', '한 글에서 주장 두 개만 떼어 낸다.'],
      why_saved: '평가 기준을 원자 노트로 남기려고',
      quotes: [{ text: 'Score the failure,\nnot only the final answer.', gloss: '최종 답만이 아니라 실패를 채점한다.' }],
      tags: ['LLM 평가', '원자 노트', 'rubric design', 'extra one', 'extra two', 'extra three', 'extra four'],
      claims: [
        {
          title: 'LLM 평가는 정답률보다 실패 유형 분류가 먼저다.',
          body: '정확도 하나는 실패가 바뀐 회귀를 숨긴다. 점수를 내기 전에 실패 유형을 적어야 다음 실행과 비교할 수 있다.',
        },
        {
          title: '채점 기준: 공개가 먼저다.',
          body: '기준이 공개되지 않으면 두 실행의 점수 차이를 해석할 수 없다. 기준은 결과 숫자와 따로 보관한다.',
        },
      ],
    });
  }

  if (prompt.includes('개인 지식 저장소의 편집자')) {
    const value = reflectValue(prompt);
    const notes = value.topics[0].notes.length;
    const refs = value.topics[0].refs.length;
    llmCalls.push({ stage: 'reflect', title: `${notes} claims, ${refs} refs` });
    return fence(value);
  }

  throw new Error(`fixture: 알 수 없는 프롬프트\n${prompt.slice(0, 240)}`);
}
