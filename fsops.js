// Rust 쪽 커맨드 호출을 한곳에 모은다.
import { invoke } from '@tauri-apps/api/core';
import { open as openDialog } from '@tauri-apps/plugin-dialog';

export const pickFolder = () => openDialog({ directory: true, multiple: false });
// T2 §3.1-1 — 이미지 파일 선택 대화상자
export const pickImage = () => openDialog({
  multiple: false,
  filters: [{ name: '이미지', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp'] }],
});
// T2 §3.2 — 문서 옆 assets/ 로 복사, 상대 경로를 돌려받는다
export const copyImageToAssets = (docPath, srcPath) => invoke('copy_image_to_assets', { docPath, srcPath });
export const saveImageBytesToAssets = (docPath, name, bytes) => invoke('save_image_bytes_to_assets', { docPath, name, bytes });
// T2 §3.3 — 화면 표시용. 절대경로 바이트를 읽어온다 (read_md_file 과 같은 신뢰 경계).
export const readImageBytes = (path) => invoke('read_image_bytes', { path });
export const listMdTree = (root) => invoke('list_md_tree', { root });
export const createMdFile = (folder, name) => invoke('create_md_file', { folder, name });
export const readMdFile = (path) => invoke('read_md_file', { path });
export const writeMdFile = (path, content) => invoke('write_md_file', { path, content });
export const statMdFile = (path) => invoke('stat_md_file', { path });
export const loadLastFolder = () => invoke('load_last_folder');
export const saveLastFolder = (folder) => invoke('save_last_folder', { folder });
export const loadSettings = () => invoke('load_settings');
export const saveSettings = (json) => invoke('save_settings', { json });
// ── 버전 관리 (W4) ────────────────────────────────────────
export const gitRepoRoot = (folder) => invoke('git_repo_root', { folder });
export const gitStatus = (folder) => invoke('git_status', { folder });
export const gitDiffFile = (folder, path) => invoke('git_diff_file', { folder, path });
export const gitSaveVersion = (folder, message) => invoke('git_save_version', { folder, message });
export const gitSetIdentity = (folder, name, email) => invoke('git_set_identity', { folder, name, email });
export const gitLogFile = (folder, path) => invoke('git_log_file', { folder, path });
export const gitShowFile = (folder, hash, path) => invoke('git_show_file', { folder, hash, path });
