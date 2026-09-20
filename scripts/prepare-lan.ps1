param(
    [Parameter(Mandatory=$true)][string]$LanAddress,
    [ValidateRange(1024,65535)][int]$Port = 8443,
    [ValidateRange(1024,65535)][int]$BackendPort = 8787,
    [Parameter(Mandatory=$true)][string]$GatewayDir
)
$ErrorActionPreference = 'Stop'
$address = $null
if (-not [Net.IPAddress]::TryParse($LanAddress, [ref]$address) -or $address.AddressFamily -ne 'InterNetwork') { throw 'LanAddress must be a private IPv4 address' }
$bytes = $address.GetAddressBytes()
if (-not ($bytes[0] -eq 10 -or ($bytes[0] -eq 172 -and $bytes[1] -ge 16 -and $bytes[1] -le 31) -or ($bytes[0] -eq 192 -and $bytes[1] -eq 168))) { throw 'Only private LAN addresses are supported' }
if (-not [IO.Path]::IsPathRooted($GatewayDir)) { throw 'GatewayDir must be an absolute path' }
$gateway = [IO.Path]::GetFullPath($GatewayDir)
if ($gateway -match '["\r\n]') { throw 'Unsupported gateway directory characters' }
New-Item -ItemType Directory -Force -Path $gateway | Out-Null
$statePath = (Join-Path $gateway 'state').Replace('\','/')
$origin = 'https://{0}:{1}' -f $address, $Port
$config = @"
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
    bind $address
    tls internal
    reverse_proxy 127.0.0.1:$BackendPort
}
"@
$configPath = Join-Path $gateway 'Caddyfile'
Set-Content -LiteralPath $configPath -Value $config -Encoding utf8
$settings = @{ origin=$origin; address=$address.ToString(); port=$Port; backendPort=$BackendPort; config=$configPath; rootCertificate=(Join-Path $gateway 'state\pki\authorities\local\root.crt') }
$settings | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $gateway 'settings.json') -Encoding utf8
$settings | ConvertTo-Json
