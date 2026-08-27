#!/usr/bin/env bash
# 두루 — 새 버전 내기
#
#   ./release.sh 0.3.0 --dry-run   무엇을 할지만 보여준다 (아무것도 안 바꿈)
#   ./release.sh 0.3.0             실제로 낸다
#
# 손으로 하면 빠뜨리기 쉬운 두 가지를 이 스크립트가 대신 챙긴다.
#   - latest.json 을 빠뜨리면 자동 업데이트가 조용히 죽는다 (오류도 안 뜬다)
#   - 고정 이름 사본을 빠뜨리면 사이트 내려받기 버튼이 404 가 된다
#
# 서명 열쇠와 비밀번호는 저장소 밖에 있다 (~/.duru/). 자세한 건 그 폴더의
# 읽어보세요.txt 참고.

set -euo pipefail

VERSION="${1:-}"
DRY=""
[[ "${2:-}" == "--dry-run" ]] && DRY="1"

KEY="$HOME/.duru/updater.key"
PASS="$HOME/.duru/updater.pass"
REPO="knox9014/duru"
STABLE="duru-setup-x64.exe"      # 사이트가 가리키는 고정 이름

die() { echo "❌ $*" >&2; exit 1; }
step() { echo; echo "▸ $*"; }
run() { if [[ -n "$DRY" ]]; then echo "   (미리보기) $*"; else eval "$@"; fi; }

# ── 들어오기 전 점검 ─────────────────────────────────────
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "버전을 0.3.0 형식으로 주세요.  예: ./release.sh 0.3.0"
[[ -f "$KEY" ]]  || die "서명 열쇠가 없습니다: $KEY"
[[ -f "$PASS" ]] || die "비밀번호 파일이 없습니다: $PASS"

cd "$(dirname "$0")"
[[ -z "$(git status --porcelain)" ]] || die "커밋 안 된 변경이 있습니다. 먼저 정리하세요."

CUR=$(node -p "require('./package.json').version")
git rev-parse "v$VERSION" >/dev/null 2>&1 && die "v$VERSION 태그가 이미 있습니다."

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

# ── 2. 서명해서 빌드 ─────────────────────────────────────
step "서명해서 빌드 (몇 분 걸립니다)"
if [[ -z "$DRY" ]]; then
  TAURI_SIGNING_PRIVATE_KEY="$(cat "$KEY")" \
  TAURI_SIGNING_PRIVATE_KEY_PASSWORD="$(cat "$PASS")" \
  npx tauri build
else
  echo "   (미리보기) npx tauri build (서명 환경변수 포함)"
fi

NSIS="src-tauri/target/release/bundle/nsis/duru_${VERSION}_x64-setup.exe"
MSI="src-tauri/target/release/bundle/msi/duru_${VERSION}_x64_en-US.msi"

if [[ -z "$DRY" ]]; then
  [[ -f "$NSIS" ]]      || die "설치 파일이 안 나왔습니다: $NSIS"
  [[ -f "$NSIS.sig" ]]  || die "서명이 안 나왔습니다. tauri.conf.json 의 bundle.createUpdaterArtifacts 를 확인하세요."
fi

# ── 3. latest.json (업데이터가 읽는 파일) ────────────────
step "latest.json 만들기"
if [[ -z "$DRY" ]]; then
  node -e "
    const fs=require('fs');
    const sig=fs.readFileSync('$NSIS.sig','utf8').trim();
    fs.writeFileSync('latest.json', JSON.stringify({
      version: '$VERSION',
      notes: '자세한 변경 내용은 릴리스 노트를 참고하세요.',
      pub_date: new Date().toISOString().replace(/\.\d+Z\$/, 'Z'),
      platforms: { 'windows-x86_64': {
        signature: sig,
        url: 'https://github.com/$REPO/releases/download/v$VERSION/duru_${VERSION}_x64-setup.exe'
      } }
    }, null, 2)+'\n');
  "
  echo "   완료"
else
  echo "   (미리보기) .sig 내용을 담은 latest.json 생성"
fi

# ── 4. 고정 이름 사본 ────────────────────────────────────
step "고정 이름 사본 만들기 ($STABLE)"
run "cp '$NSIS' '$STABLE'"

# ── 5. 커밋 · 태그 · 올리기 ──────────────────────────────
step "커밋하고 태그 붙이기"
run "git add -A"
run "git commit -q -m 'v$VERSION'"
run "git tag 'v$VERSION'"
run "git push -q origin master --tags"

step "릴리스 올리기 (자산 5개)"
run "gh release create 'v$VERSION' \
  '$NSIS' '$NSIS.sig' '$MSI' 'latest.json' '$STABLE' \
  --repo '$REPO' --title '두루 v$VERSION' --generate-notes"

run "rm -f '$STABLE'"

echo
if [[ -n "$DRY" ]]; then
  echo "미리보기 끝. 실제로 내려면 --dry-run 을 빼고 다시 실행하세요."
else
  echo "✅ v$VERSION 을 냈습니다."
  echo "   릴리스   https://github.com/$REPO/releases/tag/v$VERSION"
  echo "   내려받기 https://github.com/$REPO/releases/latest/download/$STABLE"
  echo "   업데이트 https://github.com/$REPO/releases/latest/download/latest.json"
  echo
  echo "기존 사용자는 다음에 두루를 열 때 업데이트 안내를 받습니다."
fi
