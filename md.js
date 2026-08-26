// 브라우저/노드 공용 마크다운 입출력
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkFrontmatter from 'remark-frontmatter';
import remarkStringify from 'remark-stringify';

// GFM 취소선은 물결 두 개(~~)가 표준이다. 하나짜리(~2~)까지 취소선으로
// 먹으면 아래첨자 표기 H~2~O 가 H~~2~~O 로 바뀌어 뜻이 달라진다.
const GFM = { singleTilde: false };

export const parser = unified().use(remarkParse).use(remarkGfm, GFM).use(remarkFrontmatter, ['yaml']);

const rawWriter = unified().use(remarkGfm, GFM).use(remarkFrontmatter, ['yaml'])
  .use(remarkStringify, {
    bullet: '-', emphasis: '*', strong: '*', fence: '`', fences: true,
    rule: '-', listItemIndent: 'one', resourceLink: false,
    handlers: {
      raw: (n) => n.value, rawInline: (n) => n.value,
      // T3 (§4) — mdast 에 없는 노드라 직접 정의. containerPhrasing 으로 안쪽을
      // 보통 인라인처럼 직렬화한 뒤 <u> 로 감싼다 (strong 처럼 델리미터
      // 충돌 이스케이프를 하지 않는다 — <u> 는 마크다운 구두점이 아니라서 필요 없다).
      underline: (n, _, state) => `<u>${state.containerPhrasing(n, { before: '<u>', after: '</u>' })}</u>`,
    },
  });

// 두 글이 같은 문서를 뜻하는지 판정하는 기준.
// 원본끼리 비교하면 안 된다 — 원본 자체가 재작성 고정점이 아닐 수 있다.
const sig = (text) => rawWriter.stringify(parser.parse(text));

// ── ① 문자 참조 되돌리기 ─────────────────────────────────
// remark 는 `***강조***` 뒤에 글자가 바로 붙으면 그 글자를 `&#x72;` 로 바꾼다.
// CommonMark 의 `*` 규칙상 불필요하고, Markdown Guide 4.3 은 오히려
// 이 형태(`super***important***word`)를 권장한다.
// 강조 기호에 "바로 붙은" 것만 겨냥한다 — 표 안 `&#124;` 는 진짜 필요하다.
const REF = String.raw`&#(?:x[0-9A-Fa-f]+|\d+);`;
const REF_BY_EMPHASIS = new RegExp(`(?<=[*_])${REF}|${REF}(?=[*_])`, 'g');
const isLetterOrDigit = (cp) => /[\p{L}\p{N}]/u.test(String.fromCodePoint(cp));

function decodeRefs(text) {
  if (!text.includes('&#')) return text;
  const out = text.replace(REF_BY_EMPHASIS, (m) => {
    const hex = /^&#x/i.test(m);
    const cp = parseInt(m.slice(hex ? 3 : 2, -1), hex ? 16 : 10);
    return isLetterOrDigit(cp) ? String.fromCodePoint(cp) : m;
  });
  if (out === text) return text;
  return sig(out) === sig(text) ? out : text;
}

// ── ② 불필요한 escape 떼기 ──────────────────────────────
// remark 는 모르는 "문장 안" 문법을 글자로 보고 escape 한다.
//   [[위키링크]]  → \[\[위키링크]]    Obsidian 에서 링크가 깨진다
//   > [!NOTE]     → > \[!NOTE]       GitHub 알림 상자가 안 뜬다
//   #태그         → \#태그
//   H~2~O         → H\~2\~O          아래첨자 표기
//   ==강조==      → \==강조==        Obsidian 형광펜
//   $x_1$         → $x\_1$           수식
// 이 escape 는 대부분 불필요하다. 붙이든 떼든 파싱 결과가 같기 때문이다.
// 그래서 "떼도 문서가 같으면 뗀다".
//
// escape 는 그 줄 안에서만 뜻을 바꾸므로 줄 단위로 확인한다.
// 앞뒤 한 줄을 붙이는 것은 줄 경계 효과(`===` 가 setext 제목 밑줄이 되는 것)
// 까지 보기 위해서다. 문서 전체를 매번 다시 파싱하면 5천 줄에서 수십 초가 걸린다.
// 마크다운이 escape 대상으로 삼는 ASCII 구두점만 뗀다.
// `\alpha` 처럼 글자 앞의 백슬래시는 escape 가 아니라 내용이다 (LaTeX 명령).
// 이걸 구분하지 않으면 수식 한 줄이 통째로 판정에서 떨어진다.
const ESC = /\\([!"#$%&'()*+,\-./:;<=>?@[\]^_`{|}~\\])/g;

function unescapeSafely(text) {
  if (!text.includes('\\')) return text;

  const lines = text.split('\n');
  const skip = markSkippable(lines);
  let changed = false;

  const out = lines.map((line, i) => {
    if (skip[i] || !line.includes('\\')) return line;
    const bare = line.replace(ESC, '$1');
    if (bare === line) return line;
    const ctx = (mid) => [lines[i - 1] || '', mid, lines[i + 1] || ''].join('\n');
    if (sig(ctx(bare)) !== sig(ctx(line))) return line;   // 이 줄은 escape 가 필요하다
    changed = true;
    return bare;
  });

  return changed ? out.join('\n') : text;
}

// 코드 블록·frontmatter 안의 백슬래시는 글자 그대로여야 한다.
// (`const s = "a\\nb";` 의 백슬래시를 떼면 코드가 깨진다)
// 이 안쪽은 애초에 escape 가 붙지 않으므로 건드릴 이유도 없다.
function markSkippable(lines) {
  const skip = new Array(lines.length).fill(false);
  let fence = null;
  let inFrontmatter = lines[0] === '---';
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (inFrontmatter) {
      skip[i] = true;
      if (i > 0 && line === '---') inFrontmatter = false;
      continue;
    }
    const open = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (fence) {
      skip[i] = true;
      if (open && open[1][0] === fence[0] && open[1].length >= fence.length) fence = null;
    } else if (open) {
      skip[i] = true;
      fence = open[1];
    } else if (/^(?: {4,}|\t)/.test(line)) {
      skip[i] = true;                                     // 들여쓰기 코드 블록
    }
  }
  return skip;
}

export const writer = {
  stringify(tree) {
    return unescapeSafely(decodeRefs(rawWriter.stringify(tree)));
  },
};
