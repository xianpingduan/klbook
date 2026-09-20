param([Parameter(Mandatory=$true)][string]$GatewayDir)
$ErrorActionPreference = 'Stop'
$gateway = (Resolve-Path -LiteralPath $GatewayDir).Path
$recordPath = Join-Path $gateway 'process.json'
$record = Get-Content -LiteralPath $recordPath -Raw | ConvertFrom-Json
$process = Get-Process -Id $record.pid -ErrorAction SilentlyContinue
if ($process) {
    if ($process.StartTime.ToUniversalTime().Ticks.ToString() -ne $record.startedTicks -or $process.Path -ne $record.executable) { throw 'Process identity changed; leaving it running' }
    $command = (Get-CimInstance Win32_Process -Filter "ProcessId=$($record.pid)").CommandLine
    if (-not $command.Contains((Join-Path $gateway 'Caddyfile'))) { throw 'Process belongs to another configuration; leaving it running' }
    Stop-Process -InputObject $process -Force
}
Remove-Item -LiteralPath $recordPath
'LAN gateway stopped; data and certificates retained.'
