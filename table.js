// 표 편집 명령 (WEEK3 §2). prosemirror-tables 는 안 쓴다 — 우리 스키마엔
// 헤더 셀·colspan 이 없어서 그 라이브러리의 모델과 안 맞는다.
// 표는 이미 왕복이 검증돼 있으니(§2.5) 여기선 순수하게 커서·구조 조작만 한다.
import { TextSelection } from 'prosemirror-state';
import { Fragment, Slice } from 'prosemirror-model';
import { schema } from './schema.js';
import { t } from './i18n.js';

const { table, table_row, table_cell, paragraph } = schema.nodes;

function findCell($pos) {
  for (let d = $pos.depth; d > 0; d--) {
    if ($pos.node(d).type === table_cell) return { node: $pos.node(d), pos: $pos.before(d) };
  }
  return null;
}
function findTable($pos) {
  for (let d = $pos.depth; d > 0; d--) {
    if ($pos.node(d).type === table) return { node: $pos.node(d), pos: $pos.before(d) };
  }
  return null;
}

export function isInTable(state) {
  return !!findCell(state.selection.$from);
}

// 표 안 모든 셀의 위치를 문서 순서(왼→오, 위→아래)로.
function tableCells(tableNode, tablePos) {
  const cells = [];
  tableNode.descendants((node, pos) => {
    if (node.type === table_cell) { cells.push(tablePos + 1 + pos); return false; }
    return true;
  });
  return cells;
}
const colCount = (tableNode) => tableNode.firstChild.childCount;

// 현재 셀의 행·열 인덱스. 우리가 만드는 표는 항상 열 개수가 일정하다
// (병합·비정형 표를 만들 방법을 UI 에 두지 않았으므로).
function cellCoords($from) {
  const cellInfo = findCell($from);
  if (!cellInfo) return null;
  const tblInfo = findTable($from);
  const cells = tableCells(tblInfo.node, tblInfo.pos);
  const idx = cells.indexOf(cellInfo.pos);
  const cols = colCount(tblInfo.node);
  return { table: tblInfo.node, tablePos: tblInfo.pos, cells, idx, cols, rowIdx: Math.floor(idx / cols), colIdx: idx % cols };
}

function rowStartPos(tableNode, tablePos, rowIdx) {
  let pos = tablePos + 1;
  for (let r = 0; r < rowIdx; r++) pos += tableNode.child(r).nodeSize;
  return pos;
}

function makeRow(n) {
  const cells = [];
  for (let i = 0; i < n; i++) cells.push(table_cell.createAndFill());
  return table_row.create(null, cells);
}

// ── 붙여넣은 표의 행 길이 맞추기 ─────────────────────────────
// table_row 의 parseDOM 은 각 <tr> 을 독립적으로 파싱하고 colspan 을 모른다.
// 워드·웹의 병합 헤더(<th colspan=2>)가 붙은 표를 그대로 넣으면 첫 행만
// 셀이 적어져 colCount(=firstChild.childCount) 가 틀리고, 그 값을 쓰는
// addColCmd·removeColCmd·ArrowUp/Down·정렬이 전부 엉뚱한 열을 건드리게 된다.
// → 붙여넣기 직후 가장 넓은 행 기준으로 짧은 행을 빈 셀로 채운다.
// (셀 병합 자체를 복원하는 게 아니다 — 마크다운 표에 병합이 없으므로
//  "병합됐던 자리"는 빈 칸이 된다. §1.3 과 같은 태도.)
function normalizeTable(tableNode) {
  let maxCols = 0;
  tableNode.forEach((row) => { maxCols = Math.max(maxCols, row.childCount); });
  let changed = false;
  const rows = [];
  tableNode.forEach((row) => {
    if (row.childCount >= maxCols) { rows.push(row); return; }
    changed = true;
    const cells = [];
    row.forEach((cell) => cells.push(cell));
    while (cells.length < maxCols) cells.push(table_cell.createAndFill());
    rows.push(table_row.create(row.attrs, cells));
  });
  if (!changed) return tableNode;
  // 열 개수가 바뀌었으니 정렬 정보는 초기화한다 — 어차피 파싱 단계에서
  // text-align 을 읽지 않아 지금은 항상 비어 있다.
  return table.create({ ...tableNode.attrs, align: null }, rows);
}

function mapFragmentTables(fragment) {
  const nodes = [];
  let changed = false;
  fragment.forEach((node) => {
    if (node.type === table) {
      const fixed = normalizeTable(node);
      if (fixed !== node) changed = true;
      nodes.push(fixed);
      return;
    }
    if (node.content.size) {
      const mapped = mapFragmentTables(node.content);
      if (mapped !== node.content) { changed = true; nodes.push(node.copy(mapped)); return; }
    }
    nodes.push(node);
  });
  return changed ? Fragment.fromArray(nodes) : fragment;
}

// EditorView 의 transformPasted 훅에 그대로 연결한다 (main.js).
export function normalizePastedTables(slice) {
  const content = mapFragmentTables(slice.content);
  return content === slice.content ? slice : new Slice(content, slice.openStart, slice.openEnd);
}

// ── 표 삽입 (§2.1) — 수평선과 같은 규칙: 현재 문단 "뒤"에 한 블록으로 넣는다 ──
export function insertTable(view, rows, cols) {
  const { state } = view;
  const { $from } = state.selection;
  const pos = $from.depth >= 1 ? $from.after(1) : state.doc.content.size;
  const rowNodes = [];
  for (let r = 0; r < rows; r++) rowNodes.push(makeRow(cols));
  const tableNode = table.create({ align: new Array(cols).fill(null) }, rowNodes);
  let tr = state.tr.insert(pos, tableNode);
  // 표 뒤에 이어 쓸 문단이 없을 때만 빈 문단을 하나 붙인다 (수평선과 같은 규칙).
  // 이미 다음 블록이 있으면 붙이지 않는다 — 안 그러면 빈 줄이 하나 더 낀다.
  if (!state.doc.resolve(pos).nodeAfter) tr.insert(pos + tableNode.nodeSize, paragraph.create());
  tr.setSelection(TextSelection.create(tr.doc, pos + 3)); // table(1) + row(1) + cell 안 = +3
  view.dispatch(tr.scrollIntoView());
  view.focus();
}

// ── 셀 이동 (§2.2) ──────────────────────────────────────────
export function tabInTable(dir) {
  return (state, dispatch) => {
    const c = cellCoords(state.selection.$from);
    if (!c) return false;
    const targetIdx = c.idx + dir;

    if (targetIdx >= 0 && targetIdx < c.cells.length) {
      if (dispatch) dispatch(state.tr.setSelection(TextSelection.create(state.doc, c.cells[targetIdx] + 1)).scrollIntoView());
      return true;
    }
    if (dir > 0 && targetIdx === c.cells.length) {
      // 마지막 셀에서 Tab → 새 행을 추가하고 그 첫 셀로 (워드의 핵심 동작, §2.2)
      if (dispatch) {
        const lastRow = c.table.childCount - 1;
        const insertPos = rowStartPos(c.table, c.tablePos, lastRow) + c.table.child(lastRow).nodeSize;
        const tr = state.tr.insert(insertPos, makeRow(c.cols));
        tr.setSelection(TextSelection.create(tr.doc, insertPos + 2));
        dispatch(tr.scrollIntoView());
      }
      return true;
    }
    return true; // 첫 셀에서 Shift-Tab 등 — 표 밖으로 나가지 않고 그대로 둔다
  };
}

// 표 첫/끝 행에서 더 위/아래로 — 표 밖으로 커서를 내보낸다.
// table_cell 이 isolating 이라 "기본 동작에 맡긴다"(return false) 로는 밖으로
// 안 나가진다 — 실제로 겪은 문제: 표를 만든 뒤 아래로 이어 쓸 수 없었다.
function exitTable(state, dispatch, c, dir) {
  const outside = dir > 0 ? c.tablePos + c.table.nodeSize : c.tablePos;
  let $out = state.doc.resolve(outside);
  let sel = TextSelection.near($out, dir);
  // 표가 문서의 맨 끝(또는 맨 앞)이라 그 방향에 아무 블록도 없으면
  // near() 가 도로 표 안으로 되돌아온다 — 그러면 빈 문단을 만들어준다
  // (insertTable() 이 표를 처음 만들 때 이미 하는 보장과 같다).
  if (findCell(sel.$from)) {
    if (!dispatch) return true;
    const tr = state.tr.insert(outside, paragraph.create());
    sel = TextSelection.near(tr.doc.resolve(dir > 0 ? outside + 2 : outside));
    dispatch(tr.setSelection(sel).scrollIntoView());
    return true;
  }
  if (dispatch) dispatch(state.tr.setSelection(sel).scrollIntoView());
  return true;
}

export function verticalMove(dir) {
  return (state, dispatch) => {
    const c = cellCoords(state.selection.$from);
    if (!c) return false;
    const targetIdx = c.idx + dir * c.cols;
    if (targetIdx < 0 || targetIdx >= c.cells.length) return exitTable(state, dispatch, c, dir);
    if (dispatch) dispatch(state.tr.setSelection(TextSelection.create(state.doc, c.cells[targetIdx] + 1)).scrollIntoView());
    return true;
  };
}

// 셀 경계에서 옆 셀로(§2.2 "끝에 닿으면 옆 셀로"), 표의 첫/끝 셀 경계에서는
// 표 밖으로 — ArrowUp/Down 을 고칠 때(exitTable) 놓쳤던 방향이다.
// 실제로 겪은 문제: 표 오른쪽 아래 마지막 칸 끝에서 → 를 눌러도 못 나갔다.
export function horizontalMove(dir) {
  return (state, dispatch) => {
    if (!state.selection.empty) return false; // 선택 범위가 있으면 먼저 접는 기본 동작에 맡긴다
    const $from = state.selection.$from;
    const c = cellCoords($from);
    if (!c) return false;
    const atBoundary = dir > 0 ? $from.parentOffset === $from.parent.content.size : $from.parentOffset === 0;
    if (!atBoundary) return false; // 셀 안에서는 글자 단위 이동에 맡긴다

    const targetIdx = c.idx + dir;
    if (targetIdx >= 0 && targetIdx < c.cells.length) {
      const cellPos = c.cells[targetIdx];
      const cellNode = state.doc.nodeAt(cellPos);
      const inner = dir > 0 ? cellPos + 1 : cellPos + 1 + cellNode.content.size;
      if (dispatch) dispatch(state.tr.setSelection(TextSelection.create(state.doc, inner)).scrollIntoView());
      return true;
    }
    return exitTable(state, dispatch, c, dir); // 표의 첫/끝 칸 경계 — 표 밖으로
  };
}

// ── 셀 안 Enter 차단 (§2.4) — 조용한 무반응은 고장으로 보인다, 반드시 알린다 ──
export function blockEnter(onBlocked) {
  return (state, dispatch) => {
    if (!isInTable(state)) return false;
    if (dispatch) onBlocked?.();
    return true;
  };
}

export function tableKeymap(onEnterBlocked) {
  return {
    Tab: tabInTable(1),
    'Shift-Tab': tabInTable(-1),
    ArrowUp: verticalMove(-1),
    ArrowDown: verticalMove(1),
    ArrowLeft: horizontalMove(-1),
    ArrowRight: horizontalMove(1),
    Enter: blockEnter(onEnterBlocked),
    'Shift-Enter': blockEnter(onEnterBlocked),
    'Mod-Enter': blockEnter(onEnterBlocked),
  };
}

// ── 행·열 편집 (§2.3) ────────────────────────────────────────
export function addRowCmd(state, dispatch) {
  const c = cellCoords(state.selection.$from);
  if (!c) return false;
  if (dispatch) {
    const insertPos = rowStartPos(c.table, c.tablePos, c.rowIdx) + c.table.child(c.rowIdx).nodeSize;
    dispatch(state.tr.insert(insertPos, makeRow(c.cols)).scrollIntoView());
  }
  return true;
}

export function canRemoveRow(state) {
  const c = cellCoords(state.selection.$from);
  return !!c && c.rowIdx > 0; // 머리행(0)은 지울 수 없다
}

// 버튼을 비활성화만 해두면 "눌러도 반응이 없다"는 문의로 돌아온다 — 실제로
// 사용자가 겪은 사례다. Enter 를 막을 때(§2.4)와 같은 원칙: 버튼은 항상
// 누를 수 있게 두고, 안 되는 이유를 상태바에 말해준다.
export function removeRowCmd(onBlocked) {
  return (state, dispatch) => {
    const c = cellCoords(state.selection.$from);
    if (!c) return false;
    if (c.rowIdx === 0) { if (dispatch) onBlocked?.(t('table.headerRowBlocked')); return true; }
    if (dispatch) {
      const pos = rowStartPos(c.table, c.tablePos, c.rowIdx);
      dispatch(state.tr.delete(pos, pos + c.table.child(c.rowIdx).nodeSize).scrollIntoView());
    }
    return true;
  };
}

export function addColCmd(state, dispatch) {
  const c = cellCoords(state.selection.$from);
  if (!c) return false;
  if (dispatch) {
    const tr = state.tr;
    for (let r = 0; r < c.table.childCount; r++) {
      const row = c.table.child(r);
      let pos = rowStartPos(c.table, c.tablePos, r) + 1;
      for (let col = 0; col <= c.colIdx; col++) pos += row.child(col).nodeSize;
      tr.insert(tr.mapping.map(pos), table_cell.createAndFill());
    }
    const align = (c.table.attrs.align || new Array(c.cols).fill(null)).slice();
    align.splice(c.colIdx + 1, 0, null);
    tr.setNodeMarkup(c.tablePos, undefined, { ...c.table.attrs, align });
    dispatch(tr.scrollIntoView());
  }
  return true;
}

export function canRemoveCol(state) {
  const c = cellCoords(state.selection.$from);
  return !!c && c.cols > 1;
}

export function removeColCmd(onBlocked) {
  return (state, dispatch) => {
    const c = cellCoords(state.selection.$from);
    if (!c) return false;
    if (c.cols <= 1) { if (dispatch) onBlocked?.(t('table.minColumns')); return true; }
    if (dispatch) {
      const tr = state.tr;
      for (let r = 0; r < c.table.childCount; r++) {
        const row = c.table.child(r);
        let pos = rowStartPos(c.table, c.tablePos, r) + 1;
        for (let col = 0; col < c.colIdx; col++) pos += row.child(col).nodeSize;
        const size = row.child(c.colIdx).nodeSize;
        tr.delete(tr.mapping.map(pos), tr.mapping.map(pos + size));
      }
      const align = (c.table.attrs.align || new Array(c.cols).fill(null)).slice();
      align.splice(c.colIdx, 1);
      tr.setNodeMarkup(c.tablePos, undefined, { ...c.table.attrs, align: align.some((a) => a) ? align : null });
      dispatch(tr.scrollIntoView());
    }
    return true;
  };
}

export function deleteTableCmd(state, dispatch) {
  const tblInfo = findTable(state.selection.$from);
  if (!tblInfo) return false;
  if (dispatch) dispatch(state.tr.delete(tblInfo.pos, tblInfo.pos + tblInfo.node.nodeSize).scrollIntoView());
  return true;
}

// ── 정렬 (§2.3) — mdast 의 열별 align 배열, :---/:---:/---: 로 저장된다 ──
export function setAlignCmd(value) {
  return (state, dispatch) => {
    const c = cellCoords(state.selection.$from);
    if (!c) return false;
    if (dispatch) {
      const align = (c.table.attrs.align || new Array(c.cols).fill(null)).slice();
      while (align.length < c.cols) align.push(null);
      align[c.colIdx] = value;
      dispatch(state.tr.setNodeMarkup(c.tablePos, undefined, { ...c.table.attrs, align }).scrollIntoView());
    }
    return true;
  };
}

export function currentAlign(state) {
  const c = cellCoords(state.selection.$from);
  if (!c) return null;
  return (c.table.attrs.align || [])[c.colIdx] || null;
}
