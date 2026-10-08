param([switch]$NoBrowser)
$ErrorActionPreference = 'Stop'
$mytabsBase = $PSScriptRoot
$mytabsUrl = 'http://127.0.0.1:47777'
$mytabsData = Join-Path $mytabsBase 'data'
$mytabsExe = Join-Path $mytabsBase 'akustik-mytabs.exe'
$mytabsInstanceFile = Join-Path $mytabsData 'sunucu.json'
New-Item -ItemType Directory -Path $mytabsData -Force | Out-Null
$env:DATA_DIR = $mytabsData
$env:MYTABS_HOST = '127.0.0.1'
$env:MYTABS_LOCAL_MODE = 'true'
$env:MYTABS_PORT = '47777'
$env:MYTABS_LAUNCH_BROWSER = 'false'

function Test-MyTabs {
    try {
        $listener = Get-NetTCPConnection -LocalPort 47777 -State Listen -ErrorAction SilentlyContinue
        if (-not $listener) { return $false }
        $owner = Get-Process -Id $listener[0].OwningProcess -ErrorAction SilentlyContinue
        if (-not $owner -or $owner.Path -ne $mytabsExe) { return $false }
        $result = Invoke-WebRequest -Uri "$mytabsUrl/api/is-finish-setup" -UseBasicParsing -TimeoutSec 2
        return $result.StatusCode -eq 200 -and $result.Content -match '^(true|false)$'
    } catch { return $false }
}

if (-not (Test-MyTabs)) {
    if (Get-NetTCPConnection -LocalPort 47777 -State Listen -ErrorAction SilentlyContinue) { throw '47777 portu baska bir uygulama tarafindan kullaniliyor.' }
    $mytabsProcess = Start-Process -FilePath $mytabsExe -WorkingDirectory $mytabsBase -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $mytabsData 'sunucu.log') -RedirectStandardError (Join-Path $mytabsData 'hata.log')
    @{ pid = $mytabsProcess.Id; startedAt = $mytabsProcess.StartTime.ToUniversalTime().ToString('o') } | ConvertTo-Json | Set-Content -LiteralPath $mytabsInstanceFile
    for ($attempt = 0; $attempt -lt 40; $attempt++) {
        if (Test-MyTabs) { break }
        Start-Sleep -Milliseconds 250
    }
    if (-not (Test-MyTabs)) {
        if (-not $mytabsProcess.HasExited) { $mytabsProcess.Kill(); $mytabsProcess.WaitForExit() }
        Remove-Item -LiteralPath $mytabsInstanceFile -ErrorAction SilentlyContinue
        throw "Uygulama baslatilamadi. data/hata.log dosyasini kontrol edin."
    }
}

if (-not $NoBrowser) { Start-Process $mytabsUrl }
