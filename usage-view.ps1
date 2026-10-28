$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
try {
    $tokenPath = Join-Path $env:USERPROFILE '.dsh\qoder-bridge-v2\token'
    $token = [IO.File]::ReadAllText($tokenPath).Trim()
    $data = Invoke-RestMethod -Uri 'http://127.0.0.1:18082/v1/usage' -Headers @{ Authorization = "Bearer $token" } -TimeoutSec 30
    Write-Host 'Qoder 账户额度（以 Qoder 实时返回为准）' -ForegroundColor Cyan
    if (-not $data.account.available) {
        Write-Host '当前无法读取账户额度，请检查 Qoder 登录状态后稍后重试。'
    } else {
        $q = $data.account.quota
        Write-Host ("查询时间：{0}" -f ([DateTimeOffset]::Parse($data.account.observed_at).ToLocalTime().ToString('yyyy-MM-dd HH:mm:ss')))
        if ($null -ne $q.userType) { Write-Host ("账户类型：{0}" -f $q.userType) }
        foreach ($item in @(@('套餐额度', $q.userQuota), @('加购额度', $q.addOnQuota), @('组织额度', $q.orgResourcePackage))) {
            $bucket = $item[1]
            if ($null -eq $bucket) { continue }
            $parts = @()
            if ($null -ne $bucket.total) { $parts += "总额 $($bucket.total)" }
            if ($null -ne $bucket.cap) { $parts += "上限 $($bucket.cap)" }
            if ($null -ne $bucket.used) { $parts += "已用 $($bucket.used)" }
            if ($null -ne $bucket.remaining) { $parts += "剩余 $($bucket.remaining)" }
            if ($null -ne $bucket.unit) { $parts += "$($bucket.unit)" }
            Write-Host ("{0}：{1}" -f $item[0], ($parts -join ' / '))
        }
    }
    Write-Host ''
    Write-Host '最近的代理用量' -ForegroundColor Cyan
    Write-Host '单次请求和会话累计差额可能统计同一批使用量，不能相加。'
    if (-not $data.bridge.recording_ok) { Write-Warning '用量记录的读取或保存发生错误，历史可能不完整。' }
    if ($data.bridge.unidentified_events -gt 0) { Write-Warning '部分用量事件缺少可去重标识，未写入记录。' }
    if (-not $data.bridge.recent -or $data.bridge.recent.Count -eq 0) { Write-Host '尚无可显示的请求记录。' }
    else {
        $rows = foreach ($r in $data.bridge.recent) {
            $scope = if ($r.kind -eq 'session_delta') { '会话累计差额' } else { '单次请求' }
            $status = if ($r.kind -eq 'session_delta') { '--' } elseif ($r.billable -eq $true) { '计入用量' } elseif ($r.billable -eq $false) { '不计入用量' } else { '未知' }
            $credits = if ($null -eq $r.credits) { '未知' } else { '{0:0.######}' -f $r.credits }
            [PSCustomObject]@{ '时间' = ([DateTimeOffset]::Parse($r.at).ToLocalTime().ToString('MM-dd HH:mm:ss')); '范围' = $scope; '模型' = $r.model; '用途' = $r.purpose; 'Credits' = $credits; '计费状态' = $status }
        }
        $rows | Format-Table -AutoSize | Out-String -Width 240 | Write-Host
    }
    Write-Host '流式请求可能没有单次 Credits，可查看会话累计差额；账户额度包含其他 Qoder 使用。'
} catch {
    Write-Host '无法连接本地 Qoder 代理或读取令牌。请先启动 Qoder 代理，再重试。' -ForegroundColor Red
    exit 1
}
