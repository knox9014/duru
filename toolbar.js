// 워드 느낌 리본 툴바 (WEEK2A §2)
// 스키마가 이미 아는 것만 만든다 — 새 노드·마크 없음.
import { toggleMark, setBlockType, wrapIn, lift } from 'prosemirror-commands';
import { wrapRangeInList, liftListItem } from 'prosemirror-schema-list';
import { TextSelection } from 'prosemirror-state';
import { schema } from './schema.js';
import { insertTable } from './table.js';
import { insertImageFromPicker } from './image.js';
import { t } from './i18n.js';

const { nodes, marks } = schema;

const HEADING_LEVELS = [1, 2, 3, 4, 5, 6];

// ── 상태 판정 ────────────────────────────────────────────
function isMarkActive(state, markType) {
  const { from, to, empty, $from } = state.selection;
  if (empty) return !!markType.isInSet(state.storedMarks || $from.marks());
  return state.doc.rangeHasMark(from, to, markType);
}

// 커서 위치를 감싸는 가장 가까운 list_item / list
function listContext($pos) {
  for (let d = $pos.depth; d > 0; d--) {
    if ($pos.node(d).type === nodes.list_item) return { item: $pos.node(d), list: $pos.node(d - 1) };
  }
  return null;
}

function isListActive(state, kind) {
  const ctx = listContext(state.selection.$from);
  if (!ctx) return false;
  if (kind === 'todo') return ctx.item.attrs.checked !== null;
  if (ctx.item.attrs.checked !== null) return false;
  return ctx.list.attrs.ordered === (kind === 'ordered');
}

function isQuoteActive(state) {
  for (let d = state.selection.$from.depth; d > 0; d--) {
    if (state.selection.$from.node(d).type === nodes.blockquote) return true;
  }
  return false;
}

// 드롭다운에 표시할 현재 블록 종류. 코드 블록을 '본문'이라고
// 표시하면 거짓말이 되고, 거기서 제목으로 바꾸면 코드가 깨진다.
function currentBlockType(state) {
  const node = state.selection.$from.parent;
  if (node.type === nodes.heading) return String(node.attrs.level);
  if (node.type === nodes.code_block) return 'code';
  return '0';
}

// ── 목록 토글 (2.2 — 우리 스키마는 list/list_item, wrapInList 에 attrs 로 전달) ──
function toggleList(kind) {
  const ordered = kind === 'ordered';
  return (state, dispatch) => {
    const { $from, $to } = state.selection;
    const ctx = listContext($from);

    if (ctx && isListActive(state, kind)) return liftListItem(nodes.list_item)(state, dispatch);

    if (ctx) {
      // 다른 종류 목록 위 → 감싼 list 와 그 안 항목들의 속성만 바꿔치기
      let listPos = -1, listNode = null;
      for (let d = $from.depth; d > 0; d--) {
        if ($from.node(d).type === nodes.list) { listPos = $from.before(d); listNode = $from.node(d); break; }
      }
      if (dispatch) {
        const tr = state.tr;
        tr.setNodeMarkup(listPos, undefined, { ...listNode.attrs, ordered });
        listNode.forEach((item, offset) => {
          tr.setNodeMarkup(listPos + 1 + offset, undefined, { ...item.attrs, checked: kind === 'todo' ? false : null });
        });
        dispatch(tr);
      }
      return true;
    }

    const range = $from.blockRange($to);
    if (!range) return false;
    const tr = state.tr;
    if (!wrapRangeInList(tr, range, nodes.list, { ordered })) return false;
    if (kind === 'todo') {
      tr.doc.nodesBetween(tr.mapping.map(range.start), tr.mapping.map(range.end), (node, pos) => {
        if (node.type === nodes.list_item) tr.setNodeMarkup(pos, undefined, { ...node.attrs, checked: false });
      });
    }
    if (dispatch) dispatch(tr.scrollIntoView());
    return true;
  };
}

function toggleQuote(state, dispatch) {
  return isQuoteActive(state) ? lift(state, dispatch) : wrapIn(nodes.blockquote)(state, dispatch);
}

// ── 아이콘 (이모지 대신 인라인 SVG, 16px stroke) ────────────
const ICONS = {
  bullet: '<svg width="16" height="16" viewBox="0 0 16 16"><circle cx="2.5" cy="4" r="1.3" fill="currentColor"/><circle cx="2.5" cy="8" r="1.3" fill="currentColor"/><circle cx="2.5" cy="12" r="1.3" fill="currentColor"/><path d="M6 4h8M6 8h8M6 12h8" stroke="currentColor" stroke-width="1.4" fill="none"/></svg>',
  ordered: '<svg width="16" height="16" viewBox="0 0 16 16"><text x="0" y="5.5" font-size="5" fill="currentColor">1</text><text x="0" y="9.5" font-size="5" fill="currentColor">2</text><text x="0" y="13.5" font-size="5" fill="currentColor">3</text><path d="M6 4h8M6 8h8M6 12h8" stroke="currentColor" stroke-width="1.4" fill="none"/></svg>',
  todo: '<svg width="16" height="16" viewBox="0 0 16 16"><rect x="1.5" y="2.5" width="6" height="6" rx="1" stroke="currentColor" stroke-width="1.4" fill="none"/><path d="M2.8 5.5l1.2 1.2 2-2.4" stroke="currentColor" stroke-width="1.4" fill="none"/><path d="M10 5h5" stroke="currentColor" stroke-width="1.4"/><rect x="1.5" y="10.5" width="6" height="0" stroke="none"/><rect x="1.5" y="9.5" width="6" height="6" rx="1" stroke="currentColor" stroke-width="1.4" fill="none"/><path d="M10 12.5h5" stroke="currentColor" stroke-width="1.4"/></svg>',
  rule: '<svg width="16" height="16" viewBox="0 0 16 16"><path d="M2 8h12" stroke="currentColor" stroke-width="1.6"/></svg>',
  quote: '<svg width="16" height="16" viewBox="0 0 16 16"><path d="M3 4h10M3 8h10M3 12h6" stroke="currentColor" stroke-width="1.4"/><path d="M3 3v10" stroke="currentColor" stroke-width="2.2"/></svg>',
  link: '<svg width="16" height="16" viewBox="0 0 16 16"><path d="M6.5 9.5l3-3" stroke="currentColor" stroke-width="1.4"/><path d="M7 4.5l1-1a2.6 2.6 0 013.7 3.7l-1 1M9 11.5l-1 1a2.6 2.6 0 01-3.7-3.7l1-1" stroke="currentColor" stroke-width="1.4" fill="none"/></svg>',
  code: '<svg width="16" height="16" viewBox="0 0 16 16"><path d="M5.5 4L2 8l3.5 4M10.5 4L14 8l-3.5 4" stroke="currentColor" stroke-width="1.4" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  table: '<svg width="16" height="16" viewBox="0 0 16 16"><rect x="1.5" y="2.5" width="13" height="11" rx="1" stroke="currentColor" stroke-width="1.3" fill="none"/><path d="M1.5 6.3h13M1.5 10h13M5.7 2.5v11M10.3 2.5v11" stroke="currentColor" stroke-width="1.1"/></svg>',
  image: '<svg width="16" height="16" viewBox="0 0 16 16"><rect x="1.5" y="2.5" width="13" height="11" rx="1" stroke="currentColor" stroke-width="1.3" fill="none"/><circle cx="5" cy="6" r="1.4" fill="currentColor"/><path d="M2.5 11.5l3.5-3.5 2.5 2.5 2-2 2.5 2.5" stroke="currentColor" stroke-width="1.3" fill="none" stroke-linejoin="round"/></svg>',
};

const TABLE_GRID_SIZE = 8;

// 표 크기 고르기 그리드 (WEEK3 §2.1) — 최대 8x8, 그 이상은 만든 뒤 행·열 추가로.
// 만들어지는 표는 항상 머리행 1줄 + 본문 1줄 이상이어야 하므로 행은 최소 2로 고정한다.
function createTablePicker(onPick) {
  const wrap = document.createElement('div');
  wrap.className = 'tb-table-picker';
  wrap.hidden = true;
  const grid = document.createElement('div');
  grid.className = 'tb-grid';
  const label = document.createElement('div');
  label.className = 'tb-grid-label';
  const cells = [];
  for (let r = 0; r < TABLE_GRID_SIZE; r++) {
    for (let c = 0; c < TABLE_GRID_SIZE; c++) {
      const cell = document.createElement('div');
      cell.className = 'tb-grid-cell';
      cell.dataset.row = r;
      cell.dataset.col = c;
      grid.appendChild(cell);
      cells.push(cell);
    }
  }
  function paint(rows, cols) {
    cells.forEach((cell) => {
      cell.classList.toggle('hi', Number(cell.dataset.row) < rows && Number(cell.dataset.col) < cols);
    });
    label.textContent = `${cols} × ${rows}`;
  }
  grid.addEventListener('mousemove', (e) => {
    const cell = e.target.closest('.tb-grid-cell');
    if (!cell) return;
    const rows = Math.max(2, Number(cell.dataset.row) + 1); // 머리행+본문행 최소 2줄
    const cols = Number(cell.dataset.col) + 1;
    paint(rows, cols);
    grid.dataset.rows = rows;
    grid.dataset.cols = cols;
  });
  grid.addEventListener('click', () => {
    if (!grid.dataset.rows) return;
    onPick(Number(grid.dataset.rows), Number(grid.dataset.cols));
  });
  wrap.appendChild(grid);
  wrap.appendChild(label);
  paint(2, 1);
  return wrap;
}

// ── DOM 구성 ─────────────────────────────────────────────
function btn(html, titleKey) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'tb-btn';
  b.title = t(titleKey);
  b.dataset.i18nTitle = titleKey;
  b.innerHTML = html;
  // 눌러도 편집기가 포커스를 잃지 않게 한다.
  // 이게 없으면 커서만 둔 상태(긁지 않은 상태)에서 눌렀을 때
  // "다음 글자부터 굵게"라는 예약(storedMarks)이 지워져 아무 일도 안 일어난다.
  b.addEventListener('mousedown', (e) => e.preventDefault());
  return b;
}

// vars 가 있는 옵션(제목 레벨 "제목 {n}")은 data-i18n 만으로는(값이 없으니)
// applyI18n() 의 일반 순회가 못 채운다 — data-i18n-n 에 값을 얹어 같이 훑게 한다.
function headingOption(value, textKey, vars) {
  const opt = document.createElement('option');
  opt.value = value;
  opt.textContent = t(textKey, vars);
  opt.dataset.i18n = textKey;
  if (vars) opt.dataset.i18nN = vars.n;
  return opt;
}

export function createToolbar(container, { getView, promptLink, getDocPath, setStatus }) {
  const headingSel = document.createElement('select');
  headingSel.className = 'tb-heading';
  headingSel.appendChild(headingOption('0', 'toolbar.bodyText'));
  HEADING_LEVELS.forEach((l) => headingSel.appendChild(headingOption(String(l), 'toolbar.headingLevel', { n: l })));
  headingSel.appendChild(headingOption('code', 'toolbar.codeBlock'));
  // select 는 preventDefault 하면 목록이 안 열린다 → 적용 후 포커스를 되돌린다.
  headingSel.addEventListener('change', () => { const v = getView(); if (v) v.focus(); });
  container.appendChild(headingSel);
  container.appendChild(sep());

  const boldBtn = btn('<b>B</b>', 'toolbar.boldTitle');
  const italicBtn = btn('<i>I</i>', 'toolbar.italicTitle');
  const underlineBtn = btn('<u>U</u>', 'toolbar.underlineTitle');
  const strikeBtn = btn('<s>S</s>', 'toolbar.strikeTitle');
  [boldBtn, italicBtn, underlineBtn, strikeBtn].forEach((b) => container.appendChild(b));
  container.appendChild(sep());

  const bulletBtn = btn(ICONS.bullet, 'toolbar.bulletListTitle');
  const orderedBtn = btn(ICONS.ordered, 'toolbar.orderedListTitle');
  const todoBtn = btn(ICONS.todo, 'toolbar.todoListTitle');
  [bulletBtn, orderedBtn, todoBtn].forEach((b) => container.appendChild(b));
  container.appendChild(sep());

  const ruleBtn = btn(ICONS.rule, 'toolbar.hrTitle');
  const quoteBtn = btn(ICONS.quote, 'toolbar.quoteTitle');
  const linkBtn = btn(ICONS.link, 'toolbar.linkTitle');
  const codeBtn = btn(ICONS.code, 'toolbar.inlineCodeTitle');
  [quoteBtn, linkBtn, codeBtn, ruleBtn].forEach((b) => container.appendChild(b));
  container.appendChild(sep());

  // ── 표 삽입 (T1 §2.1) ──────────────────────────────────
  const tableWrap = document.createElement('div');
  tableWrap.style.position = 'relative';
  const tableBtn = btn(ICONS.table, 'toolbar.tableTitle');
  const tablePicker = createTablePicker((rows, cols) => {
    tablePicker.hidden = true;
    const v = getView();
    if (v) insertTable(v, rows, cols);
  });
  tableWrap.appendChild(tableBtn);
  tableWrap.appendChild(tablePicker);
  container.appendChild(tableWrap);
  tableBtn.addEventListener('click', () => { tablePicker.hidden = !tablePicker.hidden; });
  document.addEventListener('click', (e) => {
    if (!tableWrap.contains(e.target)) tablePicker.hidden = true;
  });

  // ── 이미지 삽입 (T2 §3.1) — 파일 선택 대화상자 ───────────
  const imageBtn = btn(ICONS.image, 'toolbar.imageTitle');
  container.appendChild(imageBtn);
  imageBtn.addEventListener('click', async () => {
    const v = getView();
    if (!v) return;
    await insertImageFromPicker(v, getDocPath?.(), setStatus);
    v.focus();
  });

  ruleBtn.addEventListener('click', () => {
    const view = getView();
    if (!view) return;
    // 커서 자리에 그대로 넣으면 단어 중간을 쪼갠다.
    // 워드처럼 지금 문단 "뒤"에 한 줄로 넣고 커서를 그 아래로 옮긴다.
    const { $from } = view.state.selection;
    const { state } = view;
    const pos = $from.depth >= 1 ? $from.after(1) : state.doc.content.size;
    const tr = state.tr.insert(pos, nodes.hr.create());
    tr.insert(pos + 1, nodes.paragraph.create());
    tr.setSelection(TextSelection.near(tr.doc.resolve(pos + 2)));
    view.dispatch(tr.scrollIntoView());
    view.focus();
  });

  function run(cmd) {
    const view = getView();
    if (!view) return;
    cmd(view.state, view.dispatch);
    view.focus();
  }

  headingSel.addEventListener('change', () => {
    const view = getView();
    if (!view) return;
    const val = headingSel.value;
    const cmd = val === 'code' ? setBlockType(nodes.code_block)
      : val === '0' ? setBlockType(nodes.paragraph)
      : setBlockType(nodes.heading, { level: Number(val) });
    cmd(view.state, view.dispatch);
    view.focus();
  });
  boldBtn.addEventListener('click', () => run(toggleMark(marks.strong)));
  italicBtn.addEventListener('click', () => run(toggleMark(marks.em)));
  underlineBtn.addEventListener('click', () => run(toggleMark(marks.underline)));
  strikeBtn.addEventListener('click', () => run(toggleMark(marks.strike)));
  codeBtn.addEventListener('click', () => run(toggleMark(marks.code)));
  bulletBtn.addEventListener('click', () => run(toggleList('bullet')));
  orderedBtn.addEventListener('click', () => run(toggleList('ordered')));
  todoBtn.addEventListener('click', () => run(toggleList('todo')));
  quoteBtn.addEventListener('click', () => run(toggleQuote));
  linkBtn.addEventListener('click', async () => {
    const view = getView();
    if (!view) return;
    const { from, to, empty } = view.state.selection;
    // 선택 없이 눌렀을 때 조용히 아무 일도 안 하면 고장으로 보인다.
    // 워드처럼 주소를 받아 그 주소를 글자로 넣고 링크를 건다.
    if (empty) {
      const url = await promptLink();
      view.focus();
      if (!url) return;
      const tr = view.state.tr.insertText(url, from);
      tr.addMark(from, from + url.length, marks.link.create({ href: url }));
      view.dispatch(tr);
      return;
    }
    if (isMarkActive(view.state, marks.link)) {
      view.dispatch(view.state.tr.removeMark(from, to, marks.link));
      view.focus();
      return;
    }
    const url = await promptLink();
    if (!url) { view.focus(); return; }
    view.dispatch(view.state.tr.addMark(from, to, marks.link.create({ href: url })));
    view.focus();
  });

  function update() {
    const view = getView();
    if (!view) return;
    const { state } = view;
    headingSel.value = currentBlockType(state);
    boldBtn.classList.toggle('active', isMarkActive(state, marks.strong));
    italicBtn.classList.toggle('active', isMarkActive(state, marks.em));
    underlineBtn.classList.toggle('active', isMarkActive(state, marks.underline));
    strikeBtn.classList.toggle('active', isMarkActive(state, marks.strike));
    codeBtn.classList.toggle('active', isMarkActive(state, marks.code));
    bulletBtn.classList.toggle('active', isListActive(state, 'bullet'));
    orderedBtn.classList.toggle('active', isListActive(state, 'ordered'));
    todoBtn.classList.toggle('active', isListActive(state, 'todo'));
    quoteBtn.classList.toggle('active', isQuoteActive(state));
    linkBtn.classList.toggle('active', isMarkActive(state, marks.link));
  }

  return { update };
}

function sep() {
  const s = document.createElement('span');
  s.className = 'tb-sep';
  return s;
}

// main.js 의 Mod-b / Mod-i 키맵과 버튼이 같은 명령을 쓰도록 export
export const boldCmd = toggleMark(marks.strong);
export const italicCmd = toggleMark(marks.em);
export const underlineCmd = toggleMark(marks.underline);
