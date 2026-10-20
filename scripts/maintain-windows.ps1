param([Parameter(Mandatory=$true)][string]$ServiceDir, [ValidateSet('Window','Status','Start','Stop','Restart')][string]$Action='Window')
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'windows-service.psm1') -Force
$config = Read-KlbookDeployment $ServiceDir
$maintenancePath = $PSCommandPath
if ($Action -eq 'Status') { Get-KlbookStatus $config | ConvertTo-Json -Depth 5; exit 0 }
if ($Action -ne 'Window') { Invoke-KlbookControl $config $Action | ConvertTo-Json -Depth 5; exit 0 }
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[Windows.Forms.Application]::EnableVisualStyles()
$form = New-Object Windows.Forms.Form
$form.Text='错题集 · 电脑维护'; $form.ClientSize=New-Object Drawing.Size(720,500); $form.StartPosition='CenterScreen'; $form.MinimumSize=$form.Size
$form.Font=New-Object Drawing.Font('Microsoft YaHei UI',10)
$statusBox = New-Object Windows.Forms.TextBox
$statusBox.Multiline=$true; $statusBox.ReadOnly=$true; $statusBox.ScrollBars='Vertical'; $statusBox.SetBounds(20,20,680,350); $statusBox.Anchor='Top,Left,Right,Bottom'
$form.Controls.Add($statusBox)
function Refresh-Status {
    try {
        $status = Get-KlbookStatus $config
        $labels=@{ Running='运行中'; Stopped='已停止'; NotInstalled='未安装'; 'Start Pending'='正在启动'; 'Stop Pending'='正在停止' }
        $appLabel=$labels[$status.services[0].state]; if (!$appLabel) { $appLabel=$status.services[0].state }
        $gatewayLabel=$labels[$status.services[1].state]; if (!$gatewayLabel) { $gatewayLabel=$status.services[1].state }
        $auto=if ($status.services[0].automatic -and $status.services[1].automatic) { '已启用' } else { '未完整启用' }
        $lines = @($status.message, '', "应用：$appLabel    网关：$gatewayLabel", "开机自启：$auto", "数据目录：$($config.dataDir)", "局域网入口：$($config.origin)", '', "Node $($config.nodeVersion)", "Caddy $($config.caddyVersion.Split(' ')[0])", "WinSW $($config.winSWVersion)", '', '停止后可在此重新启动；电脑关机或休眠时无法同步。')
        $statusBox.Text = $lines -join "`r`n"
    } catch { $statusBox.Text = $_.Exception.Message }
}
$buttons = @()
foreach ($definition in @(@('刷新状态','Status'),@('启动','Start'),@('停止','Stop'),@('重新启动','Restart'),@('查看日志','Logs'))) {
    $button=New-Object Windows.Forms.Button; $button.Text=$definition[0]; $button.Tag=$definition[1]; $button.SetBounds((20 + 137 * $buttons.Count),390,125,40); $button.Anchor='Bottom,Left'
    $button.Add_Click({
        $selected=[string]$this.Tag
        if ($selected -eq 'Status') { Refresh-Status; return }
        if ($selected -eq 'Logs') { Start-Process explorer.exe -ArgumentList ('"' + (Join-Path $config.serviceDir 'logs') + '"'); return }
        if ($selected -eq 'Stop' -or $selected -eq 'Restart') {
            if ([Windows.Forms.MessageBox]::Show('请先保存正在编辑的内容。手机暂时不能同步，是否继续？','维护服务','OKCancel','Information') -ne 'OK') { return }
        }
        foreach ($item in $buttons) { $item.Enabled=$false }
        try {
            $identity=[Security.Principal.WindowsIdentity]::GetCurrent(); $principal=[Security.Principal.WindowsPrincipal]::new($identity)
            if ($principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { Invoke-KlbookControl $config $selected | Out-Null }
            else {
                $argsList=@('-NoProfile','-ExecutionPolicy','Bypass','-File',('"' + $maintenancePath + '"'),'-ServiceDir',('"' + $config.serviceDir + '"'),'-Action',$selected)
                $operation=Start-Process powershell.exe -Verb RunAs -WindowStyle Hidden -ArgumentList $argsList -PassThru -Wait
                if ($operation.ExitCode -ne 0) { throw '操作未完成，请查看状态或 logs 中的启动原因。' }
            }
        } catch { [Windows.Forms.MessageBox]::Show($_.Exception.Message,'维护未完成','OK','Warning') | Out-Null }
        finally { foreach ($item in $buttons) { $item.Enabled=$true }; Refresh-Status }
    })
    $form.Controls.Add($button); $buttons += $button
}
$timer=New-Object Windows.Forms.Timer; $timer.Interval=10000; $timer.Add_Tick({ Refresh-Status }); $timer.Start()
$form.Add_Shown({ Refresh-Status })
try { [Windows.Forms.Application]::Run($form) } finally { $timer.Stop(); $timer.Dispose(); $form.Dispose() }
