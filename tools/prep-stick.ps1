# Back up an audit stick, report its real state, and apply the boot changes
# that sync-usb.ps1 deliberately does not touch.
#
# sync-usb.ps1 carries the application. This carries the BOOT: grub.cfg, the
# splash archive, the volume label. Those are kept apart on purpose - a bad
# application file is a bad screen, a bad grub.cfg is a machine that will not
# start, and the two should never travel on the same command by accident.
#
#   .\tools\prep-stick.ps1              # report only, changes nothing
#   .\tools\prep-stick.ps1 -Apply       # back up first, then apply
#   .\tools\prep-stick.ps1 -Apply -Drive E:
#
# WHAT -Apply DOES, in order:
#   1. Copies grub.cfg, als-splash.img and the ALS layer (+ its manifest) to a
#      dated folder on the Windows desktop. Nothing else runs until that works.
#   2. Writes boot\grub\grub.cfg.als-prev - the "last known good" backup the
#      grub.cfg header has always told people to rely on, which until now NO
#      script in this repo has ever actually created.
#   3. Installs the repo's grub.cfg and verifies it by hash.
#   4. Deletes als-menu.txt if it is there (it forces a 60-second menu on EVERY
#      boot - fine while debugging, expensive if forgotten).
#   5. Renames the volume ALSAUDIT, so the firmware boot menu stops saying
#      UBUNTU 24_0. Bonus: find-media.sh already looks for exactly that name.
#
# audit.conf is never read, copied or backed up. It holds this stick's Wi-Fi
# password and server credentials, and a backup folder is not the place for them.

param(
    [string] $Drive,
    [switch] $Apply,
    [string] $BackupTo,
    [string] $NewLabel = 'ALSAUDIT'
)

$ErrorActionPreference = 'Stop'
$toolsDir = Split-Path -Parent $MyInvocation.MyCommand.Path

function Get-Sha { param($p) if (Test-Path $p) { (Get-FileHash $p -Algorithm SHA256).Hash } else { $null } }
function HumanSize { param([double]$b)
    if ($b -ge 1GB) { return ('{0:N2} GB' -f ($b / 1GB)) }
    if ($b -ge 1MB) { return ('{0:N1} MB' -f ($b / 1MB)) }
    return ('{0:N0} KB' -f ($b / 1KB))
}

function Find-AuditStick {
    Get-Volume |
        Where-Object { $_.DriveType -eq 'Removable' -and $_.DriveLetter } |
        Where-Object { Test-Path "$($_.DriveLetter):\hardware-audit.sh" } |
        ForEach-Object { "$($_.DriveLetter):" }
}

if (-not $Drive) {
    $found = @(Find-AuditStick)
    if (-not $found)            { Write-Output 'No audit stick found. Plug one in, or pass -Drive E:'; exit 1 }
    if ($found.Count -gt 1)     { Write-Output 'More than one audit stick is plugged in. Pick one with -Drive.'; exit 1 }
    $Drive = $found[0]
}
$Drive = $Drive.TrimEnd('\')
if ($Drive -match '^[A-Za-z]$') { $Drive = "${Drive}:" }

$label = $null
if ($Drive -match '^[A-Za-z]:$') {
    $vol = Get-Volume -DriveLetter $Drive[0] -ErrorAction SilentlyContinue
    if ($vol) { $label = $vol.FileSystemLabel }
}

Write-Output "Stick : $Drive  ($label)"
Write-Output "Repo  : $toolsDir"
Write-Output ("Mode  : " + $(if ($Apply) { 'APPLY - the stick will be backed up, then changed' } else { 'REPORT ONLY - nothing will be written' }))
Write-Output ''

# ---------------------------------------------------------------- the report
Write-Output '--- WHAT IS ON THE STICK ---------------------------------------'

$modes = @{}
foreach ($m in 'autostart.mode', 'kiosk.mode') {
    $mp = Join-Path $Drive "gui\$m"
    if (Test-Path $mp) {
        $val = (Get-Content $mp -Raw).Trim()
        $modes[$m] = $val
        Write-Output ("  gui\{0,-16} '{1}'" -f $m, $val)
    } else {
        $modes[$m] = $null
        Write-Output ("  gui\{0,-16} NOT PRESENT" -f $m)
    }
}
if ($modes['kiosk.mode'] -ne 'on') {
    Write-Output '      -> kiosk session is OFF, so the full Ubuntu desktop draws behind the app.'
}

# als-menu.txt: four spellings, because Explorer hides extensions and GRUB's
# FAT lookup is case-insensitive but nobody should bet a dead machine on that.
# Deduplicated by resolved path, not by spelling. Windows is case-insensitive,
# so all four spellings match the SAME file and the list came back with
# duplicates - which meant the delete below ran twice on one file and the second
# call aborted the script half way through applying. Caught on a fake stick.
$menuFiles = @()
foreach ($n in 'als-menu', 'als-menu.txt', 'ALS-MENU', 'ALS-MENU.TXT') {
    $f = Join-Path $Drive $n
    if (Test-Path $f) {
        $full = (Resolve-Path $f).Path
        if ($menuFiles -notcontains $full) { $menuFiles += $full }
    }
}
if ($menuFiles.Count) {
    $names = ($menuFiles | ForEach-Object { Split-Path -Leaf $_ }) -join ', '
    Write-Output ("  als-menu file    PRESENT ({0}) - forces a 60s menu on EVERY boot" -f $names)
} else {
    Write-Output '  als-menu file    absent (good - no forced menu)'
}

$themeDir = Join-Path $Drive 'boot\theme'
if (Test-Path $themeDir) {
    $n = @(Get-ChildItem $themeDir -Recurse -File).Count
    Write-Output ("  boot\theme       present ({0} files) - the shutdown splash CAN be built" -f $n)
} else {
    Write-Output '  boot\theme       MISSING - a --with-session build would print "no theme"'
    Write-Output '                   and then exit successfully. Run sync-usb.ps1 -Apply.'
}

# The BOOT splash. Compared, never overwritten here: the copy on the stick is
# the one proven on hardware, and make-splash.py rewrites this file from
# scratch, so a regenerated archive could silently replace a working one.
$stickSplash = Join-Path $Drive 'als-splash.img'
$repoSplash  = Join-Path $toolsDir 'boot\dist\als-splash.img'
if (-not (Test-Path $stickSplash)) {
    Write-Output '  als-splash.img   MISSING on the stick - GRUB will drop to its shell. FIX BEFORE BOOTING.'
} elseif ((Get-Sha $stickSplash) -eq (Get-Sha $repoSplash)) {
    Write-Output '  als-splash.img   present, identical to the repo copy'
} else {
    Write-Output '  als-splash.img   present but DIFFERS from the repo copy.'
    Write-Output '                   Left alone on purpose - the stick copy is the one proven to boot.'
}

foreach ($b in 'boot\grub\grub.cfg.als-orig', 'boot\grub\grub.cfg.als-prev') {
    $f = Join-Path $Drive $b
    Write-Output ("  {0,-32} {1}" -f $b, $(if (Test-Path $f) { 'present' } else { 'MISSING' }))
}

Write-Output ''
Write-Output '--- WHAT THE MACHINE HAS TO READ BEFORE IT STARTS ---------------'
foreach ($f in 'casper\vmlinuz', 'casper\initrd') {
    $p = Join-Path $Drive $f
    if (Test-Path $p) { Write-Output ("  {0,-46} {1}" -f $f, (HumanSize (Get-Item $p).Length)) }
}
$layers = @(Get-ChildItem (Join-Path $Drive 'casper') -Filter '*.squashfs' -ErrorAction SilentlyContinue)
$total = 0
foreach ($l in $layers) {
    $total += $l.Length
    Write-Output ("  casper\{0,-39} {1}" -f $l.Name, (HumanSize $l.Length))
}
if ($layers.Count) { Write-Output ("  {0,-46} {1}" -f 'TOTAL compressed system', (HumanSize $total)) }

$stampFile = Join-Path $Drive 'gui\.stick-version'
if (Test-Path $stampFile) {
    Write-Output ''
    Write-Output '--- STICK VERSION -----------------------------------------------'
    Get-Content $stampFile | ForEach-Object { Write-Output "  $_" }
}

if (-not $Apply) {
    Write-Output ''
    Write-Output 'Re-run with -Apply to back the stick up and install the boot changes.'
    exit 0
}

# ------------------------------------------------------------------- backup
Write-Output ''
Write-Output '--- BACKUP ------------------------------------------------------'
if (-not $BackupTo) {
    $stamp = Get-Date -Format 'yyyy-MM-dd_HHmm'
    $BackupTo = Join-Path ([Environment]::GetFolderPath('Desktop')) "als-stick-backup\$stamp"
}
New-Item -ItemType Directory -Force -Path $BackupTo | Out-Null

$toSave = @(
    @('boot\grub\grub.cfg', 'grub.cfg'),
    @('als-splash.img',     'als-splash.img')
)
# ONLY the ALS layer, not all 44. The first run of this copied 3.92 GB to the
# desktop, and 3.9 GB of that was Ubuntu's own layers - byte-identical to the
# ISO, never written by anything here, and recoverable by re-imaging a stick.
# The layer we build is the only one we can break, so it is the only one worth
# carrying. Backing up everything is not thoroughness; it is 4 GB of noise that
# makes the one file that matters harder to find.
foreach ($l in $layers) {
    if ($l.Name -like '*.als.squashfs') { $toSave += ,@("casper\$($l.Name)", $l.Name) }
}
foreach ($m in @(Get-ChildItem (Join-Path $Drive 'casper') -Filter '*.als.manifest' -ErrorAction SilentlyContinue)) {
    $toSave += ,@("casper\$($m.Name)", $m.Name)
}

$saved = 0
foreach ($pair in $toSave) {
    $src = Join-Path $Drive $pair[0]
    if (-not (Test-Path $src)) { Write-Output ("  --  {0} not on the stick - nothing to save" -f $pair[0]); continue }
    $dst = Join-Path $BackupTo $pair[1]
    Copy-Item $src $dst -Force
    if ((Get-Sha $src) -eq (Get-Sha $dst)) {
        $saved++
        Write-Output ("  ok  {0,-44} {1}" -f $pair[0], (HumanSize (Get-Item $dst).Length))
    } else {
        Write-Output ("  !!  {0} DID NOT COPY CLEANLY" -f $pair[0])
        Write-Output '      Refusing to change anything without a verified backup.'
        exit 1
    }
}
Write-Output "  saved $saved file(s) to $BackupTo"
if ($saved -eq 0) { Write-Output '  Nothing was backed up. Refusing to continue.'; exit 1 }

# ------------------------------------------------------------------- apply
Write-Output ''
Write-Output '--- APPLYING ----------------------------------------------------'

# 1. The last-known-good grub backup that nothing has ever written.
$stickGrub = Join-Path $Drive 'boot\grub\grub.cfg'
if (Test-Path $stickGrub) {
    Copy-Item $stickGrub (Join-Path $Drive 'boot\grub\grub.cfg.als-prev') -Force
    Write-Output '  wrote boot\grub\grub.cfg.als-prev (the current config, before we touch it)'
    if (-not (Test-Path (Join-Path $Drive 'boot\grub\grub.cfg.als-orig'))) {
        Copy-Item $stickGrub (Join-Path $Drive 'boot\grub\grub.cfg.als-orig') -Force
        Write-Output '  wrote boot\grub\grub.cfg.als-orig as well (there was none)'
    }
} else {
    Write-Output '  no boot\grub\grub.cfg on the stick - is this really an Ubuntu live stick?'
    exit 1
}

# 2. Install the repo grub.cfg.
$repoGrub = Join-Path $toolsDir 'boot\grub.cfg'
Copy-Item $repoGrub $stickGrub -Force
if ((Get-Sha $repoGrub) -eq (Get-Sha $stickGrub)) {
    Write-Output '  installed boot\grub\grub.cfg  verified=True'
} else {
    Write-Output '  !! grub.cfg DID NOT VERIFY. Restore grub.cfg.als-prev before booting.'
    exit 1
}

# 3. The forced-menu file.
foreach ($f in $menuFiles) {
    Remove-Item $f -Force
    Write-Output ("  deleted {0} (was forcing a 60s menu on every boot)" -f (Split-Path -Leaf $f))
}

# 4. The volume label - the first Ubuntu word the operator ever sees, in the
#    firmware's own boot-device list, before any of our software runs.
if ($Drive -match '^[A-Za-z]:$') {
    if ($label -eq $NewLabel) {
        Write-Output "  volume already labelled $NewLabel"
    } else {
        try {
            Set-Volume -DriveLetter $Drive[0] -NewFileSystemLabel $NewLabel
            Write-Output "  renamed the volume: '$label' -> '$NewLabel'"
            Write-Output '     Photograph the F12 boot menu before and after - not every firmware'
            Write-Output '     builds that line from the label, and this is the only way to know.'
        } catch {
            Write-Output "  could not rename the volume: $_"
        }
    }
}

# 5. Push it to the flash before anyone pulls the stick.
if ($Drive -match '^[A-Za-z]:$') {
    try {
        Write-VolumeCache -DriveLetter $Drive[0] -ErrorAction Stop
        Write-Output '  flushed the write cache to the device'
    } catch {
        Write-Output '  (could not flush - use Safely Remove Hardware before unplugging)'
    }
}

Write-Output ''
Write-Output 'Done. Now run:  .\tools\sync-usb.ps1 -Apply'
Write-Output 'That carries the application files and the plymouth theme tree.'
Write-Output ''
Write-Output "TO UNDO EVERYTHING: copy grub.cfg from $BackupTo back to"
Write-Output "  $Drive\boot\grub\grub.cfg  and rename the volume back in Explorer."
exit 0
