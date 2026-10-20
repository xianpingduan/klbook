Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
function Read-KlbookDeployment([string]$ServiceDir) {
    $root = (Resolve-Path -LiteralPath $ServiceDir).Path.TrimEnd('\')
    $config = Get-Content -LiteralPath (Join-Path $root 'deployment.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($config.version -ne 1 -or $config.serviceDir.TrimEnd('\') -ne $root) { throw '维护配置与目录不符，请使用原安装目录。' }
    return $config
}
function Get-KlbookServices($Config) {
    $result = @()
    foreach ($id in @('KlbookApp','KlbookGateway')) {
        $service = Get-CimInstance Win32_Service -Filter "Name='$id'"
        if ($service) {
            $expected = '"' + (Join-Path $Config.serviceDir "$id.exe") + '"'
            if ($service.PathName.Trim() -ne $expected -and $service.PathName.Trim() -ne $expected.Trim('"')) { throw "服务 $id 属于其他安装，未执行操作。" }
        }
        $result += [pscustomobject]@{ id=$id; state=$(if ($service) { $service.State } else { 'NotInstalled' }); automatic=($service -and $service.StartMode -eq 'Auto'); account=$(if ($service) { $service.StartName } else { '' }) }
    }
    return $result
}
function Get-KlbookStatus($Config) {
    $services = @(Get-KlbookServices $Config)
    $state = $null
    try { $state = Get-Content -LiteralPath (Join-Path $Config.serviceDir 'logs\startup.json') -Raw -Encoding UTF8 | ConvertFrom-Json } catch { }
    $probe = @{ app=$false; gateway=$false; message='应用尚未就绪' }
    $probeEncoding = [Console]::OutputEncoding
    try {
        # The Node CLI emits UTF-8 JSON, including Chinese status messages.
        [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
        $raw = & (Join-Path $Config.serviceDir 'bin\node.exe') (Join-Path $Config.serviceDir 'app\dist\node\server\maintenance-cli.js') probe (Join-Path $Config.serviceDir 'deployment.json') 2>$null
        if ($LASTEXITCODE -eq 0) { $probe = $raw | ConvertFrom-Json }
    } catch { $probe.message='维护探测程序无法运行，请检查运行时文件' }
    finally { [Console]::OutputEncoding = $probeEncoding }
    $processMatches = $false
    if ($state -and $state.phase -in @('checking','ready')) {
        $process = Get-Process -Id $state.pid -ErrorAction SilentlyContinue
        if ($process) {
            try {
                $start = [DateTimeOffset]$process.StartTime.ToUniversalTime()
                $processMatches = [Math]::Abs($start.ToUnixTimeMilliseconds() - [long]$state.startedAt) -lt 10000
            } catch { }
        }
    }
    $phase = 'unavailable'; $message = [string]$probe.message
    if ($probe.app -and $probe.gateway) { $message='服务尚未全部就绪，请核对服务状态与启动记录' }
    if (@($services | Where-Object state -EQ 'NotInstalled').Count) { $phase='not-installed'; $message='尚未安装 Windows 自动服务' }
    elseif ($state -and $state.phase -eq 'failed' -and !$probe.app) { $phase='failed'; $message=$state.message }
    elseif (@($services | Where-Object state -EQ 'Stopped').Count -eq 2) { $phase='stopped'; $message='服务已停止，可在此重新启动' }
    elseif (@($services | Where-Object state -EQ 'Stop Pending').Count) { $phase='stopping'; $message='正在停止服务，请稍候' }
    elseif ($processMatches -and $state.phase -eq 'checking') { $phase='starting'; $message='正在校验本机资料，完成前暂不能连接；资料较多时请稍候' }
    elseif (@($services | Where-Object state -EQ 'Start Pending').Count) { $phase='starting'; $message='正在启动服务，请稍候' }
    elseif (@($services | Where-Object state -EQ 'Running').Count -eq 2 -and $processMatches -and $state.phase -eq 'ready' -and $probe.app -and $probe.gateway) { $phase='ready'; $message='应用与局域网 HTTPS 已就绪' }
    return [pscustomobject]@{ phase=$phase; message=$message; services=$services; checkedAt=(Get-Date).ToString('o'); appReachable=[bool]$probe.app; gatewayReachable=[bool]$probe.gateway; dataDir=$Config.dataDir; origin=$Config.origin; nodeVersion=$Config.nodeVersion; caddyVersion=$Config.caddyVersion; winSWVersion=$Config.winSWVersion }
}
function Assert-KlbookAdmin {
    $principal = [Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())
    if (!$principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw '安装和启停 Windows 服务需要管理员权限，请使用“以管理员身份运行”。' }
}
function Assert-KlbookServiceStorage($Config) {
    foreach ($root in @($Config.serviceDir, $Config.dataDir) | Select-Object -Unique) {
        $directory = Get-Item -LiteralPath $root -Force
        if (!$directory.PSIsContainer) { throw '服务与资料路径必须是现有本地目录。' }
        $encrypted = [bool]($directory.Attributes -band [IO.FileAttributes]::Encrypted)
        if (!$encrypted) {
            $encrypted = [bool](Get-ChildItem -LiteralPath $root -Recurse -Force |
                Where-Object { $_.Attributes -band [IO.FileAttributes]::Encrypted } | Select-Object -First 1)
        }
        if ($encrypted) { throw "目录或文件使用了用户专属 EFS 加密，LocalService 不能直接使用：$root。请先确认专用服务目录方案；工具不会自动解密原资料。" }
    }
}
function Invoke-KlbookControl($Config, [string]$Action) {
    Assert-KlbookAdmin
    $services = @(Get-KlbookServices $Config)
    if (@($services | Where-Object state -EQ 'NotInstalled').Count) { throw '服务尚未完整安装，请先运行安装脚本。' }
    if ($Action -eq 'Stop' -or $Action -eq 'Restart') {
        foreach ($id in @('KlbookGateway','KlbookApp')) {
            $service = Get-Service -Name $id
            if ($service.Status -ne 'Stopped') { Stop-Service -Name $id; $service.WaitForStatus('Stopped', [TimeSpan]::FromSeconds(70)) }
        }
    }
    if ($Action -eq 'Start' -or $Action -eq 'Restart') {
        if ((Get-Service -Name KlbookApp).Status -eq 'Stopped') { Remove-Item -LiteralPath (Join-Path $Config.serviceDir 'logs\startup.json') -ErrorAction SilentlyContinue }
        foreach ($id in @('KlbookApp','KlbookGateway')) { Start-Service -Name $id }
        $deadline = (Get-Date).AddSeconds(40)
        do {
            $status = Get-KlbookStatus $Config
            if ($status.phase -eq 'ready') { return $status }
            if ($status.phase -eq 'failed') { throw $status.message }
            Start-Sleep -Milliseconds 500
        } while ((Get-Date) -lt $deadline)
        # A live data check is still making progress; keep services installed and let the window refresh.
        if ($status.phase -eq 'starting') { return $status }
        throw $status.message
    }
    return Get-KlbookStatus $Config
}
Export-ModuleMember -Function Read-KlbookDeployment,Get-KlbookServices,Get-KlbookStatus,Assert-KlbookAdmin,Assert-KlbookServiceStorage,Invoke-KlbookControl
