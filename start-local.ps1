param([switch]$NoBrowser)
$ErrorActionPreference = 'Stop'
$projectRoot = $PSScriptRoot
$nodePath = Join-Path $projectRoot '.tools\node.exe'
$vitePath = Join-Path $projectRoot 'node_modules\vite\bin\vite.js'
$url = 'http://localhost:5173/VoiceTask/'
$pidPath = Join-Path $projectRoot '.tools\local-server.pid'

if (-not (Test-Path -LiteralPath $nodePath) -or -not (Test-Path -LiteralPath $vitePath)) {
    throw 'Local Node.js or Vite is missing. Keep .tools and node_modules in the project folder.'
}
& $nodePath (Join-Path $projectRoot 'scripts\setup-speech.mjs')
if ($LASTEXITCODE -ne 0) { throw 'Speech setup failed. Check the network and start again.' }

$listener = Get-NetTCPConnection -LocalPort 5173 -State Listen -ErrorAction SilentlyContinue
if ($listener) {
    $server = Get-CimInstance Win32_Process -Filter "ProcessId = $($listener[0].OwningProcess)"
    if (-not $server.CommandLine -or -not $server.CommandLine.Contains($vitePath)) {
        throw 'Port 5173 is already used by another program. Close it and start again.'
    }
    $serverId = $server.ProcessId
} else {
    $options = @{
        FilePath = $nodePath
        ArgumentList = @(('"' + $vitePath + '"'), '--host', '127.0.0.1', '--port', '5173', '--strictPort')
        WorkingDirectory = $projectRoot
        WindowStyle = 'Hidden'
        RedirectStandardOutput = Join-Path $projectRoot '.tools\local-server.log'
        RedirectStandardError = Join-Path $projectRoot '.tools\local-server-error.log'
        PassThru = $true
    }
    $serverId = (Start-Process @options).Id
}
Set-Content -LiteralPath $pidPath -Value $serverId -Encoding ascii

$ready = $false
for ($attempt = 0; $attempt -lt 40; $attempt++) {
    try {
        $response = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 2
        if ($response.StatusCode -eq 200 -and $response.Content.Contains('/@vite/client')) {
            $ready = $true
            break
        }
    } catch {}
    Start-Sleep -Milliseconds 250
}
if (-not $ready) { throw 'Server did not start. See .tools\local-server-error.log.' }
Write-Host "VoiceTask: $url"
if (-not $NoBrowser) { Start-Process $url }
