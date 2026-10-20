param(
    [Parameter(Mandatory=$true)][string]$ServiceDir,
    [Parameter(Mandatory=$true)][string]$DataDir,
    [Parameter(Mandatory=$true)][string]$GatewayDir,
    [Parameter(Mandatory=$true)][string]$NodeExe,
    [Parameter(Mandatory=$true)][string]$CaddyExe,
    [Parameter(Mandatory=$true)][string]$WinSWExe,
    [ValidateRange(1024,65535)][int]$CertificatePort=8080
)
$ErrorActionPreference = 'Stop'
$workspace = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
function AbsolutePath([string]$path) {
    if (![IO.Path]::IsPathRooted($path) -or $path -match '^[\\]{2}|["%\r\n]') { throw 'Use an absolute local path without quotes, percent signs or line breaks.' }
    return [IO.Path]::GetFullPath($path).TrimEnd('\')
}
$destination = AbsolutePath $ServiceDir
$data = AbsolutePath $DataDir
$gateway = AbsolutePath $GatewayDir
foreach ($protected in @($workspace, $data, $gateway)) {
    if ($destination -eq $protected -or $protected.StartsWith($destination + '\', [StringComparison]::OrdinalIgnoreCase) -or $destination.StartsWith($protected + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'ServiceDir must be separate from source, data and existing gateway directories.' }
}
if (Test-Path -LiteralPath $destination) { throw 'ServiceDir already exists. No files overwritten.' }
$node = (Resolve-Path -LiteralPath $NodeExe).Path
$caddy = (Resolve-Path -LiteralPath $CaddyExe).Path
$wrapper = (Resolve-Path -LiteralPath $WinSWExe).Path
if ((Get-FileHash -LiteralPath $wrapper).Hash -ne 'B5066B7BBDFBA1293E5D15CDA3CAAEA88FBEAB35BD5B38C41C913D492AADFC4F') { throw 'Use the documented WinSW 2.12.0 NET461 binary.' }
$nodeVersion = (& $node --version).Trim()
if ($nodeVersion -notmatch '^v24\.' -or [version]$nodeVersion.TrimStart('v') -lt [version]'24.19.0') { throw 'Validated Node 24.19.0 or newer 24.x required.' }
$caddyVersion = (& $caddy version).Trim()
$identityJson = & $node (Join-Path $workspace 'dist/node/server/maintenance-cli.js') check $data
if ($LASTEXITCODE -ne 0) { throw 'Existing family data validation failed; no deployment created.' }
$identity = $identityJson | ConvertFrom-Json
$settings = Get-Content -LiteralPath (Join-Path $gateway 'settings.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$address = $null
if (![Net.IPAddress]::TryParse($settings.address, [ref]$address)) { throw 'Invalid gateway address.' }
$bytes = $address.GetAddressBytes()
if ($bytes.Length -ne 4 -or !($bytes[0] -eq 10 -or ($bytes[0] -eq 172 -and $bytes[1] -ge 16 -and $bytes[1] -le 31) -or ($bytes[0] -eq 192 -and $bytes[1] -eq 168))) { throw 'Only a private IPv4 LAN address is supported.' }
foreach ($port in @($settings.backendPort, $settings.port)) { if ($port -lt 1024 -or $port -gt 65535) { throw 'Invalid port.' } }
if ($settings.backendPort -eq $settings.port) { throw 'Backend and gateway ports must differ.' }
if ($CertificatePort -in @($settings.backendPort, $settings.port)) { throw 'Certificate download port must differ from application ports.' }
$rootCertificate = Join-Path $gateway 'state\pki\authorities\local\root.crt'
$rootHash = (Get-FileHash -LiteralPath $rootCertificate).Hash
$npm = Join-Path (Split-Path $node) 'npm.cmd'
$dependencyEncoding = [Console]::OutputEncoding
Push-Location $workspace
try {
    # npm emits UTF-8 even when Windows PowerShell uses a Chinese console code page.
    [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
    $dependencies = @(& $npm ls --omit=dev --all --parseable)
    if ($LASTEXITCODE -ne 0) { throw 'Production dependencies are incomplete.' }
}
finally {
    [Console]::OutputEncoding = $dependencyEncoding
    Pop-Location
}
$moduleRoot = Join-Path $workspace 'node_modules'
$topModules = @($dependencies | Where-Object { $_ -ne $workspace } | ForEach-Object {
    $full = [IO.Path]::GetFullPath($_)
    if (!$full.StartsWith($moduleRoot + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'External linked dependency is not supported.' }
    $relative = $full.Substring($moduleRoot.Length + 1).Split('\')
    if ($relative[0].StartsWith('@')) { Join-Path $relative[0] $relative[1] } else { $relative[0] }
} | Sort-Object -Unique)
New-Item -ItemType Directory -Path $destination | Out-Null
foreach ($name in @('app','app\node_modules','bin','logs','scripts','public')) { New-Item -ItemType Directory -Path (Join-Path $destination $name) | Out-Null }
Copy-Item -LiteralPath (Join-Path $workspace 'dist') -Destination (Join-Path $destination 'app\dist') -Recurse
foreach ($name in @('package.json','package-lock.json')) { Copy-Item -LiteralPath (Join-Path $workspace $name) -Destination (Join-Path $destination "app\$name") }
foreach ($module in $topModules) {
    $target = Join-Path $destination "app\node_modules\$module"
    New-Item -ItemType Directory -Path (Split-Path $target) -Force | Out-Null
    Copy-Item -LiteralPath (Join-Path $moduleRoot $module) -Destination $target -Recurse
}
Copy-Item -LiteralPath $node -Destination (Join-Path $destination 'bin\node.exe')
Copy-Item -LiteralPath $caddy -Destination (Join-Path $destination 'bin\caddy.exe')
Copy-Item -LiteralPath $wrapper -Destination (Join-Path $destination 'KlbookApp.exe')
Copy-Item -LiteralPath $wrapper -Destination (Join-Path $destination 'KlbookGateway.exe')
Copy-Item -LiteralPath (Join-Path $gateway 'state') -Destination (Join-Path $destination 'gateway-state') -Recurse
Copy-Item -LiteralPath $rootCertificate -Destination (Join-Path $destination 'public\klbook-root.crt')
foreach ($name in @('maintain-windows.ps1','install-windows-service.ps1','windows-service.psm1')) { Copy-Item -LiteralPath (Join-Path $PSScriptRoot $name) -Destination (Join-Path $destination 'scripts') }
$origin = 'https://{0}:{1}' -f $settings.address, $settings.port
$manifest = [ordered]@{ version=1; serviceDir=$destination; dataDir=$data; libraryId=$identity.libraryId; ownerSid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value; backendPort=[int]$settings.backendPort; address=$settings.address; port=[int]$settings.port; certificatePort=$CertificatePort; origin=$origin;
    rootCertificate=(Join-Path $destination 'public\klbook-root.crt'); rootSha256=$rootHash; nodeVersion=$nodeVersion; caddyVersion=$caddyVersion; winSWVersion='2.12.0'; sourceCommit=(& git -C $workspace rev-parse HEAD).Trim(); sourceModified=[bool](& git -C $workspace status --porcelain); preparedAt=(Get-Date).ToString('o') }
$utf8 = [Text.UTF8Encoding]::new($false)
[IO.File]::WriteAllText((Join-Path $destination 'deployment.json'), ($manifest | ConvertTo-Json), $utf8)
$statePath = (Join-Path $destination 'gateway-state').Replace('\','/')
$caddyConfig = @"
{
    admin off
    persist_config off
    skip_install_trust
    auto_https disable_redirects
    storage file_system {
        root "$statePath"
    }
}
$origin {
    bind $($settings.address)
    tls internal
    reverse_proxy 127.0.0.1:$($settings.backendPort)
}
http://$($settings.address):$CertificatePort {
    bind $($settings.address)
    @publicFiles path / /index.html /klbook-root.crt
    handle @publicFiles {
        root * "$((Join-Path $destination 'public').Replace('\','/'))"
        header Cache-Control "no-store"
        header /klbook-root.crt Content-Type "application/x-x509-ca-cert"
        header /klbook-root.crt Content-Disposition "attachment; filename=klbook-root.crt"
        file_server
    }
    handle {
        respond "Not found" 404
    }
}
"@
[IO.File]::WriteAllText((Join-Path $destination 'Caddyfile'), $caddyConfig, $utf8)
$certificatePage = @"
<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>错题集 · 家庭连接</title><style>body{font:18px/1.7 system-ui;margin:24px auto;padding:0 20px;max-width:660px}a{display:block;margin:24px 0}code{word-break:break-all}</style>
<h1>连接家庭错题集</h1><p>手机与电脑连接同一家庭 Wi-Fi。已信任这台电脑证书的设备可直接进入学习端。</p>
<a href="$origin/learn">打开学习端</a><a href="/klbook-root.crt" download>下载家庭电脑证书</a>
<p>新设备请先与电脑上保存的公开根证书核对，再按系统设置安装并信任。这里仅提供公开证书，账号登录与题目都使用 HTTPS。</p>
<p>证书文件 SHA-256（应与电脑维护目录中的证书一致）：<code>$rootHash</code></p></html>
"@
[IO.File]::WriteAllText((Join-Path $destination 'public\index.html'), $certificatePage, $utf8)
function XmlText([string]$text) { [Security.SecurityElement]::Escape($text) }
foreach ($id in @('KlbookApp','KlbookGateway')) {
    $app = $id -eq 'KlbookApp'
    $executable = if ($app) { Join-Path $destination 'bin\node.exe' } else { Join-Path $destination 'bin\caddy.exe' }
    $arguments = if ($app) { '"' + (Join-Path $destination 'app\dist\node\server\main.js') + '"' } else { 'run --config "' + (Join-Path $destination 'Caddyfile') + '" --adapter caddyfile' }
    $dependency = if ($app) { '' } else { '<depend>KlbookApp</depend>' }
    $environment = if ($app) { @"
  <env name="KLBOOK_DATA_DIR" value="$(XmlText $data)"/>
  <env name="KLBOOK_PORT" value="$($settings.backendPort)"/>
  <env name="KLBOOK_ALLOWED_ORIGINS" value="$origin"/>
  <env name="KLBOOK_REQUIRE_EXISTING" value="1"/>
  <env name="KLBOOK_EXPECTED_LIBRARY_ID" value="$($identity.libraryId)"/>
  <env name="KLBOOK_STARTUP_STATE" value="$(XmlText (Join-Path $destination 'logs\startup.json'))"/>
"@ } else { '' }
    $xml = @"
<service>
  <id>$id</id><name>$id</name><description>Klbook family collection service</description>
  <executable>$(XmlText $executable)</executable><arguments>$(XmlText $arguments)</arguments>
  <workingdirectory>$(XmlText $destination)</workingdirectory>
  <serviceaccount><domain>NT AUTHORITY</domain><user>LocalService</user></serviceaccount>
  <startmode>Automatic</startmode><delayedAutoStart>true</delayedAutoStart>
  $dependency
  <onfailure action="restart" delay="30 sec"/><onfailure action="restart" delay="60 sec"/><onfailure action="restart" delay="120 sec"/>
  <resetfailure>1 hour</resetfailure><stoptimeout>60 sec</stoptimeout>
  <logpath>$(XmlText (Join-Path $destination 'logs'))</logpath>
  <log mode="roll-by-size"><sizeThreshold>1024</sizeThreshold><keepFiles>5</keepFiles></log>
  $environment
</service>
"@
    [IO.File]::WriteAllText((Join-Path $destination "$id.xml"), $xml, $utf8)
}
& (Join-Path $destination 'bin\node.exe') (Join-Path $destination 'app\dist\node\server\maintenance-cli.js') check $data | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Prepared runtime failed. No system services were installed.' }
& (Join-Path $destination 'bin\caddy.exe') validate --config (Join-Path $destination 'Caddyfile') --adapter caddyfile
if ($LASTEXITCODE -ne 0) { throw 'Prepared gateway failed validation. No services installed.' }
$maintenanceCmd = '@powershell.exe -NoProfile -STA -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0scripts\maintain-windows.ps1" -ServiceDir "%~dp0."'
[IO.File]::WriteAllText((Join-Path $destination 'maintenance.cmd'), $maintenanceCmd, [Text.Encoding]::ASCII)
Import-Module (Join-Path $PSScriptRoot 'windows-service.psm1') -Force
Assert-KlbookServiceStorage $manifest
Write-Output "PREPARED=$destination"
