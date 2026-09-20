# Run in the PowerShell session where GitHub CLI fails.
# Uses the single cross-signed certificate already authorized by the user.
# Source: https://www.sectigo.com/uploads/resources/Sectigo-CA-Heirarchy-v4.pdf
# Certificate: https://crt.sh/?id=11405664273
[CmdletBinding()]
param(
    [switch]$CheckOnly,
    [string]$GhPath = 'E:\Program Files\GitHub CLI\gh.exe'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$expectedHash = '6802701F0FD0960FF2B51F39AAEB20A778D83261A959AD0D7FF0BE54240F673D'
$expectedThumbprint = '8A7EEC444904F9D0234F5456EE71F0F7DDE7C561'
$trustedParent = 'D1EB23A46D17D68FD92564C2F1F1601764D8E349'

# Public certificate only; no credential is embedded or requested.
$certificateBase64 = @'
MIIDyzCCArOgAwIBAgIRALmRRqcZtT13bxUtRZuVmXwwDQYJKoZIhvcNAQEMBQAwezELMAkGA1UEBhMCR0IxGzAZBgNVBAgMEkdyZWF0ZXIgTWFuY2hlc3RlcjEQMA4GA1UEBwwHU2FsZm9yZDEaMBgGA1UECgwRQ29tb2RvIENBIExpbWl0ZWQxITAfBgNVBAMMGEFBQSBDZXJ0aWZpY2F0ZSBTZXJ2aWNlczAeFw0yMTAzMjIwMDAwMDBaFw0yODEyMzEyMzU5NTlaMF8xCzAJBgNVBAYTAkdCMRgwFgYDVQQKEw9TZWN0aWdvIExpbWl0ZWQxNjA0BgNVBAMTLVNlY3RpZ28gUHVibGljIFNlcnZlciBBdXRoZW50aWNhdGlvbiBSb290IEU0NjB2MBAGByqGSM49AgEGBSuBBAAiA2IABHb6maluIO3513fjBzuo2z1fOOirVaZWT9ZI6ux/LarDssV57JlhfxB5xwJa+QQ39TQ1K3fOfyCPUqMAiezVp6JtW+NLkpOggPUBlNzwaAceze7+JVK1IEMcG/7rGc5Do6OCARIwggEOMB8GA1UdIwQYMBaAFKARCiM+lvEH7OKvKe+CpX/QMKS0MB0GA1UdDgQWBBTRItpMWfFLXyY4qp3W7usNw/upYTAOBgNVHQ8BAf8EBAMCAYYwDwYDVR0TAQH/BAUwAwEB/zAdBgNVHSUEFjAUBggrBgEFBQcDAQYIKwYBBQUHAwIwEQYDVR0gBAowCDAGBgRVHSAAMEMGA1UdHwQ8MDowOKA2oDSGMmh0dHA6Ly9jcmwuY29tb2RvY2EuY29tL0FBQUNlcnRpZmljYXRlU2VydmljZXMuY3JsMDQGCCsGAQUFBwEBBCgwJjAkBggrBgEFBQcwAYYYaHR0cDovL29jc3AuY29tb2RvY2EuY29tMA0GCSqGSIb3DQEBDAUAA4IBAQBy4yYwSxjWWj3OGzwOXa7sjOhKYeATppWTTgULid5/MN/j5pGp5BU9uKnclwlYOMC6B3JzHvcyLuHy2kCrLRL8jFG9fYKWo+3hqqv9iqLpBhiLfVfg2Bbj6Sp/OCTbn5DsmsI1iwQclW06ujlXQAxm/zdLKgLL9Bm57Xb4Vc0wNt/P+xhD6nSkOX2edtF7DK432lcJaer3z+VCBHjZ6LB7i1/lRrT9rWrqOHuZABRBTR5BNNHqKcIXRcUntb427+tYrVs1sBpVX/RH1mogIWEckMz550WAdbcfYh8erxVRf0sXMLXajsrTkwdhxEMZMn/R9lfAGBUCAAIUleto+2rv
'@

function Get-RootFingerprints {
    $roots = [System.Security.Cryptography.X509Certificates.X509Store]::new('Root', 'CurrentUser')
    try {
        $roots.Open([System.Security.Cryptography.X509Certificates.OpenFlags]::ReadOnly)
        @($roots.Certificates | ForEach-Object { $_.Thumbprint } | Sort-Object)
    } finally { $roots.Close() }
}

function Invoke-TlsProbe {
    $start = [System.Diagnostics.ProcessStartInfo]::new()
    $start.FileName = $GhPath
    $start.Arguments = 'auth login --hostname github.com --with-token'
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardInput = $true
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    foreach ($name in @('GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN', 'GH_DEBUG', 'DEBUG')) {
        $start.EnvironmentVariables.Remove($name)
    }
    $start.EnvironmentVariables['GH_NO_UPDATE_NOTIFIER'] = '1'
    $start.EnvironmentVariables['GH_PROMPT_DISABLED'] = '1'
    $process = [System.Diagnostics.Process]::new()
    $process.StartInfo = $start
    try {
        [void]$process.Start()
        $stdout = $process.StandardOutput.ReadToEndAsync()
        $stderr = $process.StandardError.ReadToEndAsync()
        $process.StandardInput.WriteLine('codex-tls-probe-not-a-credential')
        $process.StandardInput.Close()
        if (-not $process.WaitForExit(25000)) {
            $process.Kill()
            $process.WaitForExit()
            return 'TIMEOUT'
        }
        $outputText = $stdout.GetAwaiter().GetResult() + $stderr.GetAwaiter().GetResult()
        if ($outputText -match 'x509: certificate signed by unknown authority') { return 'TLS_UNKNOWN_AUTHORITY' }
        if ($outputText -match 'HTTP 401') { return 'PASS_TLS_EXPECTED_HTTP_401' }
        # Do not print unfiltered errors, environment variables, or credentials.
        return ('OTHER_FAILURE_EXIT_' + $process.ExitCode)
    } finally { $process.Dispose() }
}

$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
if (($identity.Name -split '\\')[-1] -ine 'dcy') { throw 'Run this repair as the authorized user dcy.' }
if (-not (Test-Path -LiteralPath $GhPath -PathType Leaf)) { throw 'GitHub CLI was not found at the configured path.' }
$certificate = [System.Security.Cryptography.X509Certificates.X509Certificate2]::new([Convert]::FromBase64String($certificateBase64))
$hasher = [System.Security.Cryptography.SHA256]::Create()
$store = [System.Security.Cryptography.X509Certificates.X509Store]::new('CA', 'CurrentUser')
$addedHere = $false
try {
    $actualHash = [BitConverter]::ToString($hasher.ComputeHash($certificate.RawData)).Replace('-', '')
    if ($actualHash -cne $expectedHash -or $certificate.Thumbprint -cne $expectedThumbprint) { throw 'Certificate integrity check failed.' }
    $rootBefore = @(Get-RootFingerprints)
    $store.Open([System.Security.Cryptography.X509Certificates.OpenFlags]::ReadOnly)
    $presentBefore = @($store.Certificates | Where-Object { $_.Thumbprint -eq $expectedThumbprint }).Count -gt 0
    $store.Close()
    Write-Output ('USER=' + $identity.Name)
    Write-Output ('USER_SID=' + $identity.User.Value)
    Write-Output ('POWERSHELL_VERSION=' + $PSVersionTable.PSVersion)
    Write-Output ('PROCESS_64BIT=' + [Environment]::Is64BitProcess)
    Write-Output ('GH_PATH=' + $GhPath)
    Write-Output ('CERT_PRESENT_BEFORE=' + $presentBefore)
    $probeBefore = Invoke-TlsProbe
    Write-Output ('TLS_BEFORE=' + $probeBefore)
    if ($probeBefore -eq 'PASS_TLS_EXPECTED_HTTP_401') {
        Write-Output 'RESULT=TLS_OK_NO_CHANGE_NEEDED'
        return
    }
    if ($CheckOnly) { throw 'Check-only mode: no certificate was added.' }
    if ($probeBefore -ne 'TLS_UNKNOWN_AUTHORITY') { throw 'The probe did not reproduce the certificate error. No certificate was added.' }
    if ($presentBefore) { throw 'The certificate is already present. Further diagnosis is needed; existing entries were not changed.' }
    if ($rootBefore -notcontains $trustedParent) { throw 'The existing AAA trusted root is missing. No certificate was added.' }
    $chain = [System.Security.Cryptography.X509Certificates.X509Chain]::new()
    try {
        # Local signature/path check only. The real CLI probe keeps normal TLS verification.
        $chain.ChainPolicy.RevocationMode = [System.Security.Cryptography.X509Certificates.X509RevocationMode]::NoCheck
        $chain.ChainPolicy.UrlRetrievalTimeout = [TimeSpan]::FromSeconds(5)
        if (-not $chain.Build($certificate)) { throw 'Certificate does not chain to the existing trusted store.' }
        if ($chain.ChainElements[$chain.ChainElements.Count - 1].Certificate.Thumbprint -ne $trustedParent) { throw 'Unexpected trust anchor.' }
    } finally { $chain.Dispose() }
    $store.Open([System.Security.Cryptography.X509Certificates.OpenFlags]::ReadWrite)
    $store.Add($certificate)
    $addedHere = $true
    Write-Output 'CERT_ADDED=CurrentUser\CA'
    if ((@(Get-RootFingerprints) -join ',') -cne ($rootBefore -join ',')) { throw 'The trusted-root list changed during this repair.' }
    $probeAfter = Invoke-TlsProbe
    Write-Output ('TLS_AFTER=' + $probeAfter)
    if ($probeAfter -ne 'PASS_TLS_EXPECTED_HTTP_401') { throw 'Post-repair validation failed.' }
    Write-Output 'ROOTS_UNCHANGED=True'
    Write-Output 'RESULT=REPAIRED_TLS_LOGIN_STILL_REQUIRED'
} catch {
    if ($addedHere) {
        $store.Remove($certificate)
        Write-Output 'ROLLBACK=Removed only the certificate added by this run'
    }
    throw
} finally {
    $store.Close()
    $certificate.Dispose()
    $hasher.Dispose()
}
