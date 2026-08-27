# 두루 — 바탕화면 바로가기 만들기
#
# 릴리스 실행 파일을 가리키는 바로가기를 바탕화면에 만든다.
# 바로가기라서 다시 빌드하면 그 결과가 자동으로 반영된다 (복사가 아님).
#
#   빌드:  npx tauri build --no-bundle
#   설치:  powershell -ExecutionPolicy Bypass -File 두루-바탕화면에-설치.ps1

$ErrorActionPreference = 'Stop'

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$exe  = Join-Path $here 'src-tauri\target\release\duru.exe'

if (-not (Test-Path $exe)) {
    # productName 이 바뀌었을 수 있으니 release 폴더에서 찾아본다
    $found = Get-ChildItem (Join-Path $here 'src-tauri\target\release') -Filter '*.exe' -ErrorAction SilentlyContinue |
             Where-Object { $_.Name -notmatch '^(build|deps)' } | Select-Object -First 1
    if ($found) { $exe = $found.FullName }
    else {
        Write-Host '실행 파일이 없습니다. 먼저 빌드하세요:' -ForegroundColor Yellow
        Write-Host '  npx tauri build --no-bundle'
        exit 1
    }
}

$desktop = [Environment]::GetFolderPath('Desktop')
$link    = Join-Path $desktop '두루.lnk'

$shell = New-Object -ComObject WScript.Shell
$sc = $shell.CreateShortcut($link)
$sc.TargetPath       = $exe
$sc.WorkingDirectory = Split-Path -Parent $exe
$sc.Description      = '두루 — 워드처럼 작성하고 마크다운으로 저장한다'
$sc.Save()

Write-Host '바탕화면에 만들었습니다:' -ForegroundColor Green
Write-Host "  $link"
Write-Host "  → $exe"
