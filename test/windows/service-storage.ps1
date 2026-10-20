param([string]$ModulePath=(Join-Path $PSScriptRoot '..\..\scripts\windows-service.psm1'))
$ErrorActionPreference='Stop'
Import-Module $ModulePath -Force
$tempRoot=[IO.Path]::GetFullPath([IO.Path]::GetTempPath())
$fixture=Join-Path $tempRoot ('klbook-storage-test-'+[guid]::NewGuid().ToString())
New-Item -ItemType Directory -Path $fixture | Out-Null
try {
    # Only disposable synthetic fixtures are decrypted/encrypted here.
    & cipher.exe /d /a $fixture | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Cannot prepare unencrypted EFS test fixture.' }
    $runtime=New-Item -ItemType Directory -Path (Join-Path $fixture 'service')
    $data=New-Item -ItemType Directory -Path (Join-Path $fixture 'data')
    $config=[pscustomobject]@{serviceDir=$runtime.FullName;dataDir=$data.FullName}
    Assert-KlbookServiceStorage $config
    $encryptedFile=Join-Path $data.FullName 'synthetic-test.txt'
    [IO.File]::WriteAllText($encryptedFile,'Synthetic test data; no family material.')
    & cipher.exe /e /a $encryptedFile | Out-Null
    if ($LASTEXITCODE -ne 0 -or !((Get-Item -LiteralPath $encryptedFile).Attributes -band [IO.FileAttributes]::Encrypted)) { throw 'EFS fixture encryption failed.' }
    $rejected=$false
    try { Assert-KlbookServiceStorage $config } catch { if ($_.Exception.Message -match 'EFS') { $rejected=$true } else { throw } }
    if (!$rejected) { throw 'Encrypted child was accepted for a LocalService runtime.' }
    & cipher.exe /d /a $encryptedFile | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Synthetic file decryption failed.' }
    Assert-KlbookServiceStorage $config
    & cipher.exe /e /a $runtime.FullName | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Directory encryption failed.' }
    $rejected=$false
    try { Assert-KlbookServiceStorage $config } catch { if ($_.Exception.Message -match 'EFS') { $rejected=$true } else { throw } }
    if (!$rejected) { throw 'Encrypted runtime directory was accepted.' }
    Write-Output 'PASS: plain storage accepted; encrypted child and runtime directory rejected'
} finally {
    $resolved=[IO.Path]::GetFullPath($fixture)
    if (!$resolved.StartsWith($tempRoot.TrimEnd('\')+'\',[StringComparison]::OrdinalIgnoreCase) -or [IO.Path]::GetFileName($resolved) -notlike 'klbook-storage-test-*') { throw 'Refuse cleanup outside the test fixture.' }
    Remove-Item -LiteralPath $resolved -Recurse -Force
}
