// v0.1 편집기가 아는 문서 구조 (스펙 §3.2)
import { Schema } from 'prosemirror-model';

export const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: {
      group: 'block', content: 'inline*', toDOM: () => ['p', 0],
      // ignore 규칙은 어느 노드에 달아도 스키마 전체에 적용된다 — 워드 <o:p> 와
      // 목록 흉내용 <span style="mso-list:Ignore">-</span> 는 문단 안 어디서든 나온다.
      // 표 셀(inline* 만 허용) 안의 <p> 는 워드·구글 문서가 항상 넣는 습관이다.
      // getAttrs 가 false 를 돌려주면 이 규칙은 "매치 안 함" 취급되고, 매치되는
      // 다른 규칙이 없으면 ProseMirror 는 <p> 를 투명하게 보고 안의 글자만
      // 현재 문맥(셀의 inline*)에 흡수시킨다 — node 를 아예 안 만든다.
      parseDOM: [
        { tag: 'p', getAttrs: (dom) => (/^(TD|TH)$/.test(dom.parentElement?.tagName) ? false : null) },
        { tag: 'o\\:p', ignore: true },
        // 브라우저가 mso-list 를 모르는 CSS 속성으로 버려서 dom.style 로는 못 잡는다
        // (style 규칙은 파싱된 CSSOM 기준) — 속성값 문자열을 그대로 보는 태그 선택자로 잡는다.
        { tag: '[style*="mso-list"]', ignore: true },
      ],
    },
    heading: {
      group: 'block', content: 'inline*', attrs: { level: { default: 1 } }, defining: true,
      toDOM: (n) => ['h' + Math.min(n.attrs.level, 6), 0],
      parseDOM: [1, 2, 3, 4, 5, 6].map((level) => ({ tag: 'h' + level, attrs: { level } })),
    },
    blockquote: {
      group: 'block', content: 'block+', defining: true, toDOM: () => ['blockquote', 0],
      parseDOM: [{ tag: 'blockquote' }],
    },
    code_block: {
      group: 'block', content: 'text*', marks: '', code: true, defining: true,
      attrs: { lang: { default: null }, meta: { default: null } },
      toDOM: (n) => ['pre', ['code', { 'data-lang': n.attrs.lang || '' }, 0]],
      parseDOM: [{ tag: 'pre', preserveWhitespace: 'full' }],
    },
    hr: { group: 'block', toDOM: () => ['hr'], parseDOM: [{ tag: 'hr' }] },
    list: {
      group: 'block', content: 'list_item+',
      attrs: { ordered: { default: false }, start: { default: 1 }, spread: { default: false } },
      toDOM: (n) => (n.attrs.ordered ? ['ol', { start: n.attrs.start }, 0] : ['ul', 0]),
      parseDOM: [
        { tag: 'ul', attrs: { ordered: false } },
        { tag: 'ol', getAttrs: (dom) => ({ ordered: true, start: Number(dom.getAttribute('start')) || 1 }) },
      ],
    },
    list_item: {
      content: 'block+',
      attrs: { checked: { default: null }, spread: { default: false } },
      toDOM: (n) => ['li', n.attrs.checked === null ? {} : { 'data-checked': String(n.attrs.checked) }, 0],
      parseDOM: [{ tag: 'li' }],
    },
    table: {
      group: 'block', content: 'table_row+', attrs: { align: { default: null } },
      toDOM: () => ['table', ['tbody', 0]],
      parseDOM: [{ tag: 'table' }],
    },
    table_row: { content: 'table_cell+', toDOM: () => ['tr', 0], parseDOM: [{ tag: 'tr' }] },
    table_cell: {
      content: 'inline*', isolating: true, toDOM: () => ['td', 0],
      parseDOM: [{ tag: 'td' }, { tag: 'th' }],
    },

    // ── 손대지 않는 덩어리 (스펙 §2.3) ─────────────────
    raw: {
      group: 'block', atom: true, isolating: true, selectable: true,
      attrs: { value: { default: '' } },
      toDOM: (n) => ['div', { class: 'raw-block', contenteditable: 'false' }, n.attrs.value],
    },
    raw_inline: {
      group: 'inline', inline: true, atom: true, selectable: true,
      attrs: { value: { default: '' } },
      toDOM: (n) => ['span', { class: 'raw-inline', contenteditable: 'false' }, n.attrs.value],
    },

    image: {
      group: 'inline', inline: true, atom: true,
      attrs: { src: {}, alt: { default: null }, title: { default: null } },
      toDOM: (n) => ['img', { src: n.attrs.src, alt: n.attrs.alt || '', title: n.attrs.title || '' }],
      parseDOM: [{
        tag: 'img[src]',
        getAttrs: (dom) => ({ src: dom.getAttribute('src'), alt: dom.getAttribute('alt'), title: dom.getAttribute('title') }),
      }],
    },
    hard_break: {
      group: 'inline', inline: true, selectable: false, toDOM: () => ['br'],
      parseDOM: [{ tag: 'br' }],
    },
    text: { group: 'inline' },
  },
  marks: {
    link: {
      attrs: { href: {}, title: { default: null } },
      toDOM: (m) => ['a', { href: m.attrs.href, title: m.attrs.title || '' }, 0],
      parseDOM: [{
        tag: 'a[href]',
        getAttrs: (dom) => ({ href: dom.getAttribute('href'), title: dom.getAttribute('title') }),
      }],
    },
    // 아래 규칙들은 prosemirror-schema-basic 을 그대로 따른다.
    // (구글 문서가 전체를 <b style="font-weight:normal">로 감싸는 습관이 있어
    //  font-weight 값을 실제로 확인해야 한다 — 태그만 보면 안 된다)
    strong: {
      toDOM: () => ['strong', 0],
      parseDOM: [
        { tag: 'strong' },
        { tag: 'b', getAttrs: (dom) => dom.style.fontWeight !== 'normal' && null },
        { style: 'font-weight', getAttrs: (value) => /^(bold(er)?|[5-9]\d{2,})$/.test(value) && null },
      ],
    },
    em: {
      toDOM: () => ['em', 0],
      parseDOM: [{ tag: 'i' }, { tag: 'em' }, { style: 'font-style=italic' }],
    },
    strike: {
      toDOM: () => ['s', 0],
      parseDOM: [{ tag: 's' }, { tag: 'del' }, { tag: 'strike' }],
    },
    code: { toDOM: () => ['code', 0], parseDOM: [{ tag: 'code' }] },
    // T3 (WEEK3 §4) — mdast 에 대응 노드가 없어 <u> 태그를 convert.js 에서
    // 직접 읽고 쓴다 (raw 로 얼리지 않고 진짜 마크로).
    underline: { toDOM: () => ['u', 0], parseDOM: [{ tag: 'u' }] },
  },
});

// 되돌릴 때 감싸는 순서 (바깥 → 안).
// underline 은 끝(가장 안쪽)에 둔다 — <u> 직렬화는 strong/em 같은 이스케이프
// 충돌 처리(문장부호 인접 시 escape)가 없는 단순 감싸기라서, 다른 마크의
// 델리미터( * ~ ` ) 바로 옆에 <u> 태그 경계가 오는 상황을 피하려는 것이다.
export const MARK_ORDER = ['link', 'strong', 'em', 'strike', 'code', 'underline'];
