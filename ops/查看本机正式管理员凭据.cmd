@echo off
setlocal
set "WORKBENCH_CREDENTIAL_FILE=%~dp0..\.data\production\administrator.clixml"
powershell.exe -NoProfile -Command "$ErrorActionPreference='Stop'; $c=Import-Clixml -LiteralPath $env:WORKBENCH_CREDENTIAL_FILE; Write-Host ('Username: '+$c.UserName); Write-Host ('Password: '+$c.GetNetworkCredential().Password)"
pause
