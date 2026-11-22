# 电脑租赁运营工作台

面向小型电脑租赁团队的内网工作台。销售从公共池领取线索，记录联系、回访和商机。运营根据已确认的业务资料生成内容、提交审核、排期并下载发布包。工作台是写入入口，飞书多维表用于同步查看和汇总。

## 已实现

| 模块 | 功能 |
|---|---|
| 销售 | CSV / Excel 预览、列映射、去重、并发领取、联系记录、回访、勿扰与商机 |
| 内容 | 小红书和抖音账号分配、素材库、业务资料版本、稿件审核、排期、发布包和草稿凭证 |
| AI | 生成文案、配图和图片编辑，带入新稿件。演示用模拟模型，正式环境可配置 OpenAI API |
| 运维 | 飞书写入核验与对账、审计、任务状态、HTTPS、加密备份和隔离恢复 |

小红书图文填写助手是本机联调功能，首次需登录专用 Chrome，暂存和公开发布由操作员确认。公开发布、其他形式的一键填写和评论线索暂未纳入交付。小红书与抖音图文、视频均可导出人工发布包。

## 本地快速开始

准备 Node.js 24.14 或更高版本，并在项目根目录运行：

```powershell
npm.cmd ci
npm.cmd run build
npm.cmd run demo
```

macOS 或 Linux 将 `npm.cmd` 替换成 `npm`。Windows 也可双击 `启动销售工作台演示.cmd`。打开 [本机演示](http://127.0.0.1:4188/)，演示库保存于 `.data/demo.sqlite`，无需飞书或模型密钥。

| 演示角色 | 账号 | 演示口令 |
|---|---|---|
| 管理员 | `admin` | `demo-admin-2026` |
| 销售甲 | `lin` | `demo-sales-2026` |
| 销售乙 | `zhou` | `demo-sales-2026` |

1. 以管理员登录，在「导入记录」加载内置样表或上传 `examples/sample.xlsx`、`examples/sample.csv`，预览后确认。样表预期为 3 条新增、1 条重复和 2 条待复核。
2. 用另一个浏览器配置或隐私窗口登录销售账号，在「客户线索」领取，再登记联系、商机与回访。
3. 内容演示从「账号管理」登记演示账号、分配人员开始。准备业务资料与素材，随后走通写稿、审核、排期和回填。

示例号码用于验证字段和流程。真实运行使用独立凭据和数据库。

## 测试与构建

```powershell
npm.cmd test
npm.cmd run build
npm.cmd run test:browser
```

前两项无需账号。浏览器检查需要本机 Chrome，非默认安装路径可用 `CHROME_PATH` 指定。浏览器检查使用隔离数据库和模拟小红书页面。真实飞书验收需显式指定独立验收表，步骤见部署手册。

## 飞书联调与正式部署

| 环境 | 配置 | 启动命令 | 要求 |
|---|---|---|---|
| 本机演示 | 默认 | `npm run demo` | 环回内网，模拟数据和 AI |
| 飞书联调 | `.env.feishu-test` | `npm run feishu:test` | 独立新表，绑定环回地址 |
| 正式 | `.env` | `npm start` | HTTPS、指定私网地址、正式飞书表 |

模板见 [正式环境配置](.env.example) 和 [飞书联调配置](.env.feishu-test.example)。飞书字段、Windows 计划任务、证书与备份操作见[部署与维护](docs/deployment.md)。

## 项目目录

```text
src/        React 工作台页面
server/     Express 服务、SQLite、飞书和 AI 适配
examples/   可导入的演示样表
ops/        Windows 部署、证书、备份脚本
test/       Node 自动测试
checks/     浏览器验收及独立飞书联调检查
docs/       架构、部署与实施计划
```

更多资料：[架构与数据边界](docs/architecture.md) · [开发约定](CONTRIBUTING.md) · [安全报告](SECURITY.md) · [版本记录](CHANGELOG.md) · [V1.1 建设方案](电脑租赁_AI运营工作台_建设方案_V1.1_优化稿.md)。
