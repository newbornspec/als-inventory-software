# Measure how fast this machine really reads a drive, with the OS cache OUT of
# the way.
#
# WHY THIS IS NOT JUST A FileStream LOOP. The first attempt at this read 512 MB
# of a layer file and reported 34 MB/s. Run again, the same code on the same
# file reported 110 MB/s - because Windows had cached it, and the second run was
# reading RAM. A number that swings threefold is worse than no number, and the
# decision resting on it is whether to buy a drive or just move it to another
# socket.
#
# So this opens the file with FILE_FLAG_NO_BUFFERING, which tells Windows to
# skip the cache entirely and read from the device every time. That flag has a
# hard requirement: the destination buffer must start on a sector boundary, and
# a .NET byte[] gives no such guarantee. Hence the P/Invoke - VirtualAlloc
# returns page-aligned memory, and ReadFile writes straight into it.
#
#   .\tools\disk-read-test.ps1 -Drive E:
#   .\tools\disk-read-test.ps1 -Drive E: -SizeMB 256

param(
    [Parameter(Mandatory = $true)][string] $Drive,
    [int] $SizeMB = 512
)

$ErrorActionPreference = 'Stop'

if (-not ([System.Management.Automation.PSTypeName]'Native.Io').Type) {
    Add-Type -Namespace Native -Name Io -MemberDefinition @'
[DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
public static extern IntPtr CreateFileW(string path, uint access, uint share,
    IntPtr sec, uint disp, uint flags, IntPtr template);

[DllImport("kernel32.dll", SetLastError = true)]
public static extern bool ReadFile(IntPtr h, IntPtr buf, uint toRead,
    out uint read, IntPtr overlapped);

[DllImport("kernel32.dll", SetLastError = true)]
public static extern bool CloseHandle(IntPtr h);

[DllImport("kernel32.dll", SetLastError = true)]
public static extern IntPtr VirtualAlloc(IntPtr addr, UIntPtr size, uint type, uint protect);

[DllImport("kernel32.dll", SetLastError = true)]
public static extern bool VirtualFree(IntPtr addr, UIntPtr size, uint type);
'@
}

$Drive = $Drive.TrimEnd('\')
if ($Drive -match '^[A-Za-z]$') { $Drive = "${Drive}:" }

$file = Get-ChildItem (Join-Path $Drive 'casper') -Filter '*.squashfs' -ErrorAction SilentlyContinue |
        Sort-Object Length -Descending | Select-Object -First 1
if (-not $file) {
    $file = Get-ChildItem $Drive -Recurse -File -ErrorAction SilentlyContinue |
            Sort-Object Length -Descending | Select-Object -First 1
}
if (-not $file) { Write-Output 'Nothing large enough to read on that drive.'; exit 1 }

$want = [int64]$SizeMB * 1MB
if ($file.Length -lt $want) { $want = $file.Length }

Write-Output "Drive : $Drive"
$disk = Get-Disk | Where-Object BusType -eq 'USB' | Select-Object -First 1
if ($disk) { Write-Output ("Device: {0}" -f $disk.FriendlyName) }
$usb = Get-PnpDevice -Class USB -PresentOnly -ErrorAction SilentlyContinue |
       Where-Object { $_.FriendlyName -match 'Mass Storage' } | Select-Object -First 1
if ($usb) {
    $loc = (Get-PnpDeviceProperty -InstanceId $usb.InstanceId -KeyName 'DEVPKEY_Device_LocationInfo' -ErrorAction SilentlyContinue).Data
    $desc = (Get-PnpDeviceProperty -InstanceId $usb.InstanceId -KeyName 'DEVPKEY_Device_BusReportedDeviceDesc' -ErrorAction SilentlyContinue).Data
    if ($desc) { Write-Output "Reports: $desc" }
    if ($loc)  { Write-Output "Socket : $loc" }
}
Write-Output ("Reading {0:N0} MB of {1}, OS cache bypassed" -f ($want / 1MB), $file.Name)

# [uint32], spelled out. In PowerShell 0x80000000 is a signed Int32 and comes
# out as -2147483648, which CreateFileW refuses to take as a uint.
$GENERIC_READ        = [uint32]2147483648
$FILE_SHARE_READ     = 0x00000001
$OPEN_EXISTING       = 3
$NO_BUFFERING        = 0x20000000
$SEQUENTIAL_SCAN     = 0x08000000
$MEM_COMMIT_RESERVE  = 0x3000
$PAGE_READWRITE      = 0x04
$MEM_RELEASE         = 0x8000

$chunk = 4MB     # a multiple of every sector size in use
$h = [Native.Io]::CreateFileW($file.FullName, $GENERIC_READ, $FILE_SHARE_READ,
        [IntPtr]::Zero, $OPEN_EXISTING, ($NO_BUFFERING -bor $SEQUENTIAL_SCAN), [IntPtr]::Zero)
if ($h -eq [IntPtr](-1)) { Write-Output "could not open the file: $([ComponentModel.Win32Exception]::new([Runtime.InteropServices.Marshal]::GetLastWin32Error()).Message)"; exit 1 }

$buf = [Native.Io]::VirtualAlloc([IntPtr]::Zero, [UIntPtr][uint64]$chunk, $MEM_COMMIT_RESERVE, $PAGE_READWRITE)
if ($buf -eq [IntPtr]::Zero) { [void][Native.Io]::CloseHandle($h); Write-Output 'could not allocate an aligned buffer'; exit 1 }

$total = 0L
$sw = [Diagnostics.Stopwatch]::StartNew()
try {
    while ($total -lt $want) {
        $read = 0
        if (-not [Native.Io]::ReadFile($h, $buf, [uint32]$chunk, [ref]$read, [IntPtr]::Zero)) { break }
        if ($read -le 0) { break }
        $total += $read
    }
} finally {
    $sw.Stop()
    [void][Native.Io]::VirtualFree($buf, [UIntPtr][uint64]0, $MEM_RELEASE)
    [void][Native.Io]::CloseHandle($h)
}

if ($total -le 0) { Write-Output 'read nothing - cannot measure'; exit 1 }
$mb = $total / 1MB
$rate = $mb / $sw.Elapsed.TotalSeconds
Write-Output ''
Write-Output ("  {0:N0} MB in {1:N1}s  =  {2:N1} MB/s" -f $mb, $sw.Elapsed.TotalSeconds, $rate)

# What it means for this stick's boot, using the layers actually present.
$chain = 0L
foreach ($n in 'minimal.squashfs', 'minimal.standard.squashfs', 'minimal.standard.live.squashfs') {
    $f = Join-Path $Drive "casper\$n"
    if (Test-Path $f) { $chain += (Get-Item $f).Length }
}
if ($chain -gt 0) {
    Write-Output ("  {0:N2} GB of boot layers end to end at this rate: {1:N0}s" -f ($chain / 1GB), (($chain / 1MB) / $rate))
    Write-Output '  (a boot reads only part of that - a ceiling, not an estimate)'
}

Write-Output ''
if ($rate -lt 45) {
    Write-Output '  VERDICT: USB 2.0 speed. Either the link negotiated slow or the drive is'
    Write-Output '           worn. Move it to a socket on the BACK of the PC and run this'
    Write-Output '           again BEFORE buying anything.'
} elseif ($rate -lt 90) {
    Write-Output '  VERDICT: between USB 2 and a healthy USB 3 drive.'
} else {
    Write-Output '  VERDICT: healthy USB 3 speed - this drive is not what makes the boot slow.'
}
