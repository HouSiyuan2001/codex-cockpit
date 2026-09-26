[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string[]]$Path,

    [switch]$UpdateSignatures,

    [switch]$EnableRealTimeProtection
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

if ($UpdateSignatures) {
    Write-Host "Updating Microsoft Defender signatures..."
    Update-MpSignature
}

$status = Get-MpComputerStatus
if (-not $status.AntivirusEnabled) {
    throw "Microsoft Defender Antivirus is not enabled."
}
if ($EnableRealTimeProtection -and -not $status.RealTimeProtectionEnabled) {
    Write-Host "Enabling Microsoft Defender real-time protection..."
    Set-MpPreference -DisableRealtimeMonitoring $false

    $activationDeadline = (Get-Date).AddSeconds(30)
    do {
        Start-Sleep -Seconds 1
        $status = Get-MpComputerStatus
    } while (-not $status.RealTimeProtectionEnabled -and (Get-Date) -lt $activationDeadline)
}
if (-not $status.RealTimeProtectionEnabled) {
    throw "Microsoft Defender real-time protection is not enabled."
}

$mpCmdRun = Get-ChildItem -LiteralPath "$env:ProgramData\Microsoft\Windows Defender\Platform" -Directory |
    Sort-Object Name -Descending |
    ForEach-Object { Join-Path $_.FullName "MpCmdRun.exe" } |
    Where-Object { Test-Path -LiteralPath $_ } |
    Select-Object -First 1

if (-not $mpCmdRun) {
    throw "MpCmdRun.exe was not found."
}

$resolvedPaths = @(foreach ($candidate in $Path) {
    (Resolve-Path -LiteralPath $candidate).Path
})

foreach ($resolvedPath in $resolvedPaths) {
    $scanStarted = Get-Date
    Write-Host "Scanning $resolvedPath"

    & $mpCmdRun -Scan -ScanType 3 -File $resolvedPath
    $scanExitCode = $LASTEXITCODE

    if ($scanExitCode -ne 0) {
        throw "Microsoft Defender scan failed for '$resolvedPath' with exit code $scanExitCode."
    }
    if (-not (Test-Path -LiteralPath $resolvedPath)) {
        throw "Microsoft Defender removed '$resolvedPath' during the scan."
    }

    $matchingDetection = Get-MpThreatDetection |
        Where-Object {
            $_.InitialDetectionTime -ge $scanStarted.AddSeconds(-2) -and
            ($_.Resources | Where-Object { $_ -like "*$resolvedPath*" })
        } |
        Select-Object -First 1

    if ($matchingDetection) {
        throw "Microsoft Defender recorded a detection for '$resolvedPath' (Threat ID $($matchingDetection.ThreatID))."
    }

    $signature = Get-AuthenticodeSignature -LiteralPath $resolvedPath
    Write-Host "Defender accepted $resolvedPath (Authenticode: $($signature.Status))."
}

Write-Host "Microsoft Defender accepted all $(@($resolvedPaths).Count) Windows release artifacts."
