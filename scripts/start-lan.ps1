param(
    [Parameter(Mandatory=$true)][string]$CaddyExe,
    [Parameter(Mandatory=$true)][string]$GatewayDir
)
$ErrorActionPreference = 'Stop'
$exe = (Resolve-Path -LiteralPath $CaddyExe).Path
$gateway = (Resolve-Path -LiteralPath $GatewayDir).Path
$settings = Get-Content -LiteralPath (Join-Path $gateway 'settings.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$recordPath = Join-Path $gateway 'process.json'
if (Test-Path -LiteralPath $recordPath) {
    $record = Get-Content -LiteralPath $recordPath -Raw -Encoding UTF8 | ConvertFrom-Json
    $running = Get-Process -Id $record.pid -ErrorAction SilentlyContinue
    if ($running -and $running.StartTime.ToUniversalTime().Ticks.ToString() -eq $record.startedTicks) { throw 'This LAN gateway is already running' }
}
& $exe validate --config $settings.config --adapter caddyfile
if ($LASTEXITCODE -ne 0) { throw 'Caddy configuration validation failed' }
$arguments = @('run', '--config', ('"{0}"' -f $settings.config), '--adapter', 'caddyfile')
$process = Start-Process -FilePath $exe -ArgumentList $arguments -WorkingDirectory $gateway -WindowStyle Hidden -RedirectStandardOutput (Join-Path $gateway 'stdout.log') -RedirectStandardError (Join-Path $gateway 'stderr.log') -PassThru
@{ pid=$process.Id; startedTicks=$process.StartTime.ToUniversalTime().Ticks.ToString(); executable=$exe } | ConvertTo-Json | Set-Content -LiteralPath $recordPath -Encoding utf8
$ready = $false
for ($attempt=0; $attempt -lt 40; $attempt++) {
    $process.Refresh()
    if ($process.HasExited) { throw "Gateway exited; inspect $gateway\stderr.log" }
    $listener = Get-NetTCPConnection -State Listen -LocalAddress $settings.address -LocalPort $settings.port -ErrorAction SilentlyContinue | Where-Object { $_.OwningProcess -eq $process.Id }
    if ($listener -and (Test-Path -LiteralPath $settings.rootCertificate)) { $ready = $true; break }
    Start-Sleep -Milliseconds 250
}
$process.Refresh()
if (-not $ready -or $process.HasExited) { throw 'Gateway did not become ready; inspect gateway log' }
# Only export the public certificate. Private keys stay in the gateway state directory.
$publicCertificate = Join-Path $gateway 'klbook-root.crt'
Copy-Item -LiteralPath $settings.rootCertificate -Destination $publicCertificate -Force
@{ origin=$settings.origin; pid=$process.Id; certificate=$publicCertificate; certificateFileSha256=(Get-FileHash -LiteralPath $publicCertificate -Algorithm SHA256).Hash } | ConvertTo-Json
