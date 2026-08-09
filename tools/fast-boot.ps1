# Skip the GRUB menu on an audit USB stick, so it boots straight to the console.
#
#   .\tools\fast-boot.ps1           # report only, changes nothing
#   .\tools\fast-boot.ps1 -Apply    # skip the menu
#   .\tools\fast-boot.ps1 -Revert   # put SystemRescue's menu back
#
# WORTH READING BEFORE YOU RUN IT: the menu already boots on its own after 9
# seconds, so this saves 9 seconds a machine and a keypress - and costs you the
# "basic display drivers (nomodeset)" entry, which is the escape hatch for a
# machine that boots to a black screen. On refurbished hardware that is not a
# hypothetical. Recovering means bringing the stick back to Windows, running
# -Revert, booting, picking nomodeset, then re-applying.
#
# For the long blank screen AFTER the menu, see boot-messages.ps1. That screen
# is the machine actually booting and cannot be shortened, only made legible.
# The two scripts are independent: this one touches only the menu timeout, that
# one only the kernel command line, and each -Revert undoes just its own edit.

param(
    [string] $Drive,
    [switch] $Apply,
    [switch] $Revert
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'lib-stick.ps1')

# GRUB ignores '#' lines, so the previous values are recorded in the file
# itself. A whole-file backup would have worked too, but restoring one would
# silently undo boot-messages.ps1's edit as well.
$MARKER_RE = '(?m)^# als-fast-boot: timeout=(\S+) timeout_style=(\S+)\s*$'
$script:Failed = $false

function Patch-Grub {
    param([string] $Path, [switch] $DoApply, [switch] $DoRevert)

    $text = Get-Content $Path -Raw
    $applied = $text -match $MARKER_RE
    $prevTimeout = if ($applied) { $Matches[1] } else { $null }
    $prevStyle = if ($applied) { $Matches[2] } else { $null }

    $curTimeout = if ($text -match '(?m)^\s*set\s+timeout\s*=\s*"?(\d+)"?\s*$') { $Matches[1] } else { 'none' }

    Write-Output ("  {0}" -f $Path)
    Write-Output ("     menu timeout {0}{1}" -f $curTimeout,
                  $(if ($applied) { " (was $prevTimeout before this script)" } else { '' }))

    if ($DoApply) {
        if ($applied) { Write-Output '     already skipping the menu - nothing written'; return }

        $style = if ($text -match '(?m)^\s*set\s+timeout_style\s*=\s*(\S+)\s*$') { $Matches[1] } else { 'none' }
        $new = "# als-fast-boot: timeout=$curTimeout timeout_style=$style`n" + $text

        if ($new -match '(?m)^\s*set\s+timeout\s*=') {
            $new = [regex]::Replace($new, '(?m)^(\s*)set\s+timeout\s*=\s*"?\d+"?\s*$', '${1}set timeout=0')
        } else {
            $new = $new -replace '(?m)^(# als-fast-boot:.*)$', "`$1`nset timeout=0"
        }
        if ($new -match '(?m)^\s*set\s+timeout_style\s*=') {
            $new = [regex]::Replace($new, '(?m)^(\s*)set\s+timeout_style\s*=\s*\S+\s*$', '${1}set timeout_style=hidden')
        } else {
            $new = $new -replace '(?m)^(\s*set timeout=0\s*)$', "`$1`nset timeout_style=hidden"
        }
    }
    elseif ($DoRevert) {
        if (-not $applied) { Write-Output '     not changed by this script - left alone'; return }

        $new = $text
        if ($prevTimeout -eq 'none') {
            $new = ($new -split "`n" | Where-Object { $_ -notmatch '^\s*set\s+timeout\s*=\s*0\s*$' }) -join "`n"
        } else {
            $new = [regex]::Replace($new, '(?m)^(\s*)set\s+timeout\s*=\s*0\s*$', "`${1}set timeout=$prevTimeout")
        }
        if ($prevStyle -eq 'none') {
            $new = ($new -split "`n" | Where-Object { $_ -notmatch '^\s*set\s+timeout_style\s*=\s*hidden\s*$' }) -join "`n"
        } else {
            $new = [regex]::Replace($new, '(?m)^(\s*)set\s+timeout_style\s*=\s*hidden\s*$', "`${1}set timeout_style=$prevStyle")
        }
        $new = ($new -split "`n" | Where-Object { $_ -notmatch '^# als-fast-boot:' }) -join "`n"
    }
    else { return }

    $ok = Save-GrubConfig -Path $Path -Text $new
    Write-Output ("     written, verified={0}" -f $ok)
    if (-not $ok) { $script:Failed = $true }
}

$Drive = Resolve-StickDrive -Drive $Drive
$cfgs = @(Find-GrubConfigs -Root $Drive)

Write-Output "Stick   : $Drive"
Write-Output ("Mode    : " + $(if ($Revert) { 'REVERT - restore the menu' }
                               elseif ($Apply) { 'APPLY - skip the menu' }
                               else { 'REPORT ONLY - nothing will be written' }))
Write-Output ''

if (-not $cfgs) {
    Write-Output 'No grub.cfg found on this stick.'
    Write-Output 'If it boots with syslinux rather than GRUB, say so and I will handle that instead.'
    exit 1
}

Write-Output ("Found {0} GRUB config(s):" -f $cfgs.Count)
foreach ($c in $cfgs) { Patch-Grub -Path $c -DoApply:$Apply -DoRevert:$Revert }

Write-Output ''
if ($script:Failed) {
    Write-Output 'SOMETHING DID NOT WRITE - check the stick is not write-protected.'
    exit 1
}
if ($Apply) {
    Write-Output 'Done. Boots straight through, no menu and no keypress.'
    Write-Output 'Remember: nomodeset is now unreachable at the bench. -Revert brings it back.'
} elseif ($Revert) {
    Write-Output 'Menu restored - it will show its normal countdown again.'
} else {
    Write-Output 'Re-run with -Apply to make the change.'
}
exit 0
