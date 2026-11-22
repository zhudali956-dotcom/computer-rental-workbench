# 部署与维护

## 飞书与工作台配置

分别为联调和正式环境建表，授予对应的自建应用读写权限。工作台使用以下文本字段：`业务ID`、`类型`、`版本`、`企业名称`、`联系电话`、`归属`、`状态`、`下次回访`、`快照`。建议以 `业务ID` 为主字段。员工在工作台操作，飞书中同步字段用于查看和对账。

- 联调：复制 `.env.feishu-test.example` 为 `.env.feishu-test`，填应用和测试表信息，启动 `npm run feishu:test`。默认监听 `127.0.0.1:4189`，模拟 AI 与本地填写助手可分别配置。
- 正式：复制 `.env.example` 为 `.env`，填正式飞书表、HTTPS 证书、数据库与初始管理员信息，启动 `npm start`。正式库会记住首次绑定的飞书表。
- 初次初始化后，从配置移除 `WORKBENCH_ADMIN_PASSWORD`。Windows 可通过凭据管理器提供飞书应用密钥，`FEISHU_CREDENTIAL_SERVICE` 与 `FEISHU_KEYTAR_MODULE` 由机主配置。

## 办公室 Windows 主机

1. 为服务器选择固定或保留的内网 IPv4。生产模式只绑定指定的环回地址或私网地址。防火墙仅允许预期办公网段访问 HTTPS 端口。
2. 用受信任的现有证书，或用 `ops/create-office-certificate.py` 签发本机服务证书。先安装 `requirements-ops.txt`。脚本参数依次是私网地址、私有输出目录、公钥证书文件路径。证书与私钥参数分别用 `WORKBENCH_CERT` 和 `WORKBENCH_KEY` 配置。
3. 如使用本机签发证书，员工电脑应核对提供的公钥证书指纹并按组织规则建立信任。私钥只放在受限的服务器目录。
4. `ops/run-production.ps1 -NodeExe <Node可执行文件路径>` 可作为 Windows 登录自启任务。任务使用能够读取飞书凭据和数据库的 Windows 用户，工作目录为项目根目录。任务为用户登录后自启，日志位于 `.data/production/runtime.log`。

## AI 与小红书联调

正式 API 按可用模型配置 `OPENAI_API_KEY`、文案/图像模型、每日总额、单员工额度和每次预留金额（美分）。预留额是工作台限额，服务商实际计费用账单核对。结果未知的任务需要核对扣费后再处理。

飞书联调可单独启用个人订阅或小红书助手。已登录的 Codex CLI 可用于本机初始管理员的个人验收，适配器通过正式 Codex CLI 登录路径工作。这是一轮文案和配图联调，不能当作多人生产额度。小红书助手需要专用 Chrome 与匹配账号，仅填写图文，保存和公开发布由操作者执行。

## 备份与回退

`ops/backup-production.ps1 -NodeExe <Node可执行文件路径>` 适用于模板默认生产库 `.data/production/workbench.sqlite`。先创建 `.data/production/backups`。Windows 安装用户可用 `Read-Host -AsSecureString` 输入单独备份口令，再经 `ConvertFrom-SecureString` 将加密值写入 `.data/production/backup-key.dpapi`；保持目录仅运维账号可读。可用计划任务每天运行，实际任务依赖该用户的 Windows 会话。

也可在受控终端设置 `WORKBENCH_BACKUP_PASSWORD` 后直接运行：

```powershell
node server/data-tool.mjs backup .data/production/workbench.sqlite <加密备份目标>
node server/data-tool.mjs restore <加密备份文件> <新的恢复库路径>
node --env-file=.env server/data-tool.mjs verify-restore <新的恢复库路径>
```

备份目标目录应已存在，命令拒绝覆盖已有文件。外置或异地保留独立备份，口令单独管理。隔离恢复并对账后才切换。暂停旧实例的写入和同步，避免新旧库同时运行。故障时停止该工作台的计划任务，保留数据库、日志和飞书记录以便核对。

## 验收

先跑本地自动测试。检查 HTTPS、本机及至少一台员工电脑访问、管理员与员工权限、飞书读写及备份恢复。需要测试真实飞书时，准备与正式表分开的空验收表，然后在进程环境设置 `WORKBENCH_ACCEPTANCE_TABLE` 和 `WORKBENCH_CA_FILE`，运行 `node --env-file=.env checks/production-smoke.mjs`。该检查会写入合成数据到验收表并核对正式表不变。正式客户资料、企业账号或公开发布的验收另行安排。
