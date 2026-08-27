use serde::Serialize;
use std::fs;
use std::path::Path;
use std::time::UNIX_EPOCH;
use tauri::Manager;

// ── 파일 트리 (W2) ──────────────────────────────────────
#[derive(Serialize)]
struct FileNode {
    name: String,
    path: String,
    is_dir: bool,
    children: Vec<FileNode>,
}

fn skip_dir(name: &str) -> bool {
    name.starts_with('.') || name == "node_modules"
}

// 폴더를 재귀로 훑어 .md 파일만 남긴다. md 파일이 하나도 없는 폴더는 뺀다.
fn walk(dir: &Path) -> Vec<FileNode> {
    let mut entries: Vec<_> = match fs::read_dir(dir) {
        Ok(rd) => rd.filter_map(|e| e.ok()).collect(),
        Err(_) => return vec![],
    };
    entries.sort_by_key(|e| e.file_name());

    let mut out = vec![];
    for entry in entries {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        let is_dir = path.is_dir();
        if is_dir {
            if skip_dir(&name) {
                continue;
            }
            let children = walk(&path);
            if !children.is_empty() {
                out.push(FileNode { name, path: path.to_string_lossy().to_string(), is_dir: true, children });
            }
        } else if name.to_lowercase().ends_with(".md") {
            out.push(FileNode { name, path: path.to_string_lossy().to_string(), is_dir: false, children: vec![] });
        }
    }
    out
}

#[tauri::command]
fn list_md_tree(root: String) -> Vec<FileNode> {
    walk(Path::new(&root))
}

// 사이드바 "새 파일" — 이름이 이미 있으면 덮어쓰지 않고 에러로 알린다.
#[tauri::command]
fn create_md_file(folder: String, name: String) -> Result<String, String> {
    let path = Path::new(&folder).join(&name);
    if path.exists() {
        return Err("NAME_EXISTS".into());
    }
    fs::write(&path, "").map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().to_string())
}

// ── 파일 읽기/쓰기 (W3) ──────────────────────────────────
fn mtime_millis(meta: &fs::Metadata) -> u64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[derive(Serialize)]
struct ReadResult {
    content: String,
    mtime: u64,
}

#[tauri::command]
fn read_md_file(path: String) -> Result<ReadResult, String> {
    let content = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let meta = fs::metadata(&path).map_err(|e| e.to_string())?;
    Ok(ReadResult { content, mtime: mtime_millis(&meta) })
}

#[tauri::command]
fn write_md_file(path: String, content: String) -> Result<u64, String> {
    fs::write(&path, content).map_err(|e| e.to_string())?;
    let meta = fs::metadata(&path).map_err(|e| e.to_string())?;
    Ok(mtime_millis(&meta))
}

#[tauri::command]
fn stat_md_file(path: String) -> Result<u64, String> {
    let meta = fs::metadata(&path).map_err(|e| e.to_string())?;
    Ok(mtime_millis(&meta))
}

// 문서 안 이미지 표시용 (T2 §3.3). 웹뷰는 tauri://localhost 에서 돌아가서
// <img src="./assets/x.png"> 같은 상대경로가 디스크 파일로 안 풀린다
// (Tauri asset 프로토콜은 여기서 안 쓴다 — read/write_md_file 과 같은 자리:
// 이 앱은 이미 사용자가 고른 폴더 전체에 커스텀 커맨드로 무제한 접근하므로,
// asset scope 를 새로 여는 것보다 같은 신뢰 경계를 그대로 따르는 게 맞다).
// 프런트에서 절대경로로 바이트를 읽어 Blob URL을 만든다.
#[tauri::command]
fn read_image_bytes(path: String) -> Result<Vec<u8>, String> {
    fs::read(&path).map_err(|e| e.to_string())
}

// ── 이미지를 assets/ 로 복사 (T2 §3.2) ────────────────────
// 문서 옆 assets/ 폴더에 넣고 상대 경로("./assets/이름.ext")를 돌려준다.
// 이름이 겹치면 -2, -3 ... 을 붙인다. 파일을 지우는 명령은 없다 —
// 이미지 노드를 지워도 다른 문서가 같은 파일을 쓰고 있을 수 있어서다 (§3.3).
fn split_ext(name: &str) -> (&str, &str) {
    match name.rfind('.') {
        Some(i) if i > 0 => (&name[..i], &name[i + 1..]),
        _ => (name, ""),
    }
}

fn place_in_assets(
    doc_path: &str,
    name: &str,
    write: impl FnOnce(&Path) -> std::io::Result<()>,
) -> Result<String, String> {
    let doc_dir = Path::new(doc_path).parent().ok_or("INVALID_DOC_PATH")?;
    let assets_dir = doc_dir.join("assets");
    fs::create_dir_all(&assets_dir).map_err(|e| e.to_string())?;

    let (stem, ext) = split_ext(name);
    let mut final_name = name.to_string();
    let mut n = 2;
    while assets_dir.join(&final_name).exists() {
        final_name = if ext.is_empty() { format!("{stem}-{n}") } else { format!("{stem}-{n}.{ext}") };
        n += 1;
    }

    let dest = assets_dir.join(&final_name);
    write(&dest).map_err(|e| e.to_string())?;
    Ok(format!("./assets/{final_name}"))
}

// 파일 선택 대화상자로 고른 기존 파일을 복사한다.
#[tauri::command]
fn copy_image_to_assets(doc_path: String, src_path: String) -> Result<String, String> {
    let name = Path::new(&src_path)
        .file_name()
        .ok_or("UNKNOWN_FILENAME")?
        .to_string_lossy()
        .to_string();
    place_in_assets(&doc_path, &name, |dest| fs::copy(&src_path, dest).map(|_| ()))
}

// 붙여넣기·드래그로 들어온 바이트를 새 파일로 쓴다.
// name 은 프런트가 File.name(드래그) 이나 직접 지은 이름(붙여넣기)을 주는데,
// copy_image_to_assets 와 달리 여기선 그걸 그대로 믿었다 — 경로 구분자가
// 섞여 들어오면 assets/ 밖으로 나갈 수 있으니 파일명만 뽑아 쓴다.
#[tauri::command]
fn save_image_bytes_to_assets(doc_path: String, name: String, bytes: Vec<u8>) -> Result<String, String> {
    let name = Path::new(&name)
        .file_name()
        .ok_or("UNKNOWN_FILENAME")?
        .to_string_lossy()
        .to_string();
    place_in_assets(&doc_path, &name, |dest| fs::write(dest, &bytes))
}

// ── 마지막 연 폴더 기억 (W2) ──────────────────────────────
fn state_path(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("state.json"))
}

#[tauri::command]
fn load_last_folder(app: tauri::AppHandle) -> Option<String> {
    let path = state_path(&app).ok()?;
    let text = fs::read_to_string(path).ok()?;
    let v: serde_json::Value = serde_json::from_str(&text).ok()?;
    v.get("lastFolder")?.as_str().map(|s| s.to_string())
}

#[tauri::command]
fn save_last_folder(app: tauri::AppHandle, folder: String) -> Result<(), String> {
    let path = state_path(&app)?;
    let v = serde_json::json!({ "lastFolder": folder });
    fs::write(path, v.to_string()).map_err(|e| e.to_string())
}

// ── 모드/테마 설정 (settings.json) ─────────────────────────
// Rust 쪽은 읽고 쓰기만 한다. 파싱·기본값·검증은 JS(main.js)가 맡는다.
fn settings_path(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("settings.json"))
}

#[tauri::command]
fn load_settings(app: tauri::AppHandle) -> Option<String> {
    let path = settings_path(&app).ok()?;
    fs::read_to_string(path).ok()
}

#[tauri::command]
fn save_settings(app: tauri::AppHandle, json: String) -> Result<(), String> {
    let path = settings_path(&app)?;
    fs::write(path, json).map_err(|e| e.to_string())
}

// ── 버전 관리 (W4) — 시스템 git 을 그대로 부른다 ────────────
// 이 파일 안의 모든 git 커맨드는 '*.md' 와 'assets/' 만 건드린다 (§1.1).
// git init 은 절대 하지 않는다 (§1.3) — 저장소가 아니면 조용히 실패시킨다.
use std::process::Command;
use std::time::Instant;

// cwd 에서 git 을 실행하고 (성공여부, stdout, stderr) 를 돌려준다.
// 실행 자체가 안 되면(=git 이 없음) Err.
fn git_output(cwd: &str, args: &[&str]) -> Result<(bool, String, String), String> {
    let out = Command::new("git")
        .args(args)
        .current_dir(cwd)
        .output()
        .map_err(|e| e.to_string())?;
    Ok((
        out.status.success(),
        String::from_utf8_lossy(&out.stdout).to_string(),
        String::from_utf8_lossy(&out.stderr).to_string(),
    ))
}

#[tauri::command]
fn git_repo_root(folder: String) -> Option<String> {
    let (ok, stdout, _) = git_output(&folder, &["rev-parse", "--show-toplevel"]).ok()?;
    if ok { Some(stdout.trim().to_string()) } else { None }
}

#[derive(Serialize)]
struct ChangedFile {
    path: String,
    status: String, // modified | created | deleted — 프런트(main.js)가 언어별 문구로 번역한다
}

#[derive(Serialize)]
struct GitStatusResult {
    files: Vec<ChangedFile>,
    elapsed_ms: u64, // §3 — 200ms 넘으면 프런트가 폴링 주기를 늘린다
}

#[tauri::command]
fn git_status(folder: String) -> Result<GitStatusResult, String> {
    let start = Instant::now();
    // -z 로 받는다. 기본 출력은 이름에 띄어쓰기가 있으면 경로를 따옴표로 감싸는데,
    // 그 따옴표째 경로로 diff 를 돌리면 아무것도 못 찾아 "변경된 내용이 없습니다" 가 됐다.
    // -z 는 NUL 로 끊고 따옴표를 붙이지 않는다 (그래서 core.quotepath 도 필요 없다).
    let (ok, stdout, stderr) =
        git_output(&folder, &["status", "--porcelain", "-z", "--", "*.md", "assets/"])?;
    if !ok {
        return Err(stderr);
    }
    let mut files = vec![];
    let mut entries = stdout.split('\0').filter(|s| !s.is_empty());
    while let Some(entry) = entries.next() {
        if entry.len() < 4 {
            continue;
        }
        let xy = &entry[0..2];
        let rel = entry[3..].to_string();
        // 이름 바꾸기/복사는 예전 이름이 바로 다음 항목으로 따로 온다 — 새 이름만 쓰고 건너뛴다
        if xy.contains('R') || xy.contains('C') {
            entries.next();
        }
        let status = if xy.contains('?') || xy.contains('A') {
            "created"
        } else if xy.contains('D') {
            "deleted"
        } else {
            "modified"
        };
        let abs = Path::new(&folder).join(&rel).to_string_lossy().to_string();
        files.push(ChangedFile { path: abs, status: status.to_string() });
    }
    Ok(GitStatusResult { files, elapsed_ms: start.elapsed().as_millis() as u64 })
}

#[derive(Serialize)]
struct DiffLine {
    old: Option<u32>,
    new: Option<u32>,
    kind: String, // ctx | add | del
    text: String,
    hunk_start: bool,
}

// "@@ -3,4 +3,5 @@ ..." → (3, 3). 형식이 안 맞으면 None.
fn parse_hunk_header(line: &str) -> Option<(u32, u32)> {
    let body = line.strip_prefix("@@ ")?;
    let end = body.find(" @@")?;
    let ranges = &body[..end];
    let mut parts = ranges.split(' ');
    let old_part = parts.next()?.trim_start_matches('-');
    let new_part = parts.next()?.trim_start_matches('+');
    let old_start: u32 = old_part.split(',').next()?.parse().ok()?;
    let new_start: u32 = new_part.split(',').next()?.parse().ok()?;
    Some((old_start, new_start))
}

// git diff/show 출력에서 헤더(diff/index/---/+++/@@)를 걷어내고
// 줄 번호를 직접 계산한다 (§4 — @@ 같은 표시는 화면에 그대로 보여주지 않는다).
fn parse_diff(text: &str) -> Vec<DiffLine> {
    let mut out = vec![];
    let mut old_ln = 0u32;
    let mut new_ln = 0u32;
    let mut in_hunk = false;
    let mut hunk_start = false;
    for line in text.lines() {
        if line.starts_with("diff ")
            || line.starts_with("index ")
            || line.starts_with("--- ")
            || line.starts_with("+++ ")
            || line.starts_with("new file mode")
            || line.starts_with("deleted file mode")
            || line.starts_with("similarity index")
            || line.starts_with("rename ")
        {
            continue;
        }
        if line.starts_with("@@") {
            if let Some((o, n)) = parse_hunk_header(line) {
                old_ln = o;
                new_ln = n;
                in_hunk = true;
                hunk_start = true;
            }
            continue;
        }
        if !in_hunk {
            continue;
        }
        if line.starts_with('\\') {
            continue; // "\ No newline at end of file"
        }
        if let Some(rest) = line.strip_prefix('+') {
            out.push(DiffLine { old: None, new: Some(new_ln), kind: "add".into(), text: rest.to_string(), hunk_start });
            new_ln += 1;
        } else if let Some(rest) = line.strip_prefix('-') {
            out.push(DiffLine { old: Some(old_ln), new: None, kind: "del".into(), text: rest.to_string(), hunk_start });
            old_ln += 1;
        } else {
            let rest = line.strip_prefix(' ').unwrap_or(line);
            out.push(DiffLine { old: Some(old_ln), new: Some(new_ln), kind: "ctx".into(), text: rest.to_string(), hunk_start });
            old_ln += 1;
            new_ln += 1;
        }
        hunk_start = false;
    }
    out
}

#[tauri::command]
fn git_diff_file(folder: String, path: String) -> Result<Vec<DiffLine>, String> {
    let (_, status_out, _) =
        git_output(&folder, &["-c", "core.quotepath=false", "status", "--porcelain", "--", &path])?;
    let untracked = status_out.trim_start().starts_with("??");
    let text = if untracked {
        let (_, out, _) = git_output(&folder, &["diff", "--no-index", "--", "/dev/null", &path])?;
        out
    } else {
        let (_, out, _) = git_output(&folder, &["diff", "-U3", "--", &path])?;
        out
    };
    Ok(parse_diff(&text))
}

// §1.1 — .md 와 assets/ 만. §5 — 이름/메일 없으면 "IDENTITY_UNKNOWN" 을 돌려주고,
// 그 외 실패는 Git 용어 없는 일반 메시지로 뭉뚱그린다 (원본 stderr 를 화면에 보이지 않는다).
#[tauri::command]
fn git_save_version(folder: String, message: String) -> Result<(), String> {
    // assets/ 가 아직 없는(이미지 없는) 문서만 있는 저장소도 흔하다 — 'assets/' 는 존재하는
    // 디렉터리가 아니면 git add 가 통째로 실패하므로, 있을 때만 pathspec 에 넣는다.
    let mut add_args = vec!["add", "--"];
    add_args.push("*.md");
    if Path::new(&folder).join("assets").is_dir() {
        add_args.push("assets/");
    }
    let (ok, _, err) = git_output(&folder, &add_args)?;
    if !ok {
        return Err("STAGE_FAILED: ".to_string() + err.trim());
    }
    let (ok2, _, err2) =
        git_output(&folder, &["-c", "core.quotepath=false", "commit", "-m", &message])?;
    if !ok2 {
        if err2.contains("Please tell me who you are") || err2.contains("user.name") || err2.contains("Author identity unknown") {
            return Err("IDENTITY_UNKNOWN".into());
        }
        return Err("VERSION_SAVE_FAILED".into());
    }
    Ok(())
}

// §5 — --local 만 쓴다. 사용자의 전체 Git 설정은 절대 건드리지 않는다.
#[tauri::command]
fn git_set_identity(folder: String, name: String, email: String) -> Result<(), String> {
    let (ok, _, _) = git_output(&folder, &["config", "--local", "user.name", &name])?;
    if !ok {
        return Err("IDENTITY_SET_FAILED".into());
    }
    let (ok2, _, _) = git_output(&folder, &["config", "--local", "user.email", &email])?;
    if !ok2 {
        return Err("IDENTITY_SET_FAILED".into());
    }
    Ok(())
}

#[derive(Serialize)]
struct LogEntry {
    hash: String,
    at: i64,
    subject: String,
}

// §6 — 지금 열려 있는 문서 하나의 기록만 (전체 저장소 기록은 v0.2).
#[tauri::command]
fn git_log_file(folder: String, path: String) -> Result<Vec<LogEntry>, String> {
    let (ok, stdout, _) = git_output(
        &folder,
        &["-c", "core.quotepath=false", "log", "--format=%H%x09%at%x09%s", "-n", "50", "--", &path],
    )?;
    if !ok {
        return Ok(vec![]); // 커밋이 아예 없는 새 파일 — 빈 기록으로 취급
    }
    let mut out = vec![];
    for line in stdout.lines() {
        let mut parts = line.splitn(3, '\t');
        if let (Some(h), Some(t), Some(s)) = (parts.next(), parts.next(), parts.next()) {
            if let Ok(at) = t.parse::<i64>() {
                out.push(LogEntry { hash: h.to_string(), at, subject: s.to_string() });
            }
        }
    }
    Ok(out)
}

#[tauri::command]
fn git_show_file(folder: String, hash: String, path: String) -> Result<Vec<DiffLine>, String> {
    let (_, stdout, _) = git_output(&folder, &["show", "--format=", "-U3", &hash, "--", &path])?;
    Ok(parse_diff(&stdout))
}

// place_in_assets 의 이름 충돌 처리(§3.2)가 핵심 로직이라 실제 파일시스템으로
// 확인한다 — 겹치면 -2, -3 이 붙는지, 확장자 없는 이름도 처리되는지.
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn collision_suffix_and_relative_path() {
        let tmp = std::env::temp_dir().join(format!("duru_test_{}", std::process::id()));
        fs::create_dir_all(&tmp).unwrap();
        let doc_path = tmp.join("문서.md").to_string_lossy().to_string();

        let r1 = place_in_assets(&doc_path, "그림.png", |dest| fs::write(dest, b"a")).unwrap();
        assert_eq!(r1, "./assets/그림.png");

        let r2 = place_in_assets(&doc_path, "그림.png", |dest| fs::write(dest, b"b")).unwrap();
        assert_eq!(r2, "./assets/그림-2.png");

        let r3 = place_in_assets(&doc_path, "그림.png", |dest| fs::write(dest, b"c")).unwrap();
        assert_eq!(r3, "./assets/그림-3.png");

        // 확장자 없는 이름도 깨지지 않아야 한다
        let r4 = place_in_assets(&doc_path, "이름없음", |dest| fs::write(dest, b"d")).unwrap();
        assert_eq!(r4, "./assets/이름없음");

        assert_eq!(fs::read(tmp.join("assets/그림.png")).unwrap(), b"a");
        assert_eq!(fs::read(tmp.join("assets/그림-2.png")).unwrap(), b"b");

        fs::remove_dir_all(&tmp).ok();
    }

    // 헤더(diff/index/---/+++/@@) 없이, 줄 번호를 우리가 계산한다(§4).
    #[test]
    fn parse_diff_computes_line_numbers() {
        let text = "diff --git a/x b/x\nindex 111..222 100644\n--- a/x\n+++ b/x\n@@ -3,4 +3,4 @@\n context1\n-old line\n+new line\n context2\n";
        let lines = parse_diff(text);
        assert_eq!(lines.len(), 4);
        assert_eq!((lines[0].kind.as_str(), lines[0].old, lines[0].new), ("ctx", Some(3), Some(3)));
        assert_eq!((lines[1].kind.as_str(), lines[1].old, lines[1].new, lines[1].text.as_str()), ("del", Some(4), None, "old line"));
        assert_eq!((lines[2].kind.as_str(), lines[2].old, lines[2].new, lines[2].text.as_str()), ("add", None, Some(4), "new line"));
        assert_eq!((lines[3].kind.as_str(), lines[3].old, lines[3].new), ("ctx", Some(5), Some(5)));
    }

    // 실제 git 을 부르는 전체 흐름: 저장소 아님 → git init(테스트 준비용, 앱은 절대 안 함, §1.3)
    // → 이름/메일 없이 버전 저장 시도(IDENTITY_UNKNOWN, §5) → --local 로 채움 → 저장 →
    // 파일 바이트 불변(§1.4/§9.2) → 기록(G4) → 변경 내용(G2) → .md 밖은 안 건드림(§1.1).
    #[test]
    fn git_flow_end_to_end() {
        let tmp = std::env::temp_dir().join(format!("duru_git_test_{}", std::process::id()));
        fs::create_dir_all(&tmp).unwrap();
        // 호스트의 전역 git 설정(이름/메일)이 새어들지 않게 격리한다.
        let fake_home = tmp.join("home");
        fs::create_dir_all(&fake_home).unwrap();
        std::env::set_var("HOME", &fake_home);
        std::env::set_var("USERPROFILE", &fake_home);
        std::env::set_var("GIT_CONFIG_NOSYSTEM", "1");

        let folder = tmp.to_string_lossy().to_string();
        assert!(git_repo_root(folder.clone()).is_none(), "저장소가 아닐 때는 None");

        Command::new("git").args(["init", "-q"]).current_dir(&tmp).output().unwrap();
        assert!(git_repo_root(folder.clone()).is_some());

        let md = tmp.join("문서.md");
        fs::write(&md, "# 제목\n\n첫 줄\n").unwrap();
        let md_path = md.to_string_lossy().to_string();

        let err = git_save_version(folder.clone(), "첫 버전".into()).unwrap_err();
        assert_eq!(err, "IDENTITY_UNKNOWN", "이름/메일 없으면 안내용 신호를 돌려줘야 한다");

        git_set_identity(folder.clone(), "테스터".into(), "tester@example.com".into()).unwrap();

        let status = git_status(folder.clone()).unwrap();
        assert_eq!(status.files.len(), 1);
        assert_eq!(status.files[0].status, "created");

        let before = fs::read(&md).unwrap();
        git_save_version(folder.clone(), "첫 버전".into()).unwrap();
        let after = fs::read(&md).unwrap();
        assert_eq!(before, after, "버전 저장이 파일 내용을 바꾸면 안 된다");

        let status2 = git_status(folder.clone()).unwrap();
        assert_eq!(status2.files.len(), 0, "저장 직후엔 바뀐 문서가 없어야 한다");

        let log = git_log_file(folder.clone(), md_path.clone()).unwrap();
        assert_eq!(log.len(), 1);
        assert_eq!(log[0].subject, "첫 버전");

        fs::write(&md, "# 제목\n\n첫 줄\n둘째 줄\n").unwrap();
        let diff = git_diff_file(folder.clone(), md_path.clone()).unwrap();
        assert!(diff.iter().any(|l| l.kind == "add" && l.text == "둘째 줄"));

        // .md/assets 밖은 절대 건드리지 않는다(§1.1)
        fs::write(tmp.join("app.rs"), "fn main() {}").unwrap();
        git_save_version(folder.clone(), "둘째 버전".into()).unwrap();
        let (_, show_out, _) = git_output(&folder, &["show", "--stat", "--format=", "HEAD"]).unwrap();
        assert!(!show_out.contains("app.rs"), "코드 파일은 버전 저장에 포함되면 안 된다");

        let log2 = git_log_file(folder.clone(), md_path).unwrap();
        assert_eq!(log2.len(), 2);
        let show =
            git_show_file(folder.clone(), log2[0].hash.clone(), md.to_string_lossy().to_string())
                .unwrap();
        assert!(show.iter().any(|l| l.kind == "add" && l.text == "둘째 줄"));

        // 이름에 띄어쓰기가 있는 문서 — git status 가 경로를 따옴표로 감싸 내보내던 탓에
        // 그 경로로 diff 를 돌리면 "변경된 내용이 없습니다" 가 나왔다. 실사용에서 잡힌 버그다.
        let spaced = tmp.join("제품 기획서.md");
        fs::write(&spaced, "# 기획서\n\n첫 줄\n").unwrap();
        git_save_version(folder.clone(), "셋째 버전".into()).unwrap();
        fs::write(&spaced, "# 기획서\n\n첫 줄\n덧붙인 줄\n").unwrap();

        let status3 = git_status(folder.clone()).unwrap();
        let changed = status3
            .files
            .iter()
            .find(|f| f.path.ends_with("제품 기획서.md"))
            .expect("띄어쓰기 있는 문서도 바뀐 목록에 나와야 한다");
        assert!(!changed.path.contains('"'), "경로에 따옴표가 섞이면 안 된다: {}", changed.path);

        let diff_spaced = git_diff_file(folder.clone(), changed.path.clone()).unwrap();
        assert!(
            diff_spaced.iter().any(|l| l.kind == "add" && l.text == "덧붙인 줄"),
            "바뀐 목록에서 받은 경로로 비교가 되어야 한다"
        );

        fs::remove_dir_all(&tmp).ok();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            // 업데이트 확인·설치 (모바일에는 해당 없음)
            #[cfg(desktop)]
            {
                app.handle().plugin(tauri_plugin_updater::Builder::new().build())?;
                app.handle().plugin(tauri_plugin_process::init())?;
            }
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_md_tree,
            create_md_file,
            read_md_file,
            write_md_file,
            stat_md_file,
            read_image_bytes,
            copy_image_to_assets,
            save_image_bytes_to_assets,
            load_last_folder,
            save_last_folder,
            load_settings,
            save_settings,
            git_repo_root,
            git_status,
            git_diff_file,
            git_save_version,
            git_set_identity,
            git_log_file,
            git_show_file,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
