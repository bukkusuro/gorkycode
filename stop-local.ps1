$ErrorActionPreference = 'Stop'
$pidPath = Join-Path $PSScriptRoot '.tools\local-server.pid'
$vitePath = Join-Path $PSScriptRoot 'node_modules\vite\bin\vite.js'
if (-not (Test-Path -LiteralPath $pidPath)) { return }
$serverId = [int](Get-Content -LiteralPath $pidPath -Raw).Trim()
$server = Get-CimInstance Win32_Process -Filter "ProcessId = $serverId" -ErrorAction SilentlyContinue
if ($server -and $server.CommandLine -and $server.CommandLine.Contains($vitePath)) {
    Stop-Process -Id $serverId -ErrorAction Stop
    Write-Host 'VoiceTask stopped.'
}
Remove-Item -LiteralPath $pidPath
