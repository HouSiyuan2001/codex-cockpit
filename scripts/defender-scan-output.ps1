function Assert-DefenderScanOutput {
    param([int]$ExitCode, [AllowEmptyString()][string]$Output)

    if ($ExitCode -ne 0) {
        throw "Microsoft Defender scan failed with exit code $ExitCode."
    }
    # MpCmdRun can exit 0 even when an exclusion skipped the entire file.
    # Release runners use English output; unknown output fails closed.
    if ($Output -match '(?i)\bskip(?:ped)?\b|\bcancel(?:led|ed)?\b') {
        throw 'Microsoft Defender skipped or cancelled the scan.'
    }
    if ($Output -notmatch '(?im)^\s*Scan finished\.\s*$') {
        throw 'Microsoft Defender did not report a completed scan.'
    }
}
