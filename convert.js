// mdast <-> ProseMirror 변환. 이게 v0.1의 실제 작업량이다.
import { schema, MARK_ORDER } from './schema.js';

export const BLOCK_KNOWN = new Set(['heading','paragraph','blockquote','code','thematicBreak','list','table']);
const INLINE_KNOWN = new Set(['text','strong','emphasis','delete','inlineCode','link','image','break']);

const slice = (src, n) => src.slice(n.position.start.offset, n.position.end.offset);

// ── mdast → ProseMirror ────────────────────────────────
// remark 는 raw 인라인 HTML 을 계층 없이 flat 하게 내놓는다 — <u>a</u> 는
// html('<u>') · text('a') · html('</u>') 세 형제 노드다 (mdast 에 underline
// 대응 노드가 없어서, §4). 짝이 맞는 <u>…</u> 쌍을 찾아 그 사이를
// underline 마크로 묶는다. 짝이 안 맞으면(중첩·미완성) 지금처럼 raw_inline 이다.
const isUOpen = (n) => n.type === 'html' && n.value.trim() === '<u>';
const isUClose = (n) => n.type === 'html' && n.value.trim() === '</u>';

function inlines(nodes, src, marks = []) {
  const out = [];
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    if (isUOpen(n)) {
      const close = nodes.findIndex((m, j) => j > i && isUClose(m));
      if (close !== -1) {
        out.push(...inlines(nodes.slice(i + 1, close), src, marks.concat(schema.marks.underline.create())));
        i = close;
        continue;
      }
    }
    switch (n.type) {
      case 'text':       out.push(schema.text(n.value, marks)); break;
      case 'strong':     out.push(...inlines(n.children, src, marks.concat(schema.marks.strong.create()))); break;
      case 'emphasis':   out.push(...inlines(n.children, src, marks.concat(schema.marks.em.create()))); break;
      case 'delete':     out.push(...inlines(n.children, src, marks.concat(schema.marks.strike.create()))); break;
      case 'inlineCode': out.push(schema.text(n.value, marks.concat(schema.marks.code.create()))); break;
      case 'link':       out.push(...inlines(n.children, src, marks.concat(
                           schema.marks.link.create({ href: n.url, title: n.title ?? null })))); break;
      case 'image':      out.push(schema.nodes.image.create({ src: n.url, alt: n.alt ?? null, title: n.title ?? null }, null, marks)); break;
      case 'break':      out.push(schema.nodes.hard_break.create(null, null, marks)); break;
      default:           out.push(schema.nodes.raw_inline.create({ value: slice(src, n) }, null, marks));  // 모르는 것은 통째 보존
    }
  }
  return out;
}

function block(n, src) {
  const N = schema.nodes;
  switch (n.type) {
    case 'paragraph':     return N.paragraph.create(null, inlines(n.children, src));
    case 'heading':       return N.heading.create({ level: n.depth }, inlines(n.children, src));
    case 'blockquote':    return N.blockquote.create(null, n.children.map((c) => block(c, src)));
    case 'code':          return N.code_block.create({ lang: n.lang ?? null, meta: n.meta ?? null },
                                 n.value ? schema.text(n.value) : null);
    case 'thematicBreak': return N.hr.create();
    case 'list':          return N.list.create(
                            { ordered: !!n.ordered, start: n.start ?? 1, spread: !!n.spread },
                            n.children.map((li) => N.list_item.create(
                              { checked: li.checked ?? null, spread: !!li.spread },
                              li.children.map((c) => block(c, src)))));
    case 'table':         return N.table.create({ align: n.align ?? null },
                            n.children.map((row) => N.table_row.create(null,
                              row.children.map((cell) => N.table_cell.create(null, inlines(cell.children, src))))));
    default:              return N.raw.create({ value: slice(src, n) });   // 모르는 것은 통째 보존
  }
}

export function toPM(tree, src) {
  return schema.nodes.doc.create(null, tree.children.map((n) => block(n, src)));
}

// ── ProseMirror → mdast ────────────────────────────────
const markName = (m) => m.type.name;

function unInlines(frag) {
  // 같은 마크를 가진 연속 구간을 묶어 다시 중첩시킨다
  const items = [];
  frag.forEach((n) => items.push(n));

  function build(list, applied) {
    const out = [];
    let i = 0;
    while (i < list.length) {
      const n = list[i];
      const marks = n.isText || n.type.name === 'image' || n.type.name === 'raw_inline' || n.type.name === 'hard_break'
        ? n.marks.map(markName).filter((m) => !applied.includes(m)) : [];
      const next = MARK_ORDER.find((m) => marks.includes(m));
      if (!next) {
        if (n.isText) out.push({ type: 'text', value: n.text });
        else if (n.type.name === 'image') out.push({ type: 'image', url: n.attrs.src, alt: n.attrs.alt, title: n.attrs.title });
        else if (n.type.name === 'hard_break') out.push({ type: 'break' });
        else out.push({ type: 'rawInline', value: n.attrs.value });
        i++;
        continue;
      }
      let j = i;
      while (j < list.length && list[j].marks.some((m) => markName(m) === next)) j++;
      const group = list.slice(i, j);
      const inner = build(group, applied.concat(next));
      const mk = group[0].marks.find((m) => markName(m) === next);
      if (next === 'code') out.push({ type: 'inlineCode', value: inner.map((x) => x.value ?? '').join('') });
      else if (next === 'link') out.push({ type: 'link', url: mk.attrs.href, title: mk.attrs.title, children: inner });
      else if (next === 'underline') out.push({ type: 'underline', children: inner });
      else out.push({ type: next === 'strong' ? 'strong' : next === 'em' ? 'emphasis' : 'delete', children: inner });
      i = j;
    }
    return out;
  }
  return build(items, []);
}

function unBlock(n) {
  const kids = () => { const a = []; n.forEach((c) => a.push(unBlock(c))); return a; };
  switch (n.type.name) {
    case 'paragraph':  return { type: 'paragraph', children: unInlines(n.content) };
    case 'heading':    return { type: 'heading', depth: n.attrs.level, children: unInlines(n.content) };
    case 'blockquote': return { type: 'blockquote', children: kids() };
    case 'code_block': return { type: 'code', lang: n.attrs.lang, meta: n.attrs.meta, value: n.textContent };
    case 'hr':         return { type: 'thematicBreak' };
    case 'list': {
      const items = [];
      n.forEach((li) => {
        const c = []; li.forEach((b) => c.push(unBlock(b)));
        items.push({ type: 'listItem', checked: li.attrs.checked, spread: li.attrs.spread, children: c });
      });
      return { type: 'list', ordered: n.attrs.ordered, start: n.attrs.ordered ? n.attrs.start : null,
               spread: n.attrs.spread, children: items };
    }
    case 'table': {
      const rows = [];
      n.forEach((r) => {
        const cells = []; r.forEach((c) => cells.push({ type: 'tableCell', children: unInlines(c.content) }));
        rows.push({ type: 'tableRow', children: cells });
      });
      return { type: 'table', align: n.attrs.align, children: rows };
    }
    default:           return { type: 'raw', value: n.attrs.value };
  }
}

export function fromPM(doc) {
  const children = [];
  doc.forEach((n) => children.push(unBlock(n)));
  return { type: 'root', children };
}
