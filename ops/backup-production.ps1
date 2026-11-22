# 口令由同一 Windows 用户的 DPAPI 文件提供，备份文件由工作台加密。
param([Parameter(Mandatory)][string]$NodeExe)
$ErrorActionPreference = 'Stop'
$project = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $project
$private = Join-Path $project '.data/production'
$key = (Get-Content -Raw -LiteralPath (Join-Path $private 'backup-key.dpapi')).Trim() | ConvertTo-SecureString
$env:WORKBENCH_BACKUP_PASSWORD = [System.Net.NetworkCredential]::new('', $key).Password
try {
    $destination = Join-Path $private ('backups/workbench-{0}.rentalbak' -f (Get-Date -Format 'yyyyMMdd-HHmmss'))
    & $NodeExe 'server/data-tool.mjs' 'backup' '.data/production/workbench.sqlite' $destination
    if ($LASTEXITCODE -ne 0) { throw '正式工作台备份失败' }
} finally { Remove-Item Env:WORKBENCH_BACKUP_PASSWORD -ErrorAction SilentlyContinue }
