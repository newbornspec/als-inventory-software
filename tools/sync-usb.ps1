# Sync an audit USB stick with this repo.
#
# Hand-copying files onto sticks has twice left one partially updated, and the
# symptoms look like application bugs rather than a stale file: a stick with new
# gui/ files but an old hardware-audit.sh reported grades correctly while silently
# capturing no screen size. This compares every file by SHA256 and tells you.
#
#   .\tools\sync-usb.ps1            # report only, changes nothing
#   .\tools\sync-usb.ps1 -Apply     # copy the files that differ
#   .\tools\sync-usb.ps1 -Drive E: -Apply
#
# audit.conf is NEVER touched: it is untracked on purpose (Wi-Fi password, server
# credentials, wipe defaults) and differs legitimately per stick. Use
# audit.conf.example as the reference if you need to rebuild one.

param(
    [string] $Drive,
    [switch] $Apply
)

$ErrorActionPreference = 'Stop'
$toolsDir = Split-Path -Parent $MyInvocation.MyCommand.Path

# Source under tools\  ->  destination relative to the stick root.
$files = [ordered]@{
    'hardware-audit.sh'      = 'hardware-audit.sh'
    'autorun'                = 'autorun\autorun'
    'hardware-audit.desktop' = 'hardware-audit.desktop'
    'gui\index.html'         = 'gui\index.html'
    'gui\server.py'          = 'gui\server.py'
    'gui\start-gui.sh'       = 'gui\start-gui.sh'
    'gui\fullscreen-x.py'    = 'gui\fullscreen-x.py'
    'gui\install-os.sh'      = 'gui\install-os.sh'
    'gui\install-cage.sh'    = 'gui\install-cage.sh'
}

# --- find the stick ---------------------------------------------------------
if (-not $Drive) {
    $candidates = Get-Volume |
        Where-Object { $_.DriveType -eq 'Removable' -and $_.DriveLetter } |
        Where-Object { Test-Path "$($_.DriveLetter):\hardware-audit.sh" }
    if (-not $candidates) {
        Write-Output 'No audit stick found. Plug one in, or pass -Drive E:'
        Write-Output 'Removable drives currently visible:'
        Get-Volume | Where-Object { $_.DriveType -eq 'Removable' -and $_.DriveLetter } |
            ForEach-Object { Write-Output ("  {0}:  {1}" -f $_.DriveLetter, $_.FileSystemLabel) }
        exit 1
    }
    if ($candidates.Count -gt 1) {
        Write-Output 'More than one audit stick is plugged in. Pick one with -Drive:'
        $candidates | ForEach-Object { Write-Output ("  -Drive {0}:  {1}" -f $_.DriveLetter, $_.FileSystemLabel) }
        exit 1
    }
    $Drive = "$($candidates.DriveLetter):"
}
$Drive = $Drive.TrimEnd('\')
# Only a bare letter gets a colon appended. Matching on ':$' instead would mangle a
# full path (used for testing) into "C:\...\dir:" and report every file missing.
# ${Drive} braces are required: "$Drive:" parses as a drive-qualified variable.
if ($Drive -match '^[A-Za-z]$') { $Drive = "${Drive}:" }

$label = (Get-Volume -DriveLetter $Drive[0] -ErrorAction SilentlyContinue).FileSystemLabel
Write-Output "Stick   : $Drive  ($label)"
Write-Output "Repo    : $toolsDir"
Write-Output ("Mode    : " + $(if ($Apply) { 'APPLY - differing files will be copied' } else { 'REPORT ONLY - nothing will be written' }))
Write-Output ''

function Get-Sha { param($p) if (Test-Path $p) { (Get-FileHash $p -Algorithm SHA256).Hash } else { $null } }

$same = 0; $diff = @(); $missing = @()

foreach ($src in $files.Keys) {
    $srcPath = Join-Path $toolsDir $src
    $dstPath = Join-Path $Drive $files[$src]
    if (-not (Test-Path $srcPath)) { Write-Output ("  ?  {0,-24} not in the repo - skipped" -f $src); continue }

    $a = Get-Sha $srcPath
    $b = Get-Sha $dstPath
    if ($null -eq $b)   { $missing += $src; Write-Output ("  +  {0,-24} MISSING on the stick" -f $src) }
    elseif ($a -ne $b)  { $diff    += $src; Write-Output ("  ~  {0,-24} DIFFERS" -f $src) }
    else                { $same++;          Write-Output ("  =  {0,-24} up to date" -f $src) }
}

# audit.conf: report only, never sync.
$conf = Join-Path $Drive 'audit.conf'
Write-Output ''
if (Test-Path $conf) {
    Write-Output "  !  audit.conf              present - LEFT ALONE (holds this stick's Wi-Fi/credentials)"
} else {
    Write-Output "  !  audit.conf              NOT PRESENT - this stick cannot log in or join Wi-Fi."
    Write-Output "                             Create it from tools\audit.conf.example."
}

$todo = $diff + $missing
Write-Output ''
Write-Output ("Up to date: {0}   Differs: {1}   Missing: {2}" -f $same, $diff.Count, $missing.Count)

if ($todo.Count -eq 0) { Write-Output 'Stick matches the repo. Nothing to do.'; exit 0 }

if (-not $Apply) {
    Write-Output ''
    Write-Output 'Re-run with -Apply to copy the files listed above.'
    exit 0
}

Write-Output ''
foreach ($src in $todo) {
    $srcPath = Join-Path $toolsDir $src
    $dstPath = Join-Path $Drive $files[$src]
    $parent  = Split-Path -Parent $dstPath
    if (-not (Test-Path $parent)) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
    Copy-Item -Path $srcPath -Destination $dstPath -Force
    $ok = (Get-Sha $srcPath) -eq (Get-Sha $dstPath)
    Write-Output ("  copied {0,-24} verified={1}" -f $src, $ok)
    if (-not $ok) { Write-Output '     ^ HASH MISMATCH after copy - the stick may be full or write-protected.' }
}

Write-Output ''
Write-Output 'Done. If gui\server.py was among the copied files, REBOOT the audit machine -'
Write-Output 'the backend is loaded once at boot, so reloading the page is not enough.'
