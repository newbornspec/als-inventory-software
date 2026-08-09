# Skip the GRUB menu on an audit USB stick, so it boots straight to the console.
#
#   .\tools\fast-boot.ps1                   # report only, changes nothing
#   .\tools\fast-boot.ps1 -Apply            # skip the menu
#   .\tools\fast-boot.ps1 -Apply -ShowBootMessages
#   .\tools\fast-boot.ps1 -Revert           # put SystemRescue's menu back
#
# The original grub.cfg is copied to grub.cfg.als-orig before the first change,
# so -Revert always has something to restore even if this script is updated.
#
# TRADE-OFF worth knowing: with the menu gone there is no way to pick
# "basic display drivers (nomodeset)" on a machine whose screen stays black.
# If you hit one, run -Revert from Windows, boot it, pick nomodeset, then
# -Apply again. That is the only thing the menu was buying you.

param(
    [string] $Drive,
    [switch] $Apply,
    [switch] $Revert,
    [switch] $ShowBootMessages
)

$ErrorActionPreference = 'Stop'
$script:Failed = $false

function Find-AuditStick {
    Get-Volume |
        Where-Object { $_.DriveType -eq 'Removable' -and $_.DriveLetter } |
        Where-Object { Test-Path "$($_.DriveLetter):\hardware-audit.sh" } |
        ForEach-Object { "$($_.DriveLetter):" }
}

# SystemRescue has shipped grub.cfg in different places across versions, and a
# UEFI stick often carries a second copy. Patch every one found, or the machine
# boots the unpatched path and nothing appears to have changed.
function Find-GrubConfigs {
    param([string] $Root)
    # Windows paths are case-insensitive, so EFI\BOOT and efi\boot are the SAME
    # file. Deduplicating case-sensitively patched it twice and reported a config
    # count that did not exist.
    $seen = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
    $hits = @()
    foreach ($rel in @('boot\grub\grub.cfg', 'EFI\BOOT\grub.cfg',
                       'boot\grub\i386-pc\grub.cfg', 'sysresccd\boot\grub\grub.cfg')) {
        $p = Join-Path $Root $rel
        if (Test-Path $p) {
            $full = (Resolve-Path $p).Path
            if ($seen.Add($full)) { $hits += $full }
        }
    }
    # Catch layouts not in the list above rather than silently doing nothing.
    Get-ChildItem -Path $Root -Filter 'grub.cfg' -Recurse -File -ErrorAction SilentlyContinue |
        ForEach-Object { if ($seen.Add($_.FullName)) { $hits += $_.FullName } }
    $hits
}

function Patch-Grub {
    param([string] $Path, [switch] $DoApply, [switch] $Verbose_)

    $orig = "$Path.als-orig"
    $text = Get-Content $Path -Raw
    $before = $text

    # Read the current timeout for the report.
    $cur = if ($text -match '(?m)^\s*set\s+timeout\s*=\s*"?(\d+)"?') { $Matches[1] } else { '(not set)' }

    # GRUB honours the LAST assignment, but rewriting in place keeps the file
    # readable and makes -Revert a straight file copy.
    if ($text -match '(?m)^\s*set\s+timeout\s*=') {
        $text = [regex]::Replace($text, '(?m)^(\s*)set\s+timeout\s*=\s*"?\d+"?\s*$', '${1}set timeout=0')
    } else {
        $text = "set timeout=0`n" + $text
    }

    # hidden = do not draw the menu at all during the (now zero) timeout.
    if ($text -match '(?m)^\s*set\s+timeout_style\s*=') {
        $text = [regex]::Replace($text, '(?m)^(\s*)set\s+timeout_style\s*=\s*\S+\s*$', '${1}set timeout_style=hidden')
    } else {
        $text = $text -replace '(?m)^(\s*set timeout=0\s*)$', "`$1`nset timeout_style=hidden"
    }

    if ($ShowBootMessages) {
        # Drop `quiet` so the kernel prints as it boots. The wait is unchanged;
        # it just stops looking like a frozen screen.
        $text = [regex]::Replace($text, '(?m)(^\s*linux\S*\s+.*?)\s+quiet\b', '${1}')
    }

    $changed = $text -ne $before
    Write-Output ("  {0}" -f $Path)
    Write-Output ("     timeout was {0} -> 0{1}" -f $cur, $(if ($ShowBootMessages) { ', boot messages on' } else { '' }))

    if (-not $DoApply) { return }
    if (-not $changed) { Write-Output '     already set - nothing written'; return }

    if (-not (Test-Path $orig)) { Copy-Item $Path $orig -Force }
    Set-Content -Path $Path -Value $text -Encoding ascii -NoNewline
    $ok = (Get-Content $Path -Raw) -match '(?m)^\s*set\s+timeout=0\s*$'
    Write-Output ("     written, verified={0}  (backup: {1})" -f $ok, (Split-Path $orig -Leaf))
    if (-not $ok) { $script:Failed = $true }
}

function Revert-Grub {
    param([string] $Path)
    $orig = "$Path.als-orig"
    if (-not (Test-Path $orig)) {
        Write-Output ("  {0}`n     no backup - never changed by this script, left alone" -f $Path)
        return
    }
    Copy-Item $orig $Path -Force
    Write-Output ("  {0}`n     restored from {1}" -f $Path, (Split-Path $orig -Leaf))
}

# --- pick the stick ---------------------------------------------------------
if (-not $Drive) {
    $c = @(Find-AuditStick)
    if (-not $c) {
        Write-Output 'No audit stick found. Plug one in, or pass -Drive E:'
        exit 1
    }
    if ($c.Count -gt 1) {
        Write-Output 'More than one audit stick is plugged in. Pick one with -Drive:'
        $c | ForEach-Object { Write-Output ("  -Drive {0}" -f $_) }
        exit 1
    }
    $Drive = $c[0]
}
$Drive = $Drive.TrimEnd('\')
if ($Drive -match '^[A-Za-z]$') { $Drive = "${Drive}:" }

$cfgs = @(Find-GrubConfigs -Root $Drive)
Write-Output "Stick   : $Drive"
Write-Output ("Mode    : " + $(if ($Revert) { 'REVERT' } elseif ($Apply) { 'APPLY' } else { 'REPORT ONLY - nothing will be written' }))
Write-Output ''

if (-not $cfgs) {
    Write-Output 'No grub.cfg found on this stick.'
    Write-Output 'If it boots with syslinux rather than GRUB, tell me and I will handle that instead.'
    exit 1
}

Write-Output ("Found {0} GRUB config(s):" -f $cfgs.Count)
foreach ($c in $cfgs) {
    if ($Revert) { Revert-Grub -Path $c } else { Patch-Grub -Path $c -DoApply:$Apply }
}

Write-Output ''
if ($Revert) {
    Write-Output 'Menu restored. It will show for its normal countdown again.'
} elseif ($Apply) {
    if ($script:Failed) { Write-Output 'SOMETHING DID NOT WRITE - check the stick is not write-protected.'; exit 1 }
    Write-Output 'Done. The stick now boots straight through with no menu and no keypress.'
    Write-Output 'The wait after it is the machine actually booting - that part cannot be skipped.'
} else {
    Write-Output 'Re-run with -Apply to make the change.'
}
exit 0
