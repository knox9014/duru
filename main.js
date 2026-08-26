import { EditorState, TextSelection, Plugin } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { Slice } from 'prosemirror-model';
import { keymap } from 'prosemirror-keymap';
import { baseKeymap, chainCommands, exitCode } from 'prosemirror-commands';
import { splitListItem, liftListItem, sinkListItem } from 'prosemirror-schema-list';
import { history, undo, redo } from 'prosemirror-history';
import { schema } from './schema.js';
import { toPM, fromPM } from './convert.js';
import { parser, writer } from './md.js';
import { preserveTopLevel, hasCRLF, toLF, toCRLF } from './normalize.js';
import { pickFolder, listMdTree, createMdFile, readMdFile, writeMdFile, statMdFile, loadLastFolder, saveLastFolder, loadSettings, saveSettings, gitRepoRoot, gitStatus, gitDiffFile, gitSaveVersion, gitSetIdentity, gitLogFile, gitShowFile } from './fsops.js';
import { createToolbar, boldCmd, italicCmd, underlineCmd } from './toolbar.js';
import { tableKeymap, normalizePastedTables } from './table.js';
import { createTableToolbar } from './table-toolbar.js';
import { insertImageBlob, isImageFile, makeImageView } from './image.js';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { t, setLocale, getLocale } from './i18n.js';

// ── 편집기 공통 ──────────────────────────────────────────
function rawView(node) {
  const dom = document.createElement(node.type.name === 'raw' ? 'div' : 'span');
  dom.className = node.type.name === 'raw' ? 'raw-block' : 'raw-inline';
  dom.textContent = node.attrs.value;
  dom.contentEditable = 'false';
  return { dom, ignoreMutation: () => true, stopEvent: () => false };
}

// 할 일 목록(- [ ]/- [x])은 지금까지 마크다운 왕복은 됐지만 편집기 안에서
// 클릭으로 켜고 끄는 방법이 없었다 — 실제 체크박스를 그려서 토글되게 한다.
// checked === null 인(그냥 목록) 항목은 체크박스 없이 평범한 <li> 그대로.
function listItemView(node, view, getPos) {
  const li = document.createElement('li');
  const content = document.createElement('div');
  content.className = 'li-content';
  let checkbox = null;

  function syncChecked(checked) {
    if (checked === null) {
      delete li.dataset.checked;
      if (checkbox) { checkbox.remove(); checkbox = null; }
      return;
    }
    li.dataset.checked = String(checked);
    if (!checkbox) {
      checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.className = 'li-checkbox';
      checkbox.contentEditable = 'false';
      checkbox.addEventListener('mousedown', (e) => e.preventDefault()); // 커서/포커스를 안 뺏는다
      checkbox.addEventListener('change', () => {
        const pos = getPos();
        if (typeof pos !== 'number') return;
        view.dispatch(view.state.tr.setNodeAttribute(pos, 'checked', checkbox.checked));
      });
      li.insertBefore(checkbox, content);
    }
    checkbox.checked = checked;
  }

  li.appendChild(content); // insertBefore(checkbox, content) 안에서 참조하니 먼저 붙여둔다
  syncChecked(node.attrs.checked);

  return {
    dom: li,
    contentDOM: content,
    update(updated) {
      if (updated.type.name !== 'list_item') return false;
      syncChecked(updated.attrs.checked);
      return true;
    },
  };
}

// 보존 덩어리는 지워지지 않는다
// ponytail: 통째 차단. 나중엔 "정말 지울까요?" 확인 대화로 바꿀 것
const countRaw = (doc) => { let n = 0; doc.descendants((x) => { if (x.type.name === 'raw' || x.type.name === 'raw_inline') n++; }); return n; };
const protectRaw = new Plugin({
  filterTransaction: (tr, state) => !tr.docChanged || countRaw(tr.doc) >= countRaw(state.doc),
});
// 강제 개행 (스펙: 줄 끝 공백 2칸 / 역슬래시)
const hardBreak = (state, dispatch) => {
  if (dispatch) dispatch(state.tr.replaceSelectionWith(schema.nodes.hard_break.create()).scrollIntoView());
  return true;
};
// Tab 이 편집기 밖으로 포커스를 옮기지 않게 한다 (문서 편집기의 표준 동작)
const swallow = () => true;

// Ctrl+Shift+V — 클립보드 평문을 마크다운으로 해석해서 끼워 넣는다 (T4-b, §3.5).
// 파일을 열 때와 같은 경로(parser.parse → toPM)를 그대로 쓴다 — 새 변환 규칙 없음.
// 관례와 반대: 대부분의 앱은 이 키를 "서식 없이 붙여넣기"로 쓰지만, 우리는
// Ctrl+V 를 "보이는 그대로"에 두고 마크다운 해석은 명시적으로 요청할 때만 한다.
function pasteAsMarkdown(state, dispatch, view) {
  if (!navigator.clipboard?.readText) return false;
  navigator.clipboard.readText().then((text) => {
    if (!text || !view) return;
    const lf = toLF(text);
    const doc = toPM(parser.parse(lf), lf);
    if (!doc.content.size) return;
    const tr = view.state.tr.replaceSelection(new Slice(doc.content, 0, 0)).scrollIntoView();
    view.dispatch(tr);
  }).catch(() => setStatus(t('status.pasteFailed'), 'bad'));
  return true;
}

const plugins = [
  protectRaw, history(),
  keymap({ 'Mod-z': undo, 'Mod-y': redo, 'Mod-Shift-z': redo, 'Mod-b': boldCmd, 'Mod-i': italicCmd, 'Mod-u': underlineCmd, 'Mod-Shift-v': pasteAsMarkdown }),
  // 표 안에서의 Tab/화살표/Enter. 목록 키맵보다 먼저 와야 한다 — 표 밖에서는
  // false 를 반환해 아래 목록 키맵으로 넘어간다 (§2.2, §8).
  keymap(tableKeymap(() => setStatus(t('table.cellEnterBlocked')))),
  // 목록 안에서의 Enter / Tab. baseKeymap 보다 먼저 와야 한다.
  keymap({
    Enter: splitListItem(schema.nodes.list_item),
    Tab: chainCommands(sinkListItem(schema.nodes.list_item), swallow),
    'Shift-Tab': chainCommands(liftListItem(schema.nodes.list_item), swallow),
    'Shift-Enter': chainCommands(exitCode, hardBreak),
    'Mod-Enter': chainCommands(exitCode, hardBreak),
  }),
  keymap(baseKeymap),
];

function buildDoc(mdLF) {
  const tree = parser.parse(mdLF);
  const doc = toPM(tree, mdLF);
  return doc.content.size === 0 ? schema.nodes.doc.create(null, [schema.nodes.paragraph.create()]) : doc;
}

// ── 앱 상태 ──────────────────────────────────────────────
let currentFolder = null;
let tabs = [];          // { path, name, crlf, state, dirty, diskMtime, externalConflict }
let activeIndex = -1;
let view = null;

// ── 버전 관리 (W4) 상태 ───────────────────────────────────
let repoRoot = null;        // 열린 폴더가 저장소가 아니면 null
let changedFiles = [];      // 마지막 git_status 결과
let gitPollTimer = null;
let gitPollDelay = 5000;    // §3 — 200ms 넘으면 30000 으로 늘어난다
let gitUserName = '';
let gitUserEmail = '';

const $ = (sel) => document.querySelector(sel);
const appEl = $('#app');
const treeEl = $('#tree');
const tabbarEl = $('#tabbar');
const statusEl = $('#status');
const editorWrap = $('#editor-wrap');
const emptyState = $('#empty-state');
const rawViewEl = $('#raw-view');
const viewToggleEl = $('#viewtoggle');
const onboardingEl = $('#onboarding');
const versionbarEl = $('#versionbar');
const versionStatusEl = $('#version-status');
const changedWrapEl = $('#changed-wrap');
const changedBtn = $('#changed-btn');
const changedPopover = $('#changed-popover');
const changedItemsEl = $('#changed-items');
const historyBtn = $('#history-btn');
const saveVersionBtn = $('#save-version-btn');

// ── 모드 (문서/작업실) · 테마 (밝게/어둡게/시스템) ──────────
// §0 원칙: 상태는 이 두 값뿐이고, 화면은 #app 의 data-mode/data-theme 로만 바뀐다.
let appMode = 'doc';        // 'doc' | 'studio'
let themeSetting = 'system'; // 'light' | 'dark' | 'system' — 저장되는 값
let sourceView = false;      // [원본] 뷰가 켜져 있는지 (작업실 전용)
const darkMedia = window.matchMedia('(prefers-color-scheme: dark)');

function computeTheme() {
  if (themeSetting === 'light' || themeSetting === 'dark') return themeSetting;
  return darkMedia.matches ? 'dark' : 'light';
}
function applyTheme() { appEl.dataset.theme = computeTheme(); }
darkMedia.addEventListener('change', () => { if (themeSetting === 'system') applyTheme(); });

// data-i18n(-title/-placeholder) 를 단 모든 요소를 지금 언어로 다시 그린다.
// applyTheme() 과 같은 자리 — 시작할 때 한 번, 언어가 바뀔 때 한 번 더 부른다.
function applyI18n() {
  document.querySelectorAll('[data-i18n]').forEach((el) => {
    const vars = el.dataset.i18nN !== undefined ? { n: el.dataset.i18nN } : undefined;
    el.textContent = t(el.dataset.i18n, vars);
  });
  document.querySelectorAll('[data-i18n-title]').forEach((el) => { el.title = t(el.dataset.i18nTitle); });
  document.querySelectorAll('[data-i18n-placeholder]').forEach((el) => { el.placeholder = t(el.dataset.i18nPlaceholder); });
  // 정적 마크업이 아닌 동적 렌더링(트리·바뀐 문서 수)도 같이 다시 그린다.
  if (currentFolder) refreshTree();
  if (repoRoot) renderChangedButton();
}

async function persistSettings() {
  try { await saveSettings(JSON.stringify({ mode: appMode, theme: themeSetting, language: getLocale(), gitUserName, gitUserEmail })); }
  catch { /* 브라우저 단독 실행(Tauri 없음) 등 — 조용히 무시 */ }
}

// 언어 전환 — 문서 화면 밖 UI 전부를 다시 그린다 (applyTheme() 과 같은 자리).
function setLanguage(value) {
  setLocale(value);
  persistSettings();
  applyI18n();
  openSettings(); // 설정창 자신의 라벨(모드/화면/언어 이름)도 새 언어로 다시 그려야 한다
}

function setTheme(value) {
  themeSetting = value;
  applyTheme();
  persistSettings();
}

// 원본(raw) 뷰 — 지금 저장될 마크다운을 읽기 전용으로 보여준다.
// 문서 데이터는 건드리지 않는다 (표시만 바뀜).
function setSourceView(on) {
  sourceView = on;
  viewToggleEl.querySelectorAll('button').forEach((b) => {
    b.classList.toggle('active', (b.dataset.view === 'raw') === on);
  });
  if (on && view) rawViewEl.textContent = writer.stringify(fromPM(view.state.doc));
  rawViewEl.hidden = !on;
  editorWrap.hidden = on;
}
viewToggleEl.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-view]');
  if (btn) setSourceView(btn.dataset.view === 'raw');
});

// 설정 전환 — 열려 있는 문서는 그대로 두되(§5), doc 으로 갈 때만 정리한다.
// JS 분기 (b): 원본 뷰가 켜진 채 doc 으로 전환되면 강제로 문서 뷰로 되돌린다.
async function setMode(newMode) {
  if (newMode === appMode) return;
  if (newMode === 'doc') {
    if (sourceView) setSourceView(false);
    const keep = tabs[activeIndex];
    for (let i = tabs.length - 1; i >= 0; i--) {
      if (tabs[i] === keep) continue;
      await closeTab(i);
    }
  }
  appMode = newMode;
  appEl.dataset.mode = appMode;
  persistSettings();
  if (currentFolder) await refreshTree(); // 문서↔작업실 전환 시 평탄화 여부가 바뀐다
}

// 파일 저장 실패는 Rust/OS 원본 에러 문자열("Access is denied (os error 5)" 같은)이
// 그대로 새어나갔다 — git 쪽처럼 이해할 수 있는 안내 문구(t())로 바꾼다.
function friendlySaveError(e) {
  const s = String(e);
  if (/[Aa]ccess is denied|os error 5|Permission denied/.test(s)) return t('error.saveNoPermission');
  if (/os error 2|cannot find|No such file/.test(s)) return t('error.saveNotFound');
  if (/No space left|os error 28/.test(s)) return t('error.saveNoSpace');
  return t('error.saveGeneric');
}

function setStatus(text, cls) {
  statusEl.textContent = text;
  statusEl.className = cls || '';
  // §2 — 하단 상태바 왼쪽에도 같은 저장 상태를 보여준다(메뉴바 #status 와는 별개 요소).
  versionStatusEl.textContent = text;
  versionStatusEl.className = cls || '';
}

// ── 폴더 트리 (W2) ──────────────────────────────────────
async function openFolder() {
  const folder = await pickFolder();
  if (!folder) return;
  currentFolder = folder;
  await saveLastFolder(folder);
  await refreshTree();
  await checkRepo();
}

async function newFile() {
  if (!currentFolder) { setStatus(t('status.openFolderFirst'), 'bad'); return; }
  const raw = await promptModal(t('prompt.newFileName'), t('prompt.newFilePlaceholder'));
  if (!raw) return;
  const name = raw.toLowerCase().endsWith('.md') ? raw : raw + '.md';
  let path;
  try { path = await createMdFile(currentFolder, name); }
  catch (e) {
    const msg = String(e) === 'NAME_EXISTS' ? t('error.nameExists') : String(e);
    setStatus(t('status.newFileFailed', { error: msg }), 'bad');
    return;
  }
  await refreshTree();
  await openFileInTab(path, name);
}

// 하위폴더를 재귀적으로 펼쳐 파일만 모은다 — 문서 모드의 "1단 평평한 목록"용
// (MODE_PLAN §3.1). 폴더 행을 숨기기만 하면 눌러도 반응 없는 죽은 버튼처럼
// 보이는 문제가 있어, 아예 폴더 없이 파일만 렌더링한다.
function flattenFiles(nodes) {
  let out = [];
  for (const n of nodes) {
    if (n.is_dir) out = out.concat(flattenFiles(n.children));
    else out.push(n);
  }
  return out;
}

async function refreshTree() {
  if (!currentFolder) return;
  const nodes = await listMdTree(currentFolder);
  treeEl.innerHTML = '';
  if (nodes.length === 0) {
    treeEl.innerHTML = `<div class="tree-empty">${t('tree.empty')}</div>`;
    return;
  }
  if (appMode === 'doc') {
    const files = flattenFiles(nodes).sort((a, b) => a.name.localeCompare(b.name, 'ko'));
    if (files.length === 0) { treeEl.innerHTML = `<div class="tree-empty">${t('tree.empty')}</div>`; return; }
    treeEl.appendChild(renderNodes(files, 0));
  } else {
    treeEl.appendChild(renderNodes(nodes, 0));
  }
  updateTreeActive();
}

function renderNodes(nodes, depth) {
  const wrap = document.createElement('div');
  for (const node of nodes) {
    const item = document.createElement('div');
    item.className = 'tree-node';
    const row = document.createElement('div');
    row.className = 'tree-row';
    row.dataset.path = node.path;
    // node.name 은 실제 파일시스템 이름이라 <, > 같은 문자를 담고 있을 수 있다 —
    // innerHTML 로 이어붙이면 그 파일명이 그대로 실행되는 코드가 될 수 있어
    // (저장형 XSS) textContent 로만 넣는다. 들여쓰기/화살표 마크업만 innerHTML.
    row.innerHTML = `${'<span class="tree-indent"></span>'.repeat(depth)}<span class="tree-indent">${node.is_dir ? '▸' : '·'}</span><span class="name"></span>`;
    row.querySelector('.name').textContent = node.name;
    item.appendChild(row);
    if (node.is_dir) {
      const children = renderNodes(node.children, depth + 1);
      children.className = 'tree-children';
      item.appendChild(children);
      row.addEventListener('click', () => item.classList.toggle('open'));
    } else {
      row.addEventListener('click', () => openFileInTab(node.path, node.name));
    }
    wrap.appendChild(item);
  }
  return wrap;
}

function updateTreeActive() {
  const activePath = tabs[activeIndex]?.path;
  treeEl.querySelectorAll('.tree-row').forEach((row) => {
    row.classList.toggle('active', row.dataset.path === activePath);
  });
}

// ── 파일 열기 · 저장 · 최초 1회 정규화 (W3) ──────────────
async function openFileInTab(path, name) {
  const existing = tabs.findIndex((t) => t.path === path);
  if (existing !== -1) { activateTab(existing); return; }

  // JS 분기 (a): 문서 모드는 탭을 늘리지 않고 현재 탭을 교체한다 (워드처럼 한 번에 한 문서).
  if (appMode === 'doc' && tabs.length) {
    const before = tabs.length;
    await closeTab(activeIndex >= 0 ? activeIndex : 0);
    if (tabs.length === before) return; // 저장 확인에서 취소함
  }

  let read;
  try { read = await readMdFile(path); }
  catch (e) { setStatus(t('status.openFailed', { error: e }), 'bad'); return; }

  const { content, mtime } = read;
  const crlf = hasCRLF(content);
  const lf = toLF(content);
  const normalizedLF = preserveTopLevel(lf);
  const diskForm = crlf ? toCRLF(normalizedLF) : normalizedLF;

  let diskMtime = mtime;
  if (diskForm !== content) {
    try { diskMtime = await writeMdFile(path, diskForm); }
    catch (e) { setStatus(friendlySaveError(e), 'bad'); return; }
  }

  const state = EditorState.create({ doc: buildDoc(normalizedLF), plugins });
  const tab = { path, name, crlf, state, dirty: false, diskMtime, externalConflict: false, autosaveTimer: null };
  tabs.push(tab);
  activateTab(tabs.length - 1);
}

// 붙여넣기(§3.1-2)·드래그&드롭(§3.1-3) 공용 — 이미지 파일들을 순서대로
// assets/ 에 저장하고 커서(또는 놓은 자리)부터 이어 넣는다.
function dropOrPasteImages(v, files, startPos, keepName) {
  const tab = tabs[activeIndex];
  let pos = startPos;
  (async () => {
    for (const file of files) pos = await insertImageBlob(v, tab?.path, file, pos, setStatus, keepName);
  })();
}

function ensureView(initialState) {
  view = new EditorView($('#editor'), {
    state: initialState,
    nodeViews: { raw: rawView, raw_inline: rawView, image: makeImageView(() => tabs[activeIndex]?.path), list_item: listItemView },
    // 병합 헤더가 있던 표를 붙여넣으면 행마다 셀 개수가 달라져 표 편집이
    // 어긋난다 (table.js normalizePastedTables 주석 참조).
    transformPasted: normalizePastedTables,
    // 클립보드에 이미지가 있으면(§3.1-2) 서식 붙여넣기보다 먼저 가로챈다.
    // 이름은 항상 새로 만든다 — 클립보드 이미지는 대개 의미 없는 이름이다.
    handlePaste(v, event) {
      const files = [...(event.clipboardData?.files || [])].filter(isImageFile);
      if (!files.length) return false;
      event.preventDefault();
      dropOrPasteImages(v, files, v.state.selection.from, false);
      return true;
    },
    // 드래그&드롭으로 들어온 파일(§3.1-3). 실제 파일이라 이름을 그대로 쓴다.
    handleDrop(v, event) {
      const files = [...(event.dataTransfer?.files || [])].filter(isImageFile);
      if (!files.length) return false;
      event.preventDefault();
      const coords = v.posAtCoords({ left: event.clientX, top: event.clientY });
      dropOrPasteImages(v, files, coords ? coords.pos : v.state.selection.from, true);
      return true;
    },
    dispatchTransaction(tr) {
      const tab = tabs[activeIndex];
      const newState = view.state.apply(tr);
      view.updateState(newState);
      if (!tab) return;
      tab.state = newState;
      if (tr.docChanged) {
        tab.dirty = true;
        renderTabbar();
        scheduleAutosave(tab);
      }
      toolbar.update();
      tableToolbar.update(view);
    },
  });
}

function activateTab(idx) {
  if (activeIndex >= 0 && tabs[activeIndex] && view) tabs[activeIndex].state = view.state;
  activeIndex = idx;
  const tab = tabs[idx];
  if (!view) ensureView(tab.state);
  else view.updateState(tab.state);
  if (sourceView) setSourceView(false); // 탭이 바뀌면 문서 뷰로 되돌린다
  showEditor();
  renderTabbar();
  updateTreeActive();
  toolbar.update();
  tableToolbar.update(view);
  view.focus();
}

function renderTabbar() {
  tabbarEl.innerHTML = '';
  tabs.forEach((tab, i) => {
    const el = document.createElement('div');
    el.className = 'tab' + (i === activeIndex ? ' active' : '');
    // tab.name 도 파일명 그대로다 — 위 renderNodes 와 같은 이유로 textContent.
    el.innerHTML = `${tab.dirty ? '<span class="dot"></span>' : ''}<span class="name"></span><span class="close">×</span>`;
    el.querySelector('.name').textContent = tab.name;
    el.addEventListener('click', () => activateTab(i));
    el.querySelector('.close').addEventListener('click', (e) => { e.stopPropagation(); closeTab(i); });
    tabbarEl.appendChild(el);
  });
}

async function saveTab(tab) {
  setStatus(t('status.saving'));
  try {
    const mdLF = writer.stringify(fromPM(tab.state.doc));
    const diskForm = tab.crlf ? toCRLF(mdLF) : mdLF;
    const mtime = await writeMdFile(tab.path, diskForm);
    tab.diskMtime = mtime;
    tab.dirty = false;
    setStatus(t('status.saved'), 'ok');
    renderTabbar();
    if (repoRoot) refreshGitStatus(); // §3 — 저장할 때마다 다시 확인
  } catch (e) {
    setStatus(friendlySaveError(e), 'bad');
  }
}

function saveActive() {
  if (activeIndex >= 0 && view) tabs[activeIndex].state = view.state;
  const tab = tabs[activeIndex];
  if (tab) saveTab(tab);
}

// ── 탭 (W4) ──────────────────────────────────────────────
async function closeTab(idx) {
  const tab = tabs[idx];
  if (!tab) return;
  if (idx === activeIndex && view) tab.state = view.state;
  if (tab.dirty) {
    const choice = await confirmModal(t('confirm.unsavedChanges', { name: tab.name }), ['save', 'discard', 'cancel']);
    if (choice === 'cancel' || choice === null) return;
    if (choice === 'save') await saveTab(tab);
  }
  clearTimeout(tab.autosaveTimer); // "버리기"를 골랐는데 예약된 자동저장이 뒤늦게 되살리면 안 된다
  tabs.splice(idx, 1);
  if (idx === activeIndex) {
    activeIndex = -1;
    if (tabs.length) activateTab(Math.min(idx, tabs.length - 1));
    else { view?.destroy(); view = null; $('#editor').innerHTML = ''; showEmptyState(); }
  } else if (idx < activeIndex) {
    activeIndex--;
  }
  renderTabbar();
  updateTreeActive();
}

function closeActiveTab() { if (activeIndex >= 0) closeTab(activeIndex); }

function cycleTabs(dir) {
  if (tabs.length < 2) return;
  activateTab((activeIndex + dir + tabs.length) % tabs.length);
}

function showEditor() { editorWrap.hidden = false; emptyState.hidden = true; }
function showEmptyState() { editorWrap.hidden = true; emptyState.hidden = false; }

// ── 자동 저장 · 외부 변경 감지 (W5) ───────────────────────
// 탭마다 따로 타이머를 둔다 — 하나만 두면 탭을 오가며 타이핑할 때 먼저
// 만든 탭의 예약이 계속 취소돼서 그 탭은 영영 자동저장이 안 된다.
function scheduleAutosave(tab) {
  clearTimeout(tab.autosaveTimer);
  tab.autosaveTimer = setTimeout(() => {
    if (tab.dirty && !tab.externalConflict) saveTab(tab);
  }, 5000);
}

async function reloadTabFromDisk(tab) {
  let read;
  try { read = await readMdFile(tab.path); }
  catch (e) { setStatus(t('status.rereadFailed', { error: e }), 'bad'); return; }
  tab.crlf = hasCRLF(read.content);
  const newState = EditorState.create({ doc: buildDoc(toLF(read.content)), plugins });
  tab.state = newState;
  tab.dirty = false;
  tab.diskMtime = read.mtime;
  if (tabs[activeIndex] === tab && view) view.updateState(newState);
  renderTabbar();
}

setInterval(async () => {
  // 설정/표 변경내용/버전저장 같은 non-큐 모달이 이미 떠 있으면 이번 턴은 건너뛴다 —
  // 배경 폴링이 사용자가 보고 있는 모달을 가로채면 안 된다. 다음 2초 뒤에 다시 본다.
  if (modalOverlay && !modalOverlay.hidden) return;
  for (const tab of tabs) {
    if (tab.externalConflict) continue;
    let mtime;
    try { mtime = await statMdFile(tab.path); }
    catch { continue; }
    if (mtime <= tab.diskMtime) continue;
    if (tabs[activeIndex] === tab && view) tab.state = view.state;
    if (!tab.dirty) {
      await reloadTabFromDisk(tab);
    } else {
      tab.externalConflict = true;
      const choice = await confirmModal(
        t('confirm.externalChange', { name: tab.name }),
        ['reread', 'keep'],
      );
      tab.externalConflict = false;
      if (choice === 'reread') await reloadTabFromDisk(tab);
      else tab.diskMtime = mtime; // 내 것 유지 — 다음 자동저장이 디스크에 반영한다
    }
  }
}, 2000);

// ── 찾기 · 바꾸기 (W6) ─────────────────────────────────────
const findbar = $('#findbar');
const findInput = $('#find-input');
const replaceInput = $('#replace-input');
const findCount = $('#find-count');

function findMatches(doc, query) {
  const out = [];
  if (!query) return out;
  doc.descendants((node, pos) => {
    if (!node.isText) return;
    const text = node.text;
    let idx = 0, i;
    while ((i = text.indexOf(query, idx)) !== -1) {
      out.push({ from: pos + i, to: pos + i + query.length });
      idx = i + 1;
    }
  });
  return out;
}

function selectRange(m) {
  if (!view) return;
  const tr = view.state.tr.setSelection(TextSelection.create(view.state.doc, m.from, m.to)).scrollIntoView();
  view.dispatch(tr);
  view.focus();
}

function findStep(dir) {
  if (!view) return;
  const q = findInput.value;
  const ms = findMatches(view.state.doc, q);
  findCount.textContent = ms.length ? t('findbar.matchCount', { n: ms.length }) : t('findbar.noMatches');
  if (!ms.length) return;
  const cur = view.state.selection.from;
  const m = dir > 0
    ? (ms.find((m) => m.from > cur) || ms[0])
    : ([...ms].reverse().find((m) => m.from < cur) || ms[ms.length - 1]);
  selectRange(m);
}

function replaceOne() {
  if (!view) return;
  const q = findInput.value;
  const sel = view.state.selection;
  const cur = view.state.doc.textBetween(sel.from, sel.to);
  if (q && cur === q) view.dispatch(view.state.tr.insertText(replaceInput.value, sel.from, sel.to));
  findStep(1);
}

function replaceAll() {
  if (!view) return;
  const q = findInput.value;
  if (!q) return;
  const ms = findMatches(view.state.doc, q);
  if (!ms.length) return;
  let tr = view.state.tr;
  for (let i = ms.length - 1; i >= 0; i--) tr = tr.insertText(replaceInput.value, ms[i].from, ms[i].to);
  view.dispatch(tr);
  findCount.textContent = t('findbar.replacedCount', { n: ms.length });
}

// 찾을 말을 고치는 동안 몇 개인지 바로 보여준다.
// (커서는 옮기지 않는다 — 타이핑 중에 화면이 튀면 성가시다)
function updateFindCount() {
  const q = findInput.value;
  if (!view || !q) { findCount.textContent = ''; return; }
  const n = findMatches(view.state.doc, q).length;
  findCount.textContent = n ? t('findbar.matchCount', { n }) : t('findbar.noMatches');
}

function openFind() {
  findbar.hidden = false;
  findCount.textContent = '';   // 지난 작업 문구("3개 바꿈")가 남아 헷갈리지 않게
  findInput.focus(); findInput.select();
  updateFindCount();
}
function closeFind() { findbar.hidden = true; view?.focus(); }

findInput.addEventListener('input', updateFindCount);
findInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); findStep(e.shiftKey ? -1 : 1); }
  if (e.key === 'Escape') closeFind();
});
$('[data-find="next"]').addEventListener('click', () => findStep(1));
$('[data-find="prev"]').addEventListener('click', () => findStep(-1));
$('[data-find="replace"]').addEventListener('click', replaceOne);
$('[data-find="replace-all"]').addEventListener('click', replaceAll);
$('[data-find="close"]').addEventListener('click', closeFind);

// ── 메뉴 · 단축키 (W6) ─────────────────────────────────────
const menuActions = {
  'open-folder': openFolder,
  'save': saveActive,
  'close-tab': closeActiveTab,
  'undo': () => view && undo(view.state, view.dispatch),
  'redo': () => view && redo(view.state, view.dispatch),
  'find': openFind,
  'open-settings': () => openSettings(),
};

document.querySelectorAll('.menu-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    const menu = btn.parentElement;
    const wasOpen = menu.classList.contains('open');
    document.querySelectorAll('.menu.open').forEach((m) => m.classList.remove('open'));
    if (!wasOpen) menu.classList.add('open');
  });
});
document.querySelectorAll('.menu-list button').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.menu.open').forEach((m) => m.classList.remove('open'));
    menuActions[btn.dataset.action]?.();
  });
});
document.addEventListener('click', (e) => {
  if (!e.target.closest('.menu')) document.querySelectorAll('.menu.open').forEach((m) => m.classList.remove('open'));
});

$('#open-folder-btn').addEventListener('click', openFolder);
$('#empty-open-folder').addEventListener('click', openFolder);
$('#new-file-btn').addEventListener('click', newFile);
$('#settings-btn').addEventListener('click', openSettings);

window.addEventListener('keydown', (e) => {
  const mod = e.ctrlKey || e.metaKey;
  if (!mod) return;
  const key = e.key.toLowerCase();
  if (key === 'o') { e.preventDefault(); openFolder(); }
  else if (key === 's') { e.preventDefault(); saveActive(); }
  else if (key === 'w') { e.preventDefault(); closeActiveTab(); }
  else if (key === 'f') { e.preventDefault(); openFind(); }
  else if (key === 'tab') { e.preventDefault(); cycleTabs(e.shiftKey ? -1 : 1); }
  else if (e.key === ',') { e.preventDefault(); openSettings(); }
});

// ── 확인 모달 ────────────────────────────────────────────
const modalOverlay = $('#modal-overlay');
const modalEl = $('#modal');
const modalText = $('#modal-text');
const modalActions = $('#modal-actions');

// confirmModal/promptModal 은 같은 #modal-overlay DOM 하나를 같이 쓴다 — 겹쳐 부르면
// 나중 호출이 먼저 뜬 걸 덮어써서, 사용자가 먼저 뜬 대화상자에 답할 방법이 사라지고
// 그 흐름이 걸어둔 상태(예: tab.externalConflict)가 영영 안 풀리는 문제가 있었다.
// 앞 모달이 닫힐 때까지 다음 호출을 대기시켜 직렬화한다.
let modalChain = Promise.resolve();
function queueModal(open) {
  const p = modalChain.then(open, open);
  modalChain = p.catch(() => {});
  return p;
}

// options: 내부 키 배열('save'/'discard'/'cancel'/'reread'/'keep'/'ok') — 화면엔
// t('modal.'+key) 로 번역해 보여주되, resolve 되는 값은 언어와 무관한 키 그대로다
// (호출부가 choice === '취소' 처럼 화면 문구에 기대면 언어를 바꿀 때 깨진다).
function confirmModal(text, options) {
  return queueModal(() => new Promise((resolve) => {
    modalEl.classList.remove('wide');
    modalText.textContent = text;
    modalActions.innerHTML = '';
    options.forEach((key, i) => {
      const btn = document.createElement('button');
      btn.textContent = t('modal.' + key);
      if (i === options.length - 1 && key !== 'cancel') btn.className = 'primary';
      if (key === 'save' || key === 'reread') btn.className = 'primary';
      btn.addEventListener('click', () => { modalOverlay.hidden = true; resolve(key); });
      modalActions.appendChild(btn);
    });
    modalOverlay.hidden = false;
  }));
}

// 링크 URL 입력 — 기존 모달을 재사용, 입력창 하나만 추가
function promptModal(text, placeholder) {
  return queueModal(() => new Promise((resolve) => {
    modalEl.classList.remove('wide');
    modalText.textContent = text;
    const input = document.createElement('input');
    input.className = 'modal-input';
    input.type = 'text';
    input.placeholder = placeholder || 'https://...';
    modalText.appendChild(input);
    modalActions.innerHTML = '';
    const finish = (val) => { modalOverlay.hidden = true; resolve(val); };
    const cancelBtn = document.createElement('button');
    cancelBtn.textContent = t('modal.cancel');
    cancelBtn.addEventListener('click', () => finish(null));
    const okBtn = document.createElement('button');
    okBtn.textContent = t('modal.ok');
    okBtn.className = 'primary';
    okBtn.addEventListener('click', () => finish(input.value.trim() || null));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); finish(input.value.trim() || null); }
      if (e.key === 'Escape') finish(null);
    });
    modalActions.appendChild(cancelBtn);
    modalActions.appendChild(okBtn);
    modalOverlay.hidden = false;
    input.focus();
  }));
}

// ── 버전 관리 (W4) ───────────────────────────────────────
// Git 을 모르는 사람이 쓰는 화면이다 — commit·diff·branch 같은 말은 절대 보이면 안 된다(§0/§7).

function closeModal() { modalOverlay.hidden = true; modalEl.classList.remove('wide'); }

function fileBaseName(p) { return p.split(/[\\/]/).pop(); }

function defaultVersionMessage() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())} ${t('version.defaultMessageSuffix')}`;
}

// 오늘/어제/N일 전/YYYY-MM-DD (§6) — 커밋 해시는 어디에도 보여주지 않는다.
function relativeKoreanDate(ms) {
  const d = new Date(ms);
  const now = new Date();
  const startOf = (dt) => new Date(dt.getFullYear(), dt.getMonth(), dt.getDate()).getTime();
  const days = Math.round((startOf(now) - startOf(d)) / 86400000);
  const pad = (n) => String(n).padStart(2, '0');
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (days === 0) return t('date.today', { time: hm });
  if (days === 1) return t('date.yesterday', { time: hm });
  if (days > 1 && days < 7) return t('date.daysAgo', { n: days });
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// 저장소가 아니면 조용히 숨긴다 (§1.3) — 폴더를 열 때/전환할 때 한 번만 확인한다.
async function checkRepo() {
  stopGitPoll();
  repoRoot = null;
  changedFiles = [];
  versionbarEl.hidden = true;
  if (!currentFolder) return;
  let root;
  try { root = await gitRepoRoot(currentFolder); } catch { root = null; }
  repoRoot = root || null;
  if (!repoRoot) return;
  versionbarEl.hidden = false;
  await refreshGitStatus();
  startGitPoll();
}

function startGitPoll() {
  gitPollDelay = 5000;
  scheduleGitPoll();
}
function stopGitPoll() { clearTimeout(gitPollTimer); }
function scheduleGitPoll() {
  clearTimeout(gitPollTimer);
  gitPollTimer = setTimeout(async () => { await refreshGitStatus(); scheduleGitPoll(); }, gitPollDelay);
}

// §3 — 5초마다, 저장할 때마다 확인한다. 200ms 를 넘으면 다음 주기부터 30초로 늘린다.
async function refreshGitStatus() {
  if (!repoRoot) return;
  try {
    const res = await gitStatus(currentFolder);
    changedFiles = res.files;
    gitPollDelay = res.elapsed_ms > 200 ? 30000 : 5000;
    renderChangedButton();
  } catch { /* 다음 주기에 다시 시도 — 폴링이라 조용히 넘어간다 */ }
}

function renderChangedButton() {
  if (changedFiles.length === 0) {
    changedBtn.textContent = t('git.noChanges');
    changedBtn.classList.add('dim');
    saveVersionBtn.disabled = true;
  } else {
    changedBtn.textContent = t('git.changedFiles', { n: changedFiles.length });
    changedBtn.classList.remove('dim');
    saveVersionBtn.disabled = false;
  }
  renderChangedPopover();
}

// Rust 의 git_status 는 "modified"/"created"/"deleted" 영문 신호를 돌려준다 — 화면 문구는 여기서 붙인다.
const GIT_STATUS_KEY = { modified: 'git.statusModified', created: 'git.statusCreated', deleted: 'git.statusDeleted' };

// G1 — 바뀐 문서 목록 (§3)
function renderChangedPopover() {
  changedItemsEl.innerHTML = '';
  changedFiles.forEach((f) => {
    const row = document.createElement('div');
    row.className = 'changed-row';
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = fileBaseName(f.path);
    const status = document.createElement('span');
    status.className = 'status';
    status.textContent = t(GIT_STATUS_KEY[f.status] || 'git.statusModified');
    row.appendChild(name);
    row.appendChild(status);
    row.addEventListener('click', () => { changedPopover.hidden = true; openDiffModal(f.path, fileBaseName(f.path)); });
    changedItemsEl.appendChild(row);
  });
}

changedBtn.addEventListener('click', () => {
  if (changedFiles.length === 0) return;
  changedPopover.hidden = !changedPopover.hidden;
});
document.addEventListener('click', (e) => {
  if (!e.target.closest('#changed-wrap')) changedPopover.hidden = true;
});

// G2 — 변경 내용 보기 (§4). 문맥 3줄 + 줄 번호 + 색(연한 빨강/초록).
function renderDiffLines(container, lines) {
  container.innerHTML = '';
  if (!lines.length) {
    const p = document.createElement('p');
    p.className = 'settings-desc';
    p.textContent = t('diff.empty');
    container.appendChild(p);
    return;
  }
  lines.forEach((l, i) => {
    if (l.hunk_start && i !== 0) {
      const sep = document.createElement('div');
      sep.className = 'diff-sep';
      sep.textContent = '⋯';
      container.appendChild(sep);
    }
    const row = document.createElement('div');
    row.className = 'diff-row diff-' + l.kind;
    const oldNo = document.createElement('span');
    oldNo.className = 'diff-ln';
    oldNo.textContent = l.old != null ? String(l.old) : '';
    const newNo = document.createElement('span');
    newNo.className = 'diff-ln';
    newNo.textContent = l.new != null ? String(l.new) : '';
    const mark = document.createElement('span');
    mark.className = 'diff-mark';
    mark.textContent = l.kind === 'add' ? '+' : l.kind === 'del' ? '−' : '';
    const text = document.createElement('span');
    text.className = 'diff-text';
    text.textContent = l.text;
    row.appendChild(oldNo); row.appendChild(newNo); row.appendChild(mark); row.appendChild(text);
    container.appendChild(row);
  });
}

async function openDiffModal(path, name) {
  modalEl.classList.add('wide');
  modalText.textContent = '';
  const h = document.createElement('p');
  h.className = 'modal-title';
  h.textContent = t('diff.whatChanged', { name });
  const body = document.createElement('div');
  body.className = 'diff-view';
  body.textContent = t('common.loading');
  modalText.appendChild(h);
  modalText.appendChild(body);
  modalActions.innerHTML = '';
  const closeBtn = document.createElement('button');
  closeBtn.className = 'primary';
  closeBtn.textContent = t('modal.close');
  closeBtn.addEventListener('click', closeModal);
  modalActions.appendChild(closeBtn);
  modalOverlay.hidden = false;
  try {
    const lines = await gitDiffFile(currentFolder, path);
    renderDiffLines(body, lines);
  } catch {
    body.textContent = t('diff.loadFailed');
  }
}

// G3 — 버전 저장 (§5)
async function openSaveVersionModal() {
  if (!repoRoot || !changedFiles.length) return;
  modalEl.classList.remove('wide');
  modalText.textContent = '';
  const label = document.createElement('p');
  label.className = 'settings-group-label';
  label.textContent = t('version.whatChanged');
  const input = document.createElement('input');
  input.className = 'modal-input';
  input.type = 'text';
  input.placeholder = defaultVersionMessage();
  const filesLabel = document.createElement('p');
  filesLabel.className = 'settings-group-label';
  filesLabel.style.marginTop = '14px';
  filesLabel.textContent = t('version.filesToSave', { n: changedFiles.length });
  const filesList = document.createElement('p');
  filesList.className = 'settings-desc';
  filesList.textContent = changedFiles.map((f) => fileBaseName(f.path)).join(' · ');

  modalText.appendChild(label);
  modalText.appendChild(input);
  modalText.appendChild(filesLabel);
  modalText.appendChild(filesList);

  modalActions.innerHTML = '';
  const cancelBtn = document.createElement('button');
  cancelBtn.textContent = t('modal.cancel');
  cancelBtn.addEventListener('click', () => { modalOverlay.hidden = true; });
  const okBtn = document.createElement('button');
  okBtn.className = 'primary';
  okBtn.textContent = t('modal.save');
  const doSave = () => runSaveVersion(input.value.trim());
  okBtn.addEventListener('click', doSave);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); doSave(); }
    if (e.key === 'Escape') { e.preventDefault(); modalOverlay.hidden = true; }
  });
  modalActions.appendChild(cancelBtn);
  modalActions.appendChild(okBtn);
  modalOverlay.hidden = false;
  input.focus();
}

// §5 저장 순서 — 편집 중인 문서를 먼저 파일로 저장한 다음에 버전을 저장한다.
async function runSaveVersion(desc) {
  modalOverlay.hidden = true;
  const dirtyTabs = tabs.filter((t) => t.dirty);
  for (const t of dirtyTabs) {
    if (t === tabs[activeIndex] && view) t.state = view.state;
    await saveTab(t);
  }
  const message = desc || defaultVersionMessage();
  try {
    await gitSaveVersion(currentFolder, message);
    setStatus(t('status.versionSaved'), 'ok');
    await refreshGitStatus();
  } catch (e) {
    if (String(e).includes('IDENTITY_UNKNOWN')) {
      await confirmModal(t('version.identityRequired'), ['ok']);
    } else {
      setStatus(t('status.versionSaveFailed'), 'bad');
    }
  }
}

saveVersionBtn.addEventListener('click', openSaveVersionModal);

// G4 — 기록 (§6). 지금 열린 문서 하나만, 해시는 절대 보여주지 않는다.
function renderHistoryList(container, entries, tab) {
  container.innerHTML = '';
  if (!entries.length) {
    const p = document.createElement('p');
    p.className = 'settings-desc';
    p.textContent = t('history.empty');
    container.appendChild(p);
    return;
  }
  entries.forEach((entry) => {
    const row = document.createElement('div');
    row.className = 'history-row';
    const when = document.createElement('span');
    when.className = 'when';
    when.textContent = relativeKoreanDate(entry.at * 1000);
    const subject = document.createElement('span');
    subject.className = 'subject';
    subject.textContent = entry.subject;
    row.appendChild(when);
    row.appendChild(subject);
    row.addEventListener('click', () => openHistoryDiff(tab, entry.hash));
    container.appendChild(row);
  });
}

async function openHistoryDiff(tab, hash) {
  modalEl.classList.add('wide');
  modalText.textContent = '';
  const h = document.createElement('p');
  h.className = 'modal-title';
  h.textContent = t('diff.whatChanged', { name: tab.name });
  const body = document.createElement('div');
  body.className = 'diff-view';
  body.textContent = t('common.loading');
  modalText.appendChild(h);
  modalText.appendChild(body);
  try {
    const lines = await gitShowFile(currentFolder, hash, tab.path);
    renderDiffLines(body, lines);
  } catch {
    body.textContent = t('diff.loadFailed');
  }
}

async function openHistoryModal() {
  const tab = tabs[activeIndex];
  if (!tab) { setStatus(t('status.noOpenDoc'), 'bad'); return; }
  modalEl.classList.add('wide');
  modalText.textContent = '';
  const h = document.createElement('p');
  h.className = 'modal-title';
  h.textContent = t('history.title');
  const list = document.createElement('div');
  list.className = 'history-list';
  list.textContent = t('common.loading');
  modalText.appendChild(h);
  modalText.appendChild(list);
  modalActions.innerHTML = '';
  const closeBtn = document.createElement('button');
  closeBtn.className = 'primary';
  closeBtn.textContent = t('modal.close');
  closeBtn.addEventListener('click', closeModal);
  modalActions.appendChild(closeBtn);
  modalOverlay.hidden = false;
  try {
    const entries = await gitLogFile(currentFolder, tab.path);
    renderHistoryList(list, entries, tab);
  } catch {
    list.textContent = t('history.loadFailed');
  }
}

historyBtn.addEventListener('click', openHistoryModal);

// 이름·메일이 둘 다 채워지면 이 저장소에만 적용한다 (--local, §5).
async function syncGitIdentity() {
  if (!repoRoot || !gitUserName || !gitUserEmail) return;
  try { await gitSetIdentity(currentFolder, gitUserName, gitUserEmail); } catch { /* 버전 저장 시 다시 안내됨 */ }
}

// ── 설정 화면 (§5, §10.5) — 모드·화면 라디오, 즉시 반영 ────
function radioGroup(label, name, options, current, onChange) {
  const wrap = document.createElement('div');
  wrap.className = 'settings-group';
  const title = document.createElement('p');
  title.className = 'settings-group-label';
  title.textContent = label;
  const row = document.createElement('div');
  row.className = 'settings-options';
  const desc = document.createElement('p');
  desc.className = 'settings-desc';
  const setDesc = (v) => { desc.textContent = options.find((o) => o.value === v)?.desc || ''; };
  options.forEach((opt) => {
    const id = `${name}-${opt.value}`;
    const l = document.createElement('label');
    const input = document.createElement('input');
    input.type = 'radio';
    input.name = name;
    input.id = id;
    input.value = opt.value;
    input.checked = opt.value === current;
    input.addEventListener('change', () => { setDesc(opt.value); onChange(opt.value); });
    l.appendChild(input);
    l.appendChild(document.createTextNode(opt.label));
    row.appendChild(l);
  });
  setDesc(current);
  wrap.appendChild(title);
  wrap.appendChild(row);
  wrap.appendChild(desc);
  return wrap;
}

// 라디오와 같은 자리에 쓰는 텍스트 입력 한 칸 (버전 저장용 이름/메일, §5).
function textField(label, value, onChange) {
  const wrap = document.createElement('div');
  wrap.className = 'settings-group';
  const title = document.createElement('p');
  title.className = 'settings-group-label';
  title.textContent = label;
  const input = document.createElement('input');
  input.className = 'modal-input';
  input.type = 'text';
  input.value = value || '';
  input.addEventListener('change', () => onChange(input.value.trim()));
  wrap.appendChild(title);
  wrap.appendChild(input);
  return wrap;
}

function openSettings() {
  modalEl.classList.remove('wide');
  modalText.textContent = '';
  modalText.appendChild(radioGroup(t('settings.modeLabel'), 'settings-mode', [
    { value: 'doc', label: t('settings.modeDocLabel'), desc: t('settings.modeDocDesc') },
    { value: 'studio', label: t('settings.modeStudioLabel'), desc: t('settings.modeStudioDesc') },
  ], appMode, (v) => {
    // doc 으로 갈 때는 탭 정리에 저장 확인 대화가 뜰 수 있다 — 같은 모달을 겹쳐 쓰지
    // 않도록 설정창을 먼저 닫고 전환한다.
    modalOverlay.hidden = true;
    setMode(v);
  }));
  modalText.appendChild(radioGroup(t('settings.themeLabel'), 'settings-theme', [
    { value: 'light', label: t('settings.themeLight') },
    { value: 'dark', label: t('settings.themeDark') },
    { value: 'system', label: t('settings.themeSystem') },
  ], themeSetting, setTheme));
  // 언어 이름은 번역하지 않는다 — "한국어"/"English" 는 항상 그 언어 자신의 표기로
  // 보여줘야 지금 UI 가 무슨 언어든 사용자가 자기 언어를 찾을 수 있다.
  modalText.appendChild(radioGroup(t('settings.languageLabel'), 'settings-language', [
    { value: 'ko', label: '한국어' },
    { value: 'en', label: 'English' },
  ], getLocale(), setLanguage));
  modalText.appendChild(textField(t('settings.gitNameLabel'), gitUserName, (v) => { gitUserName = v; persistSettings(); syncGitIdentity(); }));
  modalText.appendChild(textField(t('settings.gitEmailLabel'), gitUserEmail, (v) => { gitUserEmail = v; persistSettings(); syncGitIdentity(); }));
  modalActions.innerHTML = '';
  const closeBtn = document.createElement('button');
  closeBtn.className = 'primary';
  closeBtn.textContent = t('modal.close');
  closeBtn.addEventListener('click', () => { modalOverlay.hidden = true; });
  modalActions.appendChild(closeBtn);
  modalOverlay.hidden = false;
}

// ── 첫 실행 화면 (§4) — 설정 파일이 없을 때만, 딱 한 번 ──────
function pickOnboarding(mode) {
  appMode = mode;
  appEl.dataset.mode = appMode;
  persistSettings();
  onboardingEl.hidden = true;
}
document.querySelectorAll('.onboarding-card').forEach((el) => {
  el.addEventListener('click', () => pickOnboarding(el.dataset.pick));
});
window.addEventListener('keydown', (e) => {
  if (!onboardingEl.hidden && e.key === 'Escape') pickOnboarding('doc');
});

// ── 툴바 (2주차 T1) ──────────────────────────────────────
const toolbar = createToolbar($('#toolbar'), {
  getView: () => view,
  promptLink: () => promptModal(t('prompt.linkUrl')),
  getDocPath: () => tabs[activeIndex]?.path,
  setStatus,
});
// 표 위에 뜨는 도구막대 (3주차 T1, §2.3) — 표 밖으로 나가면 사라진다.
const tableToolbar = createTableToolbar(editorWrap, (msg) => setStatus(msg));

// ── 개발용 점검 훅 ───────────────────────────────────────
// 파일 없이 문서를 띄워 UI 동작을 확인할 때 쓴다 (브라우저에서 Tauri 없이).
window.__duru = {
  openText(name, text) {
    const state = EditorState.create({ doc: buildDoc(preserveTopLevel(toLF(text))), plugins });
    tabs.push({ path: '/dev/' + name, name, crlf: false, state, dirty: false, diskMtime: 0, externalConflict: false });
    activateTab(tabs.length - 1);
  },
  getView: () => view,
  toolbar,
  // 지금 편집기 내용이 어떤 마크다운으로 저장될지
  serialize: () => writer.stringify(fromPM(view.state.doc)),
};

// 설정 읽기 — §6/§10.4의 규칙 그대로 (없거나 못 읽으면 첫 실행, 값이 이상하면 doc/system 으로 고쳐 저장)
async function loadModeTheme() {
  let raw;
  try { raw = await loadSettings(); } catch { raw = null; }
  if (!raw) return { firstRun: true };
  let obj;
  try { obj = JSON.parse(raw); } catch { return { firstRun: true }; }
  let dirty = false;
  let mode = obj.mode;
  if (mode !== 'doc' && mode !== 'studio') { mode = 'doc'; dirty = true; }
  let theme = obj.theme;
  if (theme !== 'light' && theme !== 'dark' && theme !== 'system') { theme = 'system'; dirty = true; }
  let language = obj.language;
  if (language !== 'ko' && language !== 'en') { language = 'ko'; dirty = true; }
  const gitName = typeof obj.gitUserName === 'string' ? obj.gitUserName : '';
  const gitEmail = typeof obj.gitUserEmail === 'string' ? obj.gitUserEmail : '';
  return { firstRun: false, mode, theme, language, gitName, gitEmail, dirty };
}

// ── 시작 ─────────────────────────────────────────────────
(async function init() {
  showEmptyState();

  const s = await loadModeTheme();
  appMode = s.firstRun ? 'doc' : s.mode;
  themeSetting = s.firstRun ? 'system' : s.theme;
  setLocale(s.firstRun ? 'ko' : s.language);
  gitUserName = s.firstRun ? '' : s.gitName;
  gitUserEmail = s.firstRun ? '' : s.gitEmail;
  appEl.dataset.mode = appMode;
  applyTheme();
  applyI18n();
  if (!s.firstRun && s.dirty) persistSettings();
  if (s.firstRun) onboardingEl.hidden = false;

  // 마지막 폴더 복원은 실패해도 앱이 뜨는 것을 막으면 안 된다.
  // (폴더가 지워졌거나 state.json 이 깨진 경우)
  try {
    const last = await loadLastFolder();
    if (last) { currentFolder = last; await refreshTree(); await checkRepo(); }
  } catch (e) {
    currentFolder = null;
    setStatus(t('status.lastFolderFailed'));
  }

  // 창 닫기(X 버튼) — Ctrl+W 와 달리 지금까지 아무 저장 확인도 없이 그냥
  // 닫혀서 편집 중이던 내용이 조용히 사라졌다. closeTab 과 같은 확인 흐름을 탄다.
  try {
    await getCurrentWindow().onCloseRequested(async (event) => {
      const dirty = tabs.filter((t) => t.dirty);
      if (!dirty.length) return;
      event.preventDefault();
      for (const tab of dirty) {
        if (tab === tabs[activeIndex] && view) tab.state = view.state;
        const choice = await confirmModal(t('confirm.unsavedChanges', { name: tab.name }), ['save', 'discard', 'cancel']);
        if (choice === 'cancel' || choice === null) return; // 닫기 자체를 그만둔다
        if (choice === 'save') await saveTab(tab);
      }
      await getCurrentWindow().destroy();
    });
  } catch { /* 브라우저 단독 실행(Tauri 없음) 등 — 조용히 무시 */ }
})();
