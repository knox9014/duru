// 표 위에 뜨는 작은 도구막대 (WEEK3 §2.3). 표 밖으로 커서가 나가면 사라진다.
import {
  isInTable, addRowCmd, removeRowCmd,
  addColCmd, removeColCmd, setAlignCmd, currentAlign, deleteTableCmd,
} from './table.js';
import { t } from './i18n.js';

function btn(textKey, titleKey) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'tb-btn table-tb-btn';
  b.title = t(titleKey);
  b.textContent = t(textKey);
  b.dataset.i18n = textKey;
  b.dataset.i18nTitle = titleKey;
  b.addEventListener('mousedown', (e) => e.preventDefault()); // 눌러도 커서를 잃지 않게
  return b;
}

// 심볼만 쓰는 버튼(정렬·삭제) — 언어와 무관하니 title 만 번역한다.
function symbolBtn(label, titleKey) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'tb-btn table-tb-btn';
  b.title = t(titleKey);
  b.innerHTML = label;
  b.dataset.i18nTitle = titleKey;
  b.addEventListener('mousedown', (e) => e.preventDefault());
  return b;
}

export function createTableToolbar(mountEl, onBlocked) {
  const bar = document.createElement('div');
  bar.id = 'table-toolbar';
  bar.hidden = true;

  const addRowBtn = btn('tabletoolbar.addRowBtn', 'tabletoolbar.addRow');
  const delRowBtn = btn('tabletoolbar.removeRowBtn', 'tabletoolbar.removeRow');
  const addColBtn = btn('tabletoolbar.addColBtn', 'tabletoolbar.addCol');
  const delColBtn = btn('tabletoolbar.removeColBtn', 'tabletoolbar.removeCol');
  const alignLeftBtn = symbolBtn('◧', 'tabletoolbar.alignLeft');
  const alignCenterBtn = symbolBtn('◫', 'tabletoolbar.alignCenter');
  const alignRightBtn = symbolBtn('◨', 'tabletoolbar.alignRight');
  const delTableBtn = symbolBtn('🗑', 'tabletoolbar.deleteTable');
  const sep1 = document.createElement('span'); sep1.className = 'tb-sep';
  const sep2 = document.createElement('span'); sep2.className = 'tb-sep';
  [addRowBtn, delRowBtn, addColBtn, delColBtn, sep1,
    alignLeftBtn, alignCenterBtn, alignRightBtn, sep2, delTableBtn]
    .forEach((el) => bar.appendChild(el));
  mountEl.appendChild(bar);

  let view = null;
  function run(cmd) {
    if (!view) return;
    cmd(view.state, view.dispatch);
    view.focus();
  }
  addRowBtn.addEventListener('click', () => run(addRowCmd));
  delRowBtn.addEventListener('click', () => run(removeRowCmd(onBlocked)));
  addColBtn.addEventListener('click', () => run(addColCmd));
  delColBtn.addEventListener('click', () => run(removeColCmd(onBlocked)));
  delTableBtn.addEventListener('click', () => run(deleteTableCmd));
  alignLeftBtn.addEventListener('click', () => run(setAlignCmd('left')));
  alignCenterBtn.addEventListener('click', () => run(setAlignCmd('center')));
  alignRightBtn.addEventListener('click', () => run(setAlignCmd('right')));

  function update(v) {
    view = v;
    if (!view || !isInTable(view.state)) { bar.hidden = true; return; }

    const { state } = view;
    // 버튼은 항상 눌리게 둔다 — 안 되는 이유는 눌렀을 때 상태바로 말한다(위 주석).
    const align = currentAlign(state);
    alignLeftBtn.classList.toggle('active', align === 'left');
    alignCenterBtn.classList.toggle('active', align === 'center');
    alignRightBtn.classList.toggle('active', align === 'right');

    // 표 바로 위에 붙인다 — 커서가 있는 셀이 아니라 "표 전체"의 위쪽 기준.
    // mountEl(#editor-wrap) 기준 좌표로 바꿔야 스크롤해도 표를 따라간다.
    let $pos = state.selection.$from;
    let tableDepth = -1;
    for (let d = $pos.depth; d > 0; d--) if ($pos.node(d).type.name === 'table') tableDepth = d;
    if (tableDepth === -1) { bar.hidden = true; return; }
    const tablePos = $pos.before(tableDepth);
    const coords = view.coordsAtPos(tablePos + 1);
    const wrapRect = mountEl.getBoundingClientRect();
    bar.hidden = false;
    bar.style.left = `${coords.left - wrapRect.left + mountEl.scrollLeft}px`;
    bar.style.top = `${coords.top - wrapRect.top + mountEl.scrollTop - bar.offsetHeight - 6}px`;
  }

  // data-i18n(-title) 을 달아뒀으니 언어가 바뀌면 main.js 의 applyI18n() 이
  // document 전체를 훑을 때 이 버튼들도 같이 다시 그려진다 — 여기서 따로 안 해도 된다.
  return { update };
}
