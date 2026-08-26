import { defineConfig } from 'vite';

// Tauri 와 같이 돌 때의 설정.
// src-tauri/target 은 cargo 가 계속 쓰는 곳이라 vite 가 감시하면
// EBUSY 로 죽는다. 감시 대상에서 반드시 빼야 한다.
export default defineConfig({
  clearScreen: false,          // cargo 컴파일 로그를 지우지 않는다
  server: {
    port: 5173,
    strictPort: true,          // 포트가 밀리면 Tauri 가 못 찾는다
    watch: {
      ignored: ['**/src-tauri/**', '**/target/**'],
    },
  },
  build: {
    target: 'chrome110',       // WebView2 기준
    emptyOutDir: true,
  },
});
