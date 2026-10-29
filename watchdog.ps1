# Own one proxy process and restart it after repeated health failures.
$ErrorActionPreference = 'Stop'
$dir = $PSScriptRoot
$port = 18082
if ($env:QCP_PORT -and (-not [int]::TryParse($env:QCP_PORT, [ref]$port) -or $port -lt 1 -or $port -gt 65535)) { throw 'Invalid QCP_PORT' }
$mutexName = if ($port -eq 18082) { 'Local\QoderBridgeWatchdogV2' } else { "Local\QoderBridgeWatchdogV2-$port" }
$mutex = New-Object System.Threading.Mutex($false, $mutexName)
$ownsMutex = $false
try { $ownsMutex = $mutex.WaitOne(0) } catch [System.Threading.AbandonedMutexException] { $ownsMutex = $true }
if (-not $ownsMutex) { $mutex.Dispose(); exit 0 }
$child = $null
$failures = 0
$backoff = @(0, 0, 15, 60, 300, 900)
function Write-Log([string]$message) {
    try { "$(Get-Date -Format o) [watchdog] $message" | Add-Content -LiteralPath (Join-Path $dir 'proxy.out.log') -Encoding UTF8 } catch {}
}
function Test-Healthy {
    try {
        $response = Invoke-RestMethod "http://127.0.0.1:$port/healthz" -TimeoutSec 5
        return ($response.ok -eq $true -and $response.protocol -eq 'qcp-5')
    } catch { return $false }
}
function Test-PortInUse {
    $client = New-Object System.Net.Sockets.TcpClient
    try { $client.Connect('127.0.0.1', $port); return $true }
    catch { return $false }
    finally { $client.Dispose() }
}
try {
    Set-Location -LiteralPath $dir
    while ($true) {
        if ($null -eq $child) {
            if (Test-Healthy) { Start-Sleep -Seconds 15; continue }
            $delay = $backoff[[Math]::Min($failures, $backoff.Count - 1)]
            if ($delay -gt 0) { Start-Sleep -Seconds $delay }
            # Recheck before starting: another instance may have come up during backoff.
            if (Test-Healthy) { continue }
            if (Test-PortInUse) {
                $failures++; Write-Log "Port $port is occupied by an unrecognized or unhealthy service; retrying"
                continue
            }
            try {
                $child = Start-Process -FilePath 'node' -ArgumentList 'qoder-cli-proxy.mjs','--port',"$port" -WorkingDirectory $dir -WindowStyle Hidden -PassThru
                Write-Log "Started proxy pid=$($child.Id)"
            } catch {
                $failures++; Write-Log 'Failed to start proxy'; continue
            }
            Start-Sleep -Seconds 10
        }
        $child.Refresh()
        if ($child.HasExited) {
            $failures++; Write-Log "Proxy exited, failure count=$failures"
            $child.Dispose(); $child = $null; continue
        }
        if (Test-Healthy) { $failures = 0 }
        else {
            $failures++
            if ($failures -ge 3) {
                Write-Log 'Proxy health failed repeatedly; restarting owned process'
                try { Stop-Process -Id $child.Id -ErrorAction Stop } catch {}
                $child.Dispose(); $child = $null
            }
        }
        Start-Sleep -Seconds 15
    }
} finally {
    $mutex.ReleaseMutex()
    $mutex.Dispose()
}
