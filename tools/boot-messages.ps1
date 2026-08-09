# Show kernel boot messages on an audit USB stick, instead of a blank screen.
#
#   .\tools\boot-messages.ps1           # report only, changes nothing
#   .\tools\boot-messages.ps1 -Apply    # show boot messages
#   .\tools\boot-messages.ps1 -Revert   # back to the silent screen
#
# WHAT THIS IS FOR: after GRUB hands over, the screen sits on GRUB's leftover
# colour for 30-90s while the machine actually boots. Nothing repaints it until
# X starts, so a healthy boot looks identical to a hung one. That has already
# sent us chasing faults that were not there. Removing `quiet` from the kernel
# command line makes it print as it goes.
#
# It does NOT make the boot faster. Nothing can - that time is the machine
# booting. It only makes the wait legible.
#
# Independent of fast-boot.ps1: this touches only the kernel command line, that
# one touches only the menu timeout, and each -Revert undoes just its own edit.
# Run either, both, or neither.

param(
    [string] $Drive,
    [switch] $Apply,
    [switch] $Revert
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'lib-stick.ps1')

# GRUB ignores '#' lines, so this records our own state in the file itself
# rather than in a whole-file backup that would clobber fast-boot.ps1's edit.
$MARKER = '# als-boot-messages: on'
$script:Failed = $false

function Show-State {
    param([string] $Path, [switch] $DoApply, [switch] $DoRevert)

    $text = Get-Content $Path -Raw
    $on = $text -match [regex]::Escape($MARKER)
    $kernelLines = ([regex]::Matches($text, '(?m)^\s*linux\S*\s+.*$')).Count

    Write-Output ("  {0}" -f $Path)
    Write-Output ("     boot messages currently {0}   ({1} kernel line(s))" -f
                  $(if ($on) { 'ON' } else { 'off' }), $kernelLines)

    if ($kernelLines -eq 0) {
        Write-Output '     no kernel lines here - skipped'
        return
    }
    if (-not ($DoApply -or $DoRevert)) { return }

    if ($DoApply) {
        if ($on) { Write-Output '     already on - nothing written'; return }
        # Drop `quiet` wherever it appears on a linux line.
        $new = [regex]::Replace($text, '(?m)(^\s*linux\S*\s+.*?)\s+quiet\b', '${1}')
        $new = $MARKER + "`n" + $new
    } else {
        if (-not $on) { Write-Output '     already off - nothing written'; return }
        # Restore the kernel lines EXACTLY from the pristine copy rather than
        # re-appending `quiet`. Position matters for this pair: `quiet` sets the
        # console loglevel, so "loglevel=3 quiet" is quieter than the original
        # "quiet loglevel=3" - whichever comes last wins.
        $orig = "$Path.als-orig"
        $exact = $false
        if (Test-Path $orig) {
            $origLines = @([regex]::Matches((Get-Content $orig -Raw), '(?m)^\s*linux\S*\s+.*$') |
                           ForEach-Object { $_.Value })
            $curCount = ([regex]::Matches($text, '(?m)^\s*linux\S*\s+.*$')).Count
            if ($origLines.Count -gt 0 -and $origLines.Count -eq $curCount) {
                $script:_origLines = $origLines
                $script:_origIdx = 0
                $new = [regex]::Replace($text, '(?m)^\s*linux\S*\s+.*$', {
                    param($m)
                    $v = $script:_origLines[$script:_origIdx]
                    $script:_origIdx++
                    $v
                })
                $exact = $true
            }
        }
        if (-not $exact) {
            # No pristine copy, or the file changed shape since. Put `quiet` back
            # by appending and say so, rather than silently producing a config
            # that differs from the one SystemRescue shipped.
            $new = [regex]::Replace($text, '(?m)^(\s*linux\S*\s+.*)$', {
                param($m)
                if ($m.Groups[1].Value -match '\squiet\b') { $m.Groups[1].Value }
                else { $m.Groups[1].Value.TrimEnd() + ' quiet' }
            })
            Write-Output '     no pristine copy - quiet re-appended, position may differ'
        }
        $new = ($new -split "`n" | Where-Object { $_.Trim() -ne $MARKER }) -join "`n"
    }

    $ok = Save-GrubConfig -Path $Path -Text $new
    Write-Output ("     written, verified={0}" -f $ok)
    if (-not $ok) { $script:Failed = $true }
}

$Drive = Resolve-StickDrive -Drive $Drive
$cfgs = @(Find-GrubConfigs -Root $Drive)

Write-Output "Stick   : $Drive"
Write-Output ("Mode    : " + $(if ($Revert) { 'REVERT - back to a silent boot' }
                               elseif ($Apply) { 'APPLY - show boot messages' }
                               else { 'REPORT ONLY - nothing will be written' }))
Write-Output ''

if (-not $cfgs) {
    Write-Output 'No grub.cfg found on this stick.'
    Write-Output 'If it boots with syslinux rather than GRUB, say so and I will handle that instead.'
    exit 1
}

Write-Output ("Found {0} GRUB config(s):" -f $cfgs.Count)
foreach ($c in $cfgs) { Show-State -Path $c -DoApply:$Apply -DoRevert:$Revert }

Write-Output ''
if ($script:Failed) {
    Write-Output 'SOMETHING DID NOT WRITE - check the stick is not write-protected.'
    exit 1
}
if ($Apply) {
    Write-Output 'Done. The screen after GRUB will now print as the machine boots,'
    Write-Output 'so a slow boot no longer looks like a frozen one. Same duration.'
} elseif ($Revert) {
    Write-Output 'Done. Back to the quiet screen.'
} else {
    Write-Output 'Re-run with -Apply to turn boot messages on.'
}
exit 0
