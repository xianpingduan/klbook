param(
    [Parameter(Mandatory=$true)][string]$ServiceDir,
    [Parameter(Mandatory=$true)][string]$DataDir,
    [Parameter(Mandatory=$true)][string]$GatewayDir,
    [Parameter(Mandatory=$true)][string]$NodeExe,
    [Parameter(Mandatory=$true)][string]$CaddyExe,
    [Parameter(Mandatory=$true)][string]$WinSWExe
)
$ErrorActionPreference='Stop'
$workspace=(Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$priorEncoding=[Console]::OutputEncoding
try {
    # Use an isolated initialized data copy and a new destination outside the repo.
    # Retain the prepared runtime for inspection; this test never installs services.
    [Console]::OutputEncoding=[Text.Encoding]::GetEncoding(936)
    & (Join-Path $workspace 'scripts\prepare-windows-service.ps1') -ServiceDir $ServiceDir -DataDir $DataDir -GatewayDir $GatewayDir -NodeExe $NodeExe -CaddyExe $CaddyExe -WinSWExe $WinSWExe
    if ([Console]::OutputEncoding.CodePage -ne 936) { throw 'Preparation changed the caller console encoding.' }
    $manifest=Get-Content -LiteralPath (Join-Path $ServiceDir 'deployment.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($manifest.dataDir -ne [IO.Path]::GetFullPath($DataDir).TrimEnd('\')) { throw 'Prepared data path changed.' }
    foreach ($module in @('better-sqlite3','sharp','fastify')) {
        if (!(Test-Path -LiteralPath (Join-Path $ServiceDir "app\node_modules\$module\package.json"))) { throw "Missing production module: $module" }
    }
    if (!(Test-Path -LiteralPath (Join-Path $ServiceDir 'maintenance.cmd'))) { throw 'Maintenance launcher was not prepared.' }
    Write-Output 'PREPARATION_CP936_PASSED: complete runtime prepared; caller encoding preserved; no Windows service installed.'
} finally {
    [Console]::OutputEncoding=$priorEncoding
}
