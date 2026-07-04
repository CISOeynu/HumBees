# bumblebee agent uninstaller for Windows (PowerShell)
#
# Usage:
#   powershell -ExecutionPolicy Bypass "irm http://SERVER:PORT/uninstall.ps1 | iex"
#
$InstallDir = "$env:USERPROFILE\.bumblebee"

function Log($msg) { Write-Host "[bumblebee-uninstall] $msg" }

$removed = $false

# remove scheduled task
if (schtasks /Query /TN "BumblebeeScan" 2>$null) {
    schtasks /Delete /TN "BumblebeeScan" /F | Out-Null
    Log "removed Task Scheduler task: BumblebeeScan"
    $removed = $true
} else {
    Log "no scheduled task found"
}

# kill any running scan
Get-Process -Name "bumblebee" -ErrorAction SilentlyContinue | Stop-Process -Force
    
# remove install directory
if (Test-Path $InstallDir) {
    Remove-Item -Recurse -Force $InstallDir
    Log "removed $InstallDir"
    $removed = $true
} else {
    Log "install dir not found: $InstallDir"
}

if ($removed) { Log "bumblebee agent removed from this machine" }
else          { Log "nothing to remove — agent does not appear to be installed" }
