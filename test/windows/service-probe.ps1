param(
    [Parameter(Mandatory=$true)][string]$ServiceDir,
    [string]$ModulePath,
    [switch]$RequireReady
)
$ErrorActionPreference='Stop'
if(!$ModulePath){$ModulePath=Join-Path $PSScriptRoot '..\..\scripts\windows-service.psm1'}
Import-Module $ModulePath -Force
$config=Read-KlbookDeployment $ServiceDir
$priorEncoding=[Console]::OutputEncoding
try {
    # Requires the configured real HTTP and HTTPS endpoints to be healthy.
    # The services themselves may be absent; reachable endpoints must not imply installation.
    foreach($codePage in @(936,65001)) {
        [Console]::OutputEncoding=[Text.Encoding]::GetEncoding($codePage)
        $status=Get-KlbookStatus $config
        if(!$status.appReachable -or !$status.gatewayReachable){throw "Live endpoints were not detected under code page $codePage"}
        if($RequireReady -and $status.phase -ne 'ready'){throw "Installed healthy services were reported as $($status.phase)"}
        if([Console]::OutputEncoding.CodePage -ne $codePage){throw 'Probe changed the caller console encoding'}
        if(@($status.services|Where-Object state -EQ 'NotInstalled').Count -and $status.phase -eq 'ready'){throw 'Uninstalled services were reported ready'}
    }
    Write-Output 'PROBE_CP936_AND_UTF8_PASSED: live HTTP/HTTPS detected; caller encoding and service readiness rules preserved.'
} finally {
    [Console]::OutputEncoding=$priorEncoding
}
