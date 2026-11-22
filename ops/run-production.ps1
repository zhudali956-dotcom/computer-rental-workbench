# 此脚本供任务计划程序在 Windows 用户登录后启动工作台。
param([Parameter(Mandatory)][string]$NodeExe)
$ErrorActionPreference = 'Stop'
$project = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $project
$log = Join-Path $project '.data/production/runtime.log'
# Windows PowerShell 5 会把重定向后的原生命令 stderr 变成非终止错误。
$ErrorActionPreference = 'Continue'
& $NodeExe '--env-file=.env' 'server/index.mjs' 2>&1 | Out-File -Append -Encoding utf8 -FilePath $log
exit $LASTEXITCODE
