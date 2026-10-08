$ErrorActionPreference = 'Stop'
$mytabsInstanceFile = Join-Path $PSScriptRoot 'data/sunucu.json'
if (Test-Path -LiteralPath $mytabsInstanceFile) {
    $mytabsInstance = Get-Content -LiteralPath $mytabsInstanceFile -Raw | ConvertFrom-Json
    $mytabsProcess = Get-Process -Id ([int]$mytabsInstance.pid) -ErrorAction SilentlyContinue
    if ($mytabsProcess -and $mytabsProcess.Path -eq (Join-Path $PSScriptRoot 'akustik-mytabs.exe') -and $mytabsProcess.StartTime.ToUniversalTime().Ticks -eq ([datetime]$mytabsInstance.startedAt).ToUniversalTime().Ticks) {
        $mytabsProcess.Kill()
        $mytabsProcess.WaitForExit()
    }
    Remove-Item -LiteralPath $mytabsInstanceFile
}
