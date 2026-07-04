# bumblebee agent installer for Windows (PowerShell)
# Served pre-configured by bumblebee-server — no Git Bash required.
#
# One-line usage (run in PowerShell as normal user):
#   powershell -ExecutionPolicy Bypass "irm http://SERVER:PORT/install.ps1 | iex"
#
$Server       = "__SERVER__"
$Port         = "__PORT__"
$IntervalHours = 6
$Profile      = "baseline"
$Version      = "latest"
$InstallDir   = "$env:USERPROFILE\.bumblebee"

$BinDir  = "$InstallDir\bin"
$LogDir  = "$InstallDir\logs"
$BinPath = "$BinDir\bumblebee.exe"

function Log($msg) { Write-Host "[bumblebee-install] $msg" }

# ── create directories ─────────────────────────────────────────────────
New-Item -ItemType Directory -Force -Path $BinDir  | Out-Null
New-Item -ItemType Directory -Force -Path $LogDir  | Out-Null

# ── detect architecture ────────────────────────────────────────────────
$Arch = if ($env:PROCESSOR_ARCHITECTURE -eq "ARM64") { "arm64" } else { "amd64" }
Log "platform: windows/$Arch"

# ── resolve download URL ───────────────────────────────────────────────
if ($Version -eq "latest") {
    Log "resolving latest release from GitHub..."
    try {
        $rel = Invoke-RestMethod "https://api.github.com/repos/perplexityai/bumblebee/releases/latest"
        $Tag = $rel.tag_name
    } catch {
        Write-Error "could not fetch latest release from GitHub: $_"; exit 1
    }
} else {
    $Tag = $Version
}
$Ver = $Tag.TrimStart("v")
$TarUrl = "https://github.com/perplexityai/bumblebee/releases/download/$Tag/bumblebee_${Ver}_windows_${Arch}.tar.gz"
Log "downloading $TarUrl"

# ── download and extract ───────────────────────────────────────────────
$TmpDir = [System.IO.Path]::Combine([System.IO.Path]::GetTempPath(), [System.IO.Path]::GetRandomFileName())
New-Item -ItemType Directory -Path $TmpDir | Out-Null
$TarFile = "$TmpDir\bumblebee.tar.gz"

try {
    Invoke-WebRequest -Uri $TarUrl -OutFile $TarFile -UseBasicParsing
} catch {
    Write-Error "download failed: $_"; Remove-Item -Recurse $TmpDir; exit 1
}

# Windows 10 1803+ ships tar.exe
tar -xzf $TarFile -C $TmpDir
$Exe = Get-ChildItem -Path $TmpDir -Filter "bumblebee.exe" -Recurse | Select-Object -First 1
if (-not $Exe) { Write-Error "bumblebee.exe not found in archive"; Remove-Item -Recurse $TmpDir; exit 1 }

Copy-Item -Path $Exe.FullName -Destination $BinPath -Force
Remove-Item -Recurse $TmpDir
Log "installed: $BinPath"

# ── create wrapper batch file ──────────────────────────────────────────
$HttpUrl    = "http://${Server}:${Port}/ingest"
$WrapperPath = "$InstallDir\run-scan.cmd"
$WrapperContent = "@echo off`r`n`"$BinPath`" scan --profile $Profile --output http --http-url $HttpUrl --http-gzip --http-allow-insecure >> `"$LogDir\scan.log`" 2>&1`r`n"
[System.IO.File]::WriteAllText($WrapperPath, $WrapperContent)

# ── schedule task ──────────────────────────────────────────────────────
schtasks /Create /F /SC HOURLY /MO $IntervalHours /TN "BumblebeeScan" /TR "`"$WrapperPath`"" /RL LIMITED | Out-Null
Log "scheduled Task Scheduler task every ${IntervalHours}h"

# ── run initial scan ───────────────────────────────────────────────────
Log "running initial scan..."
& $BinPath scan --profile $Profile --output http --http-url $HttpUrl --http-gzip --http-allow-insecure 2>&1 | Out-Null
Log "done — reporting to http://${Server}:${Port} every ${IntervalHours}h"
Log "view results at http://${Server}:${Port}"
