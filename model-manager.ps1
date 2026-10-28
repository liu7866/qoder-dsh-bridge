$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$dir = Join-Path $env:USERPROFILE '.dsh\qoder-bridge-v2'
$file = Join-Path $dir 'model-visibility.json'
try {
    $token = [IO.File]::ReadAllText((Join-Path $dir 'token')).Trim()
    $catalog = Invoke-RestMethod -Uri 'http://127.0.0.1:18082/v1/models' -Headers @{ Authorization = "Bearer $token" } -TimeoutSec 15
    $models = @($catalog.data | Sort-Object id)
    if (-not $models.Count -or $models.Count -gt 500 -or @($models | Where-Object { $_.id -notmatch '^[a-z0-9._-]{1,128}$' }).Count) { throw 'Invalid model catalog.' }
    $hidden = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    if (Test-Path -LiteralPath $file) {
        $saved = Get-Content -LiteralPath $file -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($null -eq $saved.hidden_models -or @($saved.hidden_models | Where-Object { $_ -notmatch '^[a-z0-9._-]{1,128}$' }).Count) { throw 'Invalid saved model settings.' }
        foreach ($id in $saved.hidden_models) { [void]$hidden.Add([string]$id) }
    }
    while ($true) {
        Write-Host ''
        Write-Host 'Qoder 模型显示管理（修改后 DSH 最多约 15 秒更新）' -ForegroundColor Cyan
        for ($i = 0; $i -lt $models.Count; $i++) {
            $state = if ($hidden.Contains($models[$i].id)) { '隐藏' } else { '显示' }
            Write-Host ('{0,2}. [{1}] {2}' -f ($i + 1), $state, $models[$i].id)
        }
        $answer = (Read-Host '输入编号切换；A 全部显示；S 保存；Q 退出').Trim()
        if ($answer -eq 'Q') { exit 0 }
        if ($answer -eq 'A') { foreach ($model in $models) { [void]$hidden.Remove([string]$model.id) }; continue }
        if ($answer -eq 'S') {
            $json = ConvertTo-Json -InputObject @{ hidden_models = @($hidden | Sort-Object) } -Depth 3
            $temp = Join-Path $dir ('model-visibility-' + [guid]::NewGuid().ToString('N') + '.tmp')
            try {
                [IO.File]::WriteAllText($temp, $json, (New-Object Text.UTF8Encoding($false)))
                Move-Item -LiteralPath $temp -Destination $file -Force
            } finally { if (Test-Path -LiteralPath $temp) { Remove-Item -LiteralPath $temp -Force } }
            Write-Host '已保存。' -ForegroundColor Green
            exit 0
        }
        $number = 0
        if ([int]::TryParse($answer, [ref]$number) -and $number -ge 1 -and $number -le $models.Count) {
            $id = [string]$models[$number - 1].id
            if (-not $hidden.Remove($id)) { [void]$hidden.Add($id) }
        } else { Write-Host '无效输入，请重试。' -ForegroundColor Yellow }
    }
} catch {
    Write-Host ('无法管理模型：' + $_.Exception.Message) -ForegroundColor Red
    exit 1
}
