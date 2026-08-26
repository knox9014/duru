// 이미지 삽입 (T2 §3). 툴바 버튼 · 붙여넣기 · 드래그&드롭 세 경로가
// 전부 여기(assets/ 복사 → 상대경로 노드 삽입)로 모인다 (§3.1).
import { pickImage, copyImageToAssets, saveImageBytesToAssets, readImageBytes } from './fsops.js';
import { schema } from './schema.js';
import { t } from './i18n.js';

const EXT_BY_MIME = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif',
  'image/webp': 'webp', 'image/svg+xml': 'svg', 'image/bmp': 'bmp',
};
const MIME_BY_EXT = Object.fromEntries(Object.entries(EXT_BY_MIME).map(([m, e]) => [e, m]));
const guessMime = (name) => MIME_BY_EXT[name.split('.').pop().toLowerCase()] || 'application/octet-stream';

export const isImageFile = (file) => file.type.startsWith('image/');

const pad2 = (n) => String(n).padStart(2, '0');

// 붙여넣기로 들어온 이름 없는 이미지 (§3.2). 파일명은 화면 언어가 바뀌어도
// 안 바뀐다 — 같은 폴더에 언어별로 다른 접두어가 섞이면 오히려 헷갈린다.
function timestampName(mime) {
  const d = new Date();
  const stamp = `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}-${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`;
  return `paste-${stamp}.${EXT_BY_MIME[mime] || 'png'}`;
}

function insertImageNode(view, pos, src) {
  const tr = view.state.tr.insert(pos, schema.nodes.image.create({ src }));
  view.dispatch(tr.scrollIntoView());
}

// 툴바 `이미지` 버튼 → 파일 선택 대화상자 (§3.1-1)
export async function insertImageFromPicker(view, docPath, setStatus) {
  if (!docPath) { setStatus?.(t('image.needDocOpen'), 'bad'); return; }
  try {
    const srcPath = await pickImage();
    if (!srcPath) return;
    const rel = await copyImageToAssets(docPath, srcPath);
    insertImageNode(view, view.state.selection.from, rel);
  } catch (e) {
    // 조용한 무반응은 고장으로 보인다 (§2.4 와 같은 원칙) — 대화상자 실패도 알린다.
    setStatus?.(t('image.addFailed', { error: e }), 'bad');
  }
}

// 붙여넣기(§3.1-2)·드래그&드롭(§3.1-3) 공용.
// keepName: 드롭은 실제 파일이라 이름이 있다, 붙여넣기는 항상 시각 이름을 새로 만든다.
// pos 에 넣고, 다음 이미지를 이어 넣을 수 있게 새 위치를 돌려준다.
export async function insertImageBlob(view, docPath, file, pos, setStatus, keepName) {
  if (!docPath) { setStatus?.(t('image.needDocOpen'), 'bad'); return pos; }
  const name = keepName && file.name ? file.name : timestampName(file.type);
  try {
    const bytes = Array.from(new Uint8Array(await file.arrayBuffer()));
    const rel = await saveImageBytesToAssets(docPath, name, bytes);
    insertImageNode(view, pos, rel);
    return pos + 1;
  } catch (e) {
    setStatus?.(t('image.addFailed', { error: e }), 'bad');
    return pos;
  }
}

// 편집기는 tauri://localhost 에서 돌아가서 "./assets/x.png" 같은 상대경로가
// 그대로는 안 풀린다 — 문서 폴더 기준 절대경로로 바꾼 뒤 Rust 로 바이트를
// 읽어 Blob URL 을 만든다. http(s)/data: 등 이미 완전한 주소는 그대로 쓴다.
const isRemoteOrData = (src) => /^(https?:|data:|blob:|file:)/i.test(src);

function resolveLocalPath(src, docPath) {
  if (!docPath || !src || isRemoteOrData(src)) return null;
  const dir = docPath.replace(/[\\/][^\\/]*$/, '');
  const rel = src.replace(/^\.\//, '');
  return `${dir}/${rel}`;
}

// 화면에서: 실제 <img>, 못 찾으면 회색 상자 (§3.3).
// toDOM 만으로는 onerror 도, 로컬 경로 해석도 못 해서 nodeView 로 만든다.
// getDocPath: 지금 열려 있는 문서의 경로를 나중에(렌더 시점에) 물어보는 함수 —
// main.js 의 nodeViews 설정에서 탭 상태를 감고 넘겨준다.
export function makeImageView(getDocPath) {
  return function imageView(node) {
    const dom = document.createElement('span');
    dom.className = 'pm-image';
    const img = document.createElement('img');
    img.alt = node.attrs.alt || '';
    if (node.attrs.title) img.title = node.attrs.title;
    let objectUrl = null;

    function showPlaceholder() {
      dom.classList.add('pm-image-missing');
      dom.textContent = '';
      const box = document.createElement('span');
      box.className = 'pm-image-placeholder';
      const name = document.createElement('span');
      name.className = 'pm-image-placeholder-name';
      name.textContent = node.attrs.src.split('/').pop();
      const msg = document.createElement('span');
      msg.textContent = t('image.notFound');
      box.appendChild(name);
      box.appendChild(msg);
      dom.appendChild(box);
    }
    img.addEventListener('error', showPlaceholder, { once: true });

    const localPath = resolveLocalPath(node.attrs.src, getDocPath?.());
    if (localPath) {
      readImageBytes(localPath)
        .then((bytes) => {
          objectUrl = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: guessMime(localPath) }));
          img.src = objectUrl;
        })
        .catch(showPlaceholder);
    } else {
      img.src = node.attrs.src;
    }

    dom.appendChild(img);
    return { dom, destroy() { if (objectUrl) URL.revokeObjectURL(objectUrl); } };
  };
}
