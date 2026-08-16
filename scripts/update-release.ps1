# Release upload: replace v0.1.0 release assets with fresh build artifacts.
$ErrorActionPreference = 'Stop'
$root = 'C:\Users\Administrator\Desktop\dsh-desktop'
$releaseId = 370949446  # v0.1.0

$cred = 'protocol=https
host=github.com' | git credential fill 2>$null
$token = ($cred -split "`n" | Where-Object { $_ -like 'password=*' }) -replace '^password=', ''
if (-not $token) { throw 'no github token' }
$headers = @{ Authorization = "token $token"; 'User-Agent' = 'dsh-desktop-release' }

# 1) delete old assets
$rels = Invoke-RestMethod -Headers $headers -Uri "https://api.github.com/repos/Qiongkura/dsh-desktop/releases/$releaseId"
foreach ($a in $rels.assets) {
  Write-Host "deleting old asset: $($a.name)"
  Invoke-RestMethod -Headers $headers -Method Delete -Uri "https://api.github.com/repos/Qiongkura/dsh-desktop/releases/assets/$($a.id)" | Out-Null
}

# 2) upload new artifacts
$files = Get-ChildItem (Join-Path $root 'release') -File | Where-Object { $_.Extension -in '.exe', '.zip' }
foreach ($f in $files) {
  Write-Host "uploading: $($f.Name) ($([math]::Round($f.Length / 1MB)) MB)"
  $uploadHeaders = @{
    Authorization = "token $token"
    'User-Agent' = 'dsh-desktop-release'
    'Content-Type' = if ($f.Extension -eq '.exe') { 'application/octet-stream' } else { 'application/zip' }
  }
  $progress = $null
  Invoke-RestMethod -Headers $uploadHeaders -Method Post `
    -Uri "https://uploads.github.com/repos/Qiongkura/dsh-desktop/releases/$releaseId/assets?name=$($f.Name)" `
    -InFile $f.FullName | Out-Null
}
Write-Host 'release assets updated'
