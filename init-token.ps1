$ErrorActionPreference = 'Stop'
$dir = Join-Path $env:USERPROFILE '.dsh\qoder-bridge-v2'
$file = Join-Path $dir 'token'
if (Test-Path -LiteralPath $file) { Write-Host 'Existing token retained.'; exit 0 }
if (Test-Path -LiteralPath $dir) { throw 'Token directory already exists without a token. Inspect its permissions before proceeding.' }
New-Item -ItemType Directory -Path $dir | Out-Null
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
& icacls.exe $dir /inheritance:r /grant:r ("*$sid`:(OI)(CI)F") '*S-1-5-18:(OI)(CI)F' | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Could not secure token directory.' }
$bytes = New-Object byte[] 32
$rng = [Security.Cryptography.RandomNumberGenerator]::Create()
try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
$secret = ([BitConverter]::ToString($bytes) -replace '-', '').ToLowerInvariant()
[IO.File]::WriteAllText($file, $secret, (New-Object Text.UTF8Encoding($false)))
Write-Host 'Local token created in the protected profile directory.'
