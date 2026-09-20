#Requires -RunAsAdministrator
param([Parameter(Mandatory=$true)][string]$GatewayDir)
$ErrorActionPreference = 'Stop'
$gateway = (Resolve-Path -LiteralPath $GatewayDir).Path
$settings = Get-Content -LiteralPath (Join-Path $gateway 'settings.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$record = Get-Content -LiteralPath (Join-Path $gateway 'process.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$interface = Get-NetIPAddress -IPAddress $settings.address -AddressFamily IPv4 -ErrorAction Stop
$name = 'Klbook-LAN-HTTPS-{0}-{1}' -f $settings.address, $settings.port
if (Get-NetFirewallRule -Name $name -ErrorAction SilentlyContinue) { throw 'This rule already exists. Review it before changing it.' }
# Restricted to this program, LAN address, port, adapter and local subnet; no database port is exposed.
New-NetFirewallRule -Name $name -DisplayName "Klbook home HTTPS $($settings.port)" -Direction Inbound -Action Allow -Protocol TCP -LocalPort $settings.port -LocalAddress $settings.address -RemoteAddress LocalSubnet -InterfaceAlias $interface.InterfaceAlias -Program $record.executable -Profile Any | Select-Object Name,Enabled,Direction,Action
"To remove this rule: Remove-NetFirewallRule -Name '$name'"
