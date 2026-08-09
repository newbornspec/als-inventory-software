# Shared helpers for the audit-stick scripts. Dot-sourced, not run directly:
#     . (Join-Path $PSScriptRoot 'lib-stick.ps1')
#
# These live here rather than being copied into each script because
# Find-GrubConfigs already needed one subtle fix (case-insensitive dedup), and a
# copy in each script is a copy that will eventually miss the next one.

# A stick is "an audit stick" if it carries the engine. Deliberately strict:
# these scripts write to whatever they pick, so they must never guess at a
# random drive.
function Find-AuditStick {
    Get-Volume |
        Where-Object { $_.DriveType -eq 'Removable' -and $_.DriveLetter } |
        Where-Object { Test-Path "$($_.DriveLetter):\hardware-audit.sh" } |
        ForEach-Object { "$($_.DriveLetter):" }
}

# SystemRescue has shipped grub.cfg in different places across versions, and a
# UEFI stick usually carries a second copy. Return EVERY one: patching only the
# first leaves the machine booting the unpatched path, with nothing appearing to
# have changed.
function Find-GrubConfigs {
    param([string] $Root)
    # Windows paths are case-insensitive, so EFI\BOOT and efi\boot are the SAME
    # file. Deduplicating case-sensitively patched it twice.
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

# Resolve the drive to work on, or exit with guidance. Accepts a bare letter, a
# letter with colon, or a full path (used by the tests).
function Resolve-StickDrive {
    param([string] $Drive)
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
    # Only a bare letter gets a colon appended. Matching on ':$' instead would
    # mangle a full path into "C:\...\dir:" and find nothing.
    if ($Drive -match '^[A-Za-z]$') { $Drive = "${Drive}:" }
    $Drive
}

# Write a grub.cfg back and confirm it landed. Keeps a one-time .als-orig copy
# as a last-resort escape hatch; the scripts' own -Revert is targeted, so that
# backup is only for "I need SystemRescue's file exactly as shipped".
function Save-GrubConfig {
    param([string] $Path, [string] $Text)
    $orig = "$Path.als-orig"
    if (-not (Test-Path $orig)) { Copy-Item $Path $orig -Force }
    Set-Content -Path $Path -Value $Text -Encoding ascii -NoNewline
    (Get-Content $Path -Raw) -eq $Text
}
