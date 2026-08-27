#!/usr/bin/env bash
# 두루 — 새 버전 내기
#
#   ./release.sh 0.3.0 --dry-run   무엇을 할지만 보여준다 (아무것도 안 바꿈)
#   ./release.sh 0.3.0             실제로 낸다
#
# 서명 열쇠도 매니페스트도 없다. 앱은 GitHub 에 최신 버전 번호만 물어보고,
# 새 버전이 있으면 내려받기 쪽을 브라우저로 열어줄 뿐이다.
#
# 딱 하나 챙길 게 있어서 스크립트로 옮겼다:
#   고정 이름 사본(duru-setup-x64.exe)을 빠뜨리면 사이트 내려받기 버튼이
#   404 가 되는데, 아무 오류도 안 나서 알아채기 어렵다.

set -euo pipefail

VERSION="${1:-}"
DRY=""
[[ "${2:-}" == "--dry-run" ]] && DRY="1"

REPO="knox9014/duru"
STABLE="duru-setup-x64.exe"      # 사이트가 가리키는 고정 이름

die() { echo "❌ $*" >&2; exit 1; }
step() { echo; echo "▸ $*"; }
run() { if [[ -n "$DRY" ]]; then echo "   (미리보기) $*"; else eval "$@"; fi; }

# ── 들어오기 전 점검 ─────────────────────────────────────
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "버전을 0.3.0 형식으로 주세요.  예: ./release.sh 0.3.0"

cd "$(dirname "$0")"
[[ -z "$(git status --porcelain)" ]] || die "커밋 안 된 변경이 있습니다. 먼저 정리하세요."

CUR=$(node -p "require('./package.json').version")

# 태그는 gh release create 가 GitHub 쪽에 만들기 때문에 로컬엔 없을 수 있다.
# 로컬만 보면 이미 낸 버전을 또 내려다 빌드를 몇 분 돌린 뒤에야 실패한다.
git fetch --tags -q origin 2>/dev/null || true
git rev-parse "v$VERSION" >/dev/null 2>&1 && die "v$VERSION 태그가 이미 있습니다."
if gh release view "v$VERSION" --repo "$REPO" >/dev/null 2>&1; then
  die "v$VERSION 릴리스가 이미 GitHub 에 있습니다."
fi

echo "두루 $CUR → $VERSION"
[[ -n "$DRY" ]] && echo "(미리보기 — 아무것도 바꾸지 않습니다)"

# ── 1. 버전 세 곳 ────────────────────────────────────────
step "버전 올리기 (tauri.conf.json · package.json · Cargo.toml)"
if [[ -z "$DRY" ]]; then
  node -e "
    const fs=require('fs');
    for (const f of ['package.json','src-tauri/tauri.conf.json']) {
      const j=JSON.parse(fs.readFileSync(f,'utf8'));
      j.version='$VERSION';
      fs.writeFileSync(f, JSON.stringify(j,null,2)+'\n');
    }
    const p='src-tauri/Cargo.toml';
    let c=fs.readFileSync(p,'utf8');
    c=c.replace(/^version = \"[^\"]+\"/m, 'version = \"$VERSION\"');
    fs.writeFileSync(p,c);
  "
  echo "   완료"
else
  echo "   (미리보기) 세 파일의 version 을 $VERSION 으로"
fi

# ── 2. 빌드 ──────────────────────────────────────────────
step "빌드 (몇 분 걸립니다)"
run "npx tauri build"

NSIS="src-tauri/target/release/bundle/nsis/duru_${VERSION}_x64-setup.exe"
MSI="src-tauri/target/release/bundle/msi/duru_${VERSION}_x64_en-US.msi"
[[ -n "$DRY" ]] || [[ -f "$NSIS" ]] || die "설치 파일이 안 나왔습니다: $NSIS"

# ── 3. 고정 이름 사본 ────────────────────────────────────
step "고정 이름 사본 만들기 ($STABLE)"
run "cp '$NSIS' '$STABLE'"

# ── 4. 커밋 · 태그 · 올리기 ──────────────────────────────
step "커밋하고 태그 붙이기"
run "git add -A"
run "git commit -q -m 'v$VERSION'"
run "git tag 'v$VERSION'"
run "git push -q origin master --tags"

step "릴리스 올리기"
run "gh release create 'v$VERSION' \
  '$NSIS' '$MSI' '$STABLE' \
  --repo '$REPO' --title '두루 v$VERSION' --generate-notes"

run "rm -f '$STABLE'"

echo
if [[ -n "$DRY" ]]; then
  echo "미리보기 끝. 실제로 내려면 --dry-run 을 빼고 다시 실행하세요."
else
  echo "✅ v$VERSION 을 냈습니다."
  echo "   릴리스   https://github.com/$REPO/releases/tag/v$VERSION"
  echo "   내려받기 https://github.com/$REPO/releases/latest/download/$STABLE"
  echo
  echo "기존 사용자는 다음에 두루를 열 때 새 버전 안내를 받습니다."
fi
