$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
. "$PSScriptRoot/defender-scan-output.ps1"

$cases = @(
    @{ Name = 'completed'; ExitCode = 0; Output = "Scan starting...`nScan finished."; Reject = $false },
    @{ Name = 'excluded file with zero exit'; ExitCode = 0; Output = "Scan finished.`nScanning D:\build\app.exe was skipped."; Reject = $true },
    @{ Name = 'cancelled scan'; ExitCode = 0; Output = "Scan finished.`nScan cancelled."; Reject = $true },
    @{ Name = 'failed command'; ExitCode = 2; Output = 'Scan finished.'; Reject = $true },
    @{ Name = 'empty output'; ExitCode = 0; Output = ''; Reject = $true },
    @{ Name = 'incomplete output'; ExitCode = 0; Output = 'Scan starting...'; Reject = $true }
)
foreach ($case in $cases) {
    $rejected = $false
    try { Assert-DefenderScanOutput -ExitCode $case.ExitCode -Output $case.Output }
    catch { $rejected = $true }
    if ($rejected -ne $case.Reject) { throw "Regression failed: $($case.Name)" }
    Write-Host "PASS: $($case.Name)"
}
