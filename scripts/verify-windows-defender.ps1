[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string[]]$Path,

    [switch]$UpdateSignatures,

    [switch]$EnableRealTimeProtection,

    [switch]$PrepareGitHubRunner,

    [string]$ReportPath
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest
. "$PSScriptRoot/defender-scan-output.ps1"

if ($PrepareGitHubRunner) {
    if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted') {
        throw 'Runner preparation is restricted to disposable GitHub-hosted runners.'
    }
    # Hosted images exclude both build drives and disable archive inspection.
    # Remove only those image defaults; never add exclusions or disable protection.
    $preferences = Get-MpPreference
    foreach ($drive in @('C:\', 'D:\')) {
        if ($preferences.ExclusionPath -contains $drive) {
            Remove-MpPreference -ExclusionPath $drive
        }
    }
    Set-MpPreference -DisableArchiveScanning $false
    $preferences = Get-MpPreference
    if (@($preferences.ExclusionPath | Where-Object { $_ }).Count -gt 0 -or
        @($preferences.ExclusionExtension | Where-Object { $_ }).Count -gt 0 -or
        @($preferences.ExclusionProcess | Where-Object { $_ }).Count -gt 0 -or
        $preferences.DisableArchiveScanning) {
        throw 'Runner still has Defender exclusions or archive scanning is disabled.'
    }
    Write-Host 'Hosted-runner drive exclusions removed; archive scanning enabled.'
}

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

$reports = @()
foreach ($resolvedPath in $resolvedPaths) {
    $scanStarted = Get-Date
    $hashBefore = (Get-FileHash -LiteralPath $resolvedPath -Algorithm SHA256).Hash
    Write-Host "Scanning $resolvedPath"

    $scanOutput = (& $mpCmdRun -Scan -ScanType 3 -File $resolvedPath 2>&1 | Out-String)
    $scanExitCode = $LASTEXITCODE
    Write-Host $scanOutput
    Assert-DefenderScanOutput -ExitCode $scanExitCode -Output $scanOutput
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
    if ((Get-FileHash -LiteralPath $resolvedPath -Algorithm SHA256).Hash -ne $hashBefore) {
        throw "Artifact changed during scanning: '$resolvedPath'."
    }

    $signature = Get-AuthenticodeSignature -LiteralPath $resolvedPath
    $reports += [ordered]@{
        name = [IO.Path]::GetFileName($resolvedPath)
        sha256 = $hashBefore.ToLowerInvariant()
        scannedAtUtc = (Get-Date).ToUniversalTime().ToString('o')
        result = 'completed-no-detection'
        authenticode = [string]$signature.Status
    }
    Write-Host "Defender accepted $resolvedPath (Authenticode: $($signature.Status))."
}

if ($ReportPath) {
    $status = Get-MpComputerStatus
    [ordered]@{
        schemaVersion = 1
        scanner = 'Microsoft Defender Antivirus'
        engineVersion = [string]$status.AMEngineVersion
        signatureVersion = [string]$status.AntivirusSignatureVersion
        artifacts = $reports
    } | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $ReportPath -Encoding utf8
}

Write-Host "Microsoft Defender accepted all $(@($resolvedPaths).Count) Windows release artifacts."
