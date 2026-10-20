param([Parameter(Mandatory=$true)][string]$ServiceDir)
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'windows-service.psm1') -Force
Assert-KlbookAdmin
$config = Read-KlbookDeployment $ServiceDir
Assert-KlbookServiceStorage $config
if (@(Get-Service -Name KlbookApp,KlbookGateway -ErrorAction SilentlyContinue).Count) { throw '服务已存在，未覆盖。请先核对原安装。' }
if (@(Get-NetTCPConnection -State Listen -LocalPort $config.backendPort,$config.port,$config.certificatePort -ErrorAction SilentlyContinue).Count) { throw '应用或网关端口仍占用，请先停止原临时进程。' }
if ((Get-FileHash -LiteralPath $config.rootCertificate).Hash -ne $config.rootSha256) { throw '根证书与准备记录不符。' }
$identityJson = & (Join-Path $config.serviceDir 'bin\node.exe') (Join-Path $config.serviceDir 'app\dist\node\server\maintenance-cli.js') check $config.dataDir
if ($LASTEXITCODE -ne 0) { throw '原资料未通过检查，未安装服务。' }
if (($identityJson | ConvertFrom-Json).libraryId -ne $config.libraryId) { throw '原资料库身份与准备记录不符，未安装服务。' }
# The service runs as LocalService; only these dedicated directories become writable to it.
$ownerSid = $config.ownerSid
if ($ownerSid -notmatch '^S-1-5-21-\d+-\d+-\d+-\d+$') { throw '准备目录的用户身份无效，请重新准备。' }
& icacls.exe $config.serviceDir /inheritance:r /grant:r ('*' + $ownerSid + ':(OI)(CI)F') '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' '*S-1-5-19:(OI)(CI)RX' | Out-Null
if ($LASTEXITCODE -ne 0) { throw '安装目录权限设置失败。' }
foreach ($path in @($config.dataDir, (Join-Path $config.serviceDir 'logs'), (Join-Path $config.serviceDir 'gateway-state'))) {
    & icacls.exe $path /grant '*S-1-5-19:(OI)(CI)M' /T /Q | Out-Null
    if ($LASTEXITCODE -ne 0) { throw '服务资料目录权限设置失败。' }
}
$installed = @()
$ruleCreated = $false
try {
    foreach ($id in @('KlbookApp','KlbookGateway')) {
        & (Join-Path $config.serviceDir "$id.exe") install
        if ($LASTEXITCODE -ne 0) { throw "安装 $id 失败，请查看 logs 目录。" }
        $installed += $id
    }
    # Limit the new program-specific rule to the existing private LAN address and subnet.
    $rule = 'Klbook-Service-HTTPS'
    if (Get-NetFirewallRule -Name $rule -ErrorAction SilentlyContinue) { throw '同名防火墙规则已存在，请人工核对。' }
    New-NetFirewallRule -Name $rule -DisplayName 'Klbook family LAN HTTPS and public certificate' -Direction Inbound -Action Allow -Protocol TCP -LocalAddress $config.address -LocalPort $config.port,$config.certificatePort -RemoteAddress LocalSubnet -Program (Join-Path $config.serviceDir 'bin\caddy.exe') -Profile Any | Out-Null
    $ruleCreated = $true
    $status = Invoke-KlbookControl $config 'Start'
    $menu = Join-Path ([Environment]::GetFolderPath('CommonPrograms')) '错题集'
    New-Item -ItemType Directory -Path $menu -Force | Out-Null
    $shortcutPath = Join-Path $menu '错题集电脑维护.lnk'
    if (!(Test-Path -LiteralPath $shortcutPath)) {
        $shortcut = (New-Object -ComObject WScript.Shell).CreateShortcut($shortcutPath)
        $shortcut.TargetPath = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
        $shortcut.Arguments = '-NoProfile -STA -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + (Join-Path $config.serviceDir 'scripts\maintain-windows.ps1') + '" -ServiceDir "' + $config.serviceDir + '"'
        $shortcut.WorkingDirectory = $config.serviceDir
        $shortcut.Description = '查看错题集运行状态、日志，停止或重新启动家庭服务'
        $shortcut.Save()
    }
    $status | ConvertTo-Json -Depth 5
} catch {
    # Roll back only the services and firewall rule created by this attempt. Keep data and logs.
    foreach ($id in @('KlbookGateway','KlbookApp')) {
        if ($installed -contains $id) {
            Stop-Service -Name $id -ErrorAction SilentlyContinue
            & (Join-Path $config.serviceDir "$id.exe") uninstall | Out-Null
        }
    }
    if ($ruleCreated) { Remove-NetFirewallRule -Name $rule }
    Write-Error $_
    exit 1
}
