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
#   .\tools\sync-usb.ps1 -Watch     # sit and wait; sync each stick as it is plugged in
#
# audit.conf is NEVER touched: it is untracked on purpose (Wi-Fi password, server
# credentials, wipe defaults) and differs legitimately per stick. Use
# audit.conf.example as the reference if you need to rebuild one.

param(
    [string] $Drive,
    [switch] $Apply,
    [switch] $Watch
)

$ErrorActionPreference = 'Stop'
$toolsDir = Split-Path -Parent $MyInvocation.MyCommand.Path

# Source under tools\  ->  destination relative to the stick root.
$files = [ordered]@{
    'hardware-audit.sh'      = 'hardware-audit.sh'
    # hardware-audit.sh SOURCES this. It is guarded, so a stick with the new
    # audit script but without this file skips every lock check in silence and
    # looks like it simply found nothing — exactly the partial-sync failure
    # described above. The two must travel together.
    'lock-checks.sh'         = 'lock-checks.sh'
    # Locates the tools partition by label on an Ubuntu stick, where the boot
    # medium is read-only ISO9660 and the tools live on a second partition.
    'find-media.sh'          = 'find-media.sh'
    # Builds the overlay layer that makes the stick boot into the kiosk and
    # carries nvme-cli/smartmontools. Has to run FROM the live session, so it
    # only helps if it is actually on the stick.
    'make-als-layer.sh'      = 'make-als-layer.sh'
    'autorun'                = 'autorun\autorun'
    'hardware-audit.desktop' = 'hardware-audit.desktop'
    'gui\index.html'         = 'gui\index.html'
    'gui\server.py'          = 'gui\server.py'
    'gui\start-gui.sh'       = 'gui\start-gui.sh'
    'gui\fullscreen-x.py'    = 'gui\fullscreen-x.py'
    'gui\install-os.sh'      = 'gui\install-os.sh'
    'gui\install-cage.sh'    = 'gui\install-cage.sh'
    # The autostart trio. The .desktop and the shim are SOURCES that
    # make-als-layer.sh bakes into the overlay layer; als-autostart.sh is read
    # from the stick at every boot, so it can be edited from Windows without
    # rebuilding anything. gui\autostart.mode is deliberately NOT synced - it is
    # the operator's setting and a sync would overwrite their choice.
    'gui\als-audit-station.desktop' = 'gui\als-audit-station.desktop'
    'gui\als-autostart-shim.sh'     = 'gui\als-autostart-shim.sh'
    'gui\als-autostart.sh'          = 'gui\als-autostart.sh'
    # Installs the autostart into the live user's home so it can be tried
    # with a logout instead of a boot. One command, no tildes to mistype.
    'gui\als-autostart-test.sh'     = 'gui\als-autostart-test.sh'
    # Sources for the kiosk SESSION, baked into the layer by
    # make-als-layer.sh --with-session. They have to be ON the stick because
    # that script runs from the live session, not from Windows.
    'gui\layer\gdm3-custom.conf'       = 'gui\layer\gdm3-custom.conf'
    'gui\layer\accountsservice-ubuntu' = 'gui\layer\accountsservice-ubuntu'
    'gui\layer\als-kiosk.desktop'      = 'gui\layer\als-kiosk.desktop'
    'gui\layer\als-session.sh'         = 'gui\layer\als-session.sh'
}

# Whole directories, same rules: compare by hash, copy what differs.
#
# This exists because of a bug that hid for months. make-als-layer.sh installs
# the plymouth theme into the layer so the SHUTDOWN splash is ours - but it
# looks for that theme at <stick>\boot\theme, and the file list above has never
# carried a single boot\ entry. So the theme was never on the stick, the build
# printed "no theme - shutdown will show Ubuntu's splash", and then exited
# SUCCESSFULLY. A warning nobody was watching for, followed by a green tick.
#
# als-splash.img is deliberately NOT here. It is the BOOT splash, it is already
# working on hardware, and the copy on the stick is the one that was proven.
# prep-stick.ps1 compares it and reports rather than overwriting, so a
# regenerated archive can never silently replace a known-good one.
$trees = [ordered]@{
    'boot\dist\theme' = 'boot\theme'
}

# Set by Sync-Stick instead of returned. In PowerShell a function's Write-Output
# goes to the pipeline, so assigning its result would capture the whole report
# into the caller's variable and print nothing at all.
$script:SyncFailed = $false

function Get-Sha { param($p) if (Test-Path $p) { (Get-FileHash $p -Algorithm SHA256).Hash } else { $null } }

# A stick is "an audit stick" if it carries the engine. Deliberately strict: this
# script writes to whatever it picks, so it must never guess at a random drive.
function Find-AuditStick {
    Get-Volume |
        Where-Object { $_.DriveType -eq 'Removable' -and $_.DriveLetter } |
        Where-Object { Test-Path "$($_.DriveLetter):\hardware-audit.sh" } |
        ForEach-Object { "$($_.DriveLetter):" }
}

# "commit X, synced <when>" on the stick, so "is this stick current?" can be
# answered by looking rather than by hashing 47 files by hand.
#
# Called on EVERY -Apply, including the run where nothing differed. It used to
# be written only after a file was copied, which meant a stick that was already
# perfectly up to date kept an older commit on it - and the one question the
# stamp exists to answer got a misleading answer. It records the commit this
# stick was VERIFIED against, not the last commit that happened to change a file.
function Write-Stamp {
    param([string] $Target, [string] $ToolsDir)
    try {
        $commit = & git -C $ToolsDir rev-parse --short HEAD 2>$null
        if ($LASTEXITCODE -ne 0) { $commit = 'unknown' }
    } catch { $commit = 'unknown' }
    $stampPath = Join-Path $Target 'gui\.stick-version'
    $parent = Split-Path -Parent $stampPath
    if (-not (Test-Path $parent)) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
    "commit $commit"                         | Out-File -FilePath $stampPath -Encoding utf8
    ("synced {0}" -f (Get-Date -Format 's')) | Out-File -FilePath $stampPath -Encoding utf8 -Append
    Write-Output ("  stamped gui\.stick-version   commit {0}" -f $commit)
}

function Sync-Stick {
    param([string] $Target, [switch] $DoApply)

    $Target = $Target.TrimEnd('\')
    # Only a bare letter gets a colon appended. Matching on ':$' instead would mangle a
    # full path (used for testing) into "C:\...\dir:" and report every file missing.
    # ${Target} braces are required: "$Target:" parses as a drive-qualified variable.
    if ($Target -match '^[A-Za-z]$') { $Target = "${Target}:" }

    $label = $null
    if ($Target -match '^[A-Za-z]:$') {
        $label = (Get-Volume -DriveLetter $Target[0] -ErrorAction SilentlyContinue).FileSystemLabel
    }
    Write-Output "Stick   : $Target  ($label)"
    Write-Output "Repo    : $toolsDir"
    Write-Output ("Mode    : " + $(if ($DoApply) { 'APPLY - differing files will be copied' } else { 'REPORT ONLY - nothing will be written' }))
    Write-Output ''

    $same = 0; $diff = @(); $missing = @()

    # Directories first, so a missing tree is the first thing reported rather
    # than the last thing scrolled past.
    foreach ($tsrc in $trees.Keys) {
        $treeRoot = Join-Path $toolsDir $tsrc
        if (-not (Test-Path $treeRoot)) { Write-Output ("  ?  {0,-24} not in the repo - skipped" -f $tsrc); continue }
        $n = 0; $nDiff = 0; $nMiss = 0
        foreach ($f in Get-ChildItem $treeRoot -Recurse -File) {
            $rel = $f.FullName.Substring($treeRoot.Length).TrimStart('\')
            $dst = Join-Path (Join-Path $Target $trees[$tsrc]) $rel
            $a = Get-Sha $f.FullName
            $b = Get-Sha $dst
            $n++
            if ($null -eq $b) { $nMiss++; $missing += ,@($f.FullName, $dst) }
            elseif ($a -ne $b) { $nDiff++; $diff += ,@($f.FullName, $dst) }
            else { $same++ }
        }
        if ($nMiss -eq 0 -and $nDiff -eq 0) {
            Write-Output ("  =  {0,-24} up to date ({1} files)" -f $tsrc, $n)
        } else {
            Write-Output ("  ~  {0,-24} {1} missing, {2} differing of {3} files" -f $tsrc, $nMiss, $nDiff, $n)
        }
    }

    foreach ($src in $files.Keys) {
        $srcPath = Join-Path $toolsDir $src
        $dstPath = Join-Path $Target $files[$src]
        if (-not (Test-Path $srcPath)) { Write-Output ("  ?  {0,-24} not in the repo - skipped" -f $src); continue }

        $a = Get-Sha $srcPath
        $b = Get-Sha $dstPath
        if ($null -eq $b)   { $missing += ,@($srcPath, $dstPath); Write-Output ("  +  {0,-24} MISSING on the stick" -f $src) }
        elseif ($a -ne $b)  { $diff    += ,@($srcPath, $dstPath); Write-Output ("  ~  {0,-24} DIFFERS" -f $src) }
        else                { $same++;          Write-Output ("  =  {0,-24} up to date" -f $src) }
    }

    # audit.conf: report only, never sync.
    $conf = Join-Path $Target 'audit.conf'
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

    if ($todo.Count -eq 0) {
        Write-Output 'Stick matches the repo. Nothing to copy.'
        if ($DoApply) {
            # Still stamp it. The stick IS current; recording that is the whole
            # point, and refusing to say so because no bytes moved is how a
            # good stick ends up looking stale.
            Write-Stamp -Target $Target -ToolsDir $toolsDir
            if ($Target -match '^[A-Za-z]:$') {
                try { Write-VolumeCache -DriveLetter $Target[0] -ErrorAction Stop } catch {}
            }
        }
        return
    }
    if (-not $DoApply) {
        Write-Output ''
        Write-Output 'Re-run with -Apply to copy the files listed above.'
        return
    }

    Write-Output ''
    $bad = 0
    foreach ($pair in $todo) {
        $srcPath = $pair[0]
        $dstPath = $pair[1]
        $label   = $srcPath.Substring($toolsDir.Length).TrimStart('\')
        $parent  = Split-Path -Parent $dstPath
        if (-not (Test-Path $parent)) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
        Copy-Item -Path $srcPath -Destination $dstPath -Force
        $ok = (Get-Sha $srcPath) -eq (Get-Sha $dstPath)
        Write-Output ("  copied {0,-40} verified={1}" -f $label, $ok)
        if (-not $ok) { $bad++; Write-Output '     ^ HASH MISMATCH after copy - the stick may be full or write-protected.' }
    }

    # Stamp which commit this stick is carrying. "Is this stick current?" was
    # previously unanswerable without hashing every file by hand, and a stale
    # stick looks exactly like a working one until it misbehaves on a bench.
    Write-Stamp -Target $Target -ToolsDir $toolsDir

    # Get-FileHash above can be served from the OS cache, so "verified=True" does
    # NOT by itself prove the bytes reached the flash. Force the volume's write
    # cache out before anyone yanks the stick.
    if ($Target -match '^[A-Za-z]:$') {
        try {
            Write-VolumeCache -DriveLetter $Target[0] -ErrorAction Stop
            Write-Output '  flushed write cache to the device'
        } catch {
            Write-Output '  (could not flush the write cache - use Safely Remove Hardware before unplugging)'
        }
    }

    Write-Output ''
    if ($bad -gt 0) {
        Write-Output ("{0} FILE(S) FAILED TO COPY - do not use this stick until it reports clean." -f $bad)
        $script:SyncFailed = $true
        return
    }
    Write-Output 'Done. If gui\server.py was among the copied files, REBOOT the audit machine -'
    Write-Output 'the backend is loaded once at boot, so reloading the page is not enough.'
}

# --- watch mode: sync each stick as it appears ------------------------------
if ($Watch) {
    Write-Output 'Watching for audit sticks. Plug one in. Ctrl+C to stop.'
    Write-Output ''
    $seen = @{}
    while ($true) {
        $found = @(Find-AuditStick)
        foreach ($d in $found) {
            if (-not $seen.ContainsKey($d)) {
                # Windows publishes the volume slightly before it is reliably
                # readable; syncing immediately can read a half-mounted tree and
                # report every file as missing.
                Start-Sleep -Seconds 2
                if (-not (Test-Path "$d\hardware-audit.sh")) { continue }
                Write-Output ''
                Write-Output ('=' * 62)
                Write-Output ("  Stick detected at {0} - {1}" -f $d, (Get-Date -Format 'HH:mm:ss'))
                Write-Output ('=' * 62)
                Sync-Stick -Target $d -DoApply
                Write-Output ''
                Write-Output 'Waiting for the next stick...'
            }
        }
        $fresh = @{}
        foreach ($d in $found) { $fresh[$d] = $true }
        $seen = $fresh
        Start-Sleep -Seconds 2
    }
}

# --- single run -------------------------------------------------------------
if (-not $Drive) {
    $candidates = @(Find-AuditStick)
    if (-not $candidates) {
        Write-Output 'No audit stick found. Plug one in, or pass -Drive E:'
        Write-Output 'Removable drives currently visible:'
        Get-Volume | Where-Object { $_.DriveType -eq 'Removable' -and $_.DriveLetter } |
            ForEach-Object { Write-Output ("  {0}:  {1}" -f $_.DriveLetter, $_.FileSystemLabel) }
        exit 1
    }
    if ($candidates.Count -gt 1) {
        Write-Output 'More than one audit stick is plugged in. Pick one with -Drive:'
        $candidates | ForEach-Object { Write-Output ("  -Drive {0}" -f $_) }
        exit 1
    }
    $Drive = $candidates[0]
}

Sync-Stick -Target $Drive -DoApply:$Apply
if ($script:SyncFailed) { exit 1 }
exit 0
