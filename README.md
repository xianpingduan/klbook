# 错题集（klbook）

面向家庭的小学生错题收集应用。已实现本地家庭账号、设备登录、家长管理、账号恢复，以及电脑手动收集错题：上传图片、框题、选学科、保存并找回原始页。

## 本机启动

需要 Node.js 24.19.0 或更新的 24.x，以及 npm。依赖通过锁文件固定，不需要另装数据库服务。

在本项目目录打开 PowerShell：

```powershell
npm.cmd ci
npm.cmd run build
npm.cmd start
```

浏览器打开 <http://127.0.0.1:8787>。如果 npm 未加入 PATH，本机已验证的位置为 `E:\nvm4w\nodejs\npm.cmd`，用 `& 'E:\nvm4w\nodejs\npm.cmd'` 代替命令名。

默认数据保存在 `%LOCALAPPDATA%\klbook\data`，与源码和构建目录分离。首次启动生成 `setup-code.txt`；家长在家庭电脑打开该文件，将设置码填写到页面，并创建账号、密码和学习者称呼。随后**单独保存页面显示的恢复码**。密码至少 12 个字符。

如需指定目录，在启动前设置绝对路径，例如：

```powershell
$env:KLBOOK_DATA_DIR = 'E:\klbook\data'
npm.cmd start
```

切换数据目录会连接另一份资料库，不会迁移旧资料。使用本机磁盘目录，勿放在网络共享、源码、临时目录或网盘同步目录；限制该目录的 Windows 访问权限。初始化完成后设置码文件会删除。请勿删除 SQLite 文件来“重置密码”。

按 Ctrl+C 停止前台服务，再次 `npm.cmd start` 使用原目录即可保留账号和设备登录。端口占用时会报错，不会终止其他进程。

### 配置

| 变量 | 默认值 | 用途 |
| --- | --- | --- |
| `KLBOOK_DATA_DIR` | `%LOCALAPPDATA%\klbook\data` | 数据库、附件目录和首次设置码 |
| `KLBOOK_PORT` | `8787` | 后端回环端口；测试可用 `0` 分配空闲端口 |
| `KLBOOK_ALLOWED_ORIGINS` | `http://127.0.0.1:5173` | 额外允许的网页来源，以逗号分隔；生产 HTTPS 入口须显式填写 |

当前开发入口只监听本机 `127.0.0.1`。手机局域网 HTTPS 入口、证书和 Windows 常驻服务由 [#4](https://github.com/xianpingduan/klbook/issues/4) 等部署任务实现；此入口不等同于手机安装包。

## 收集一道错题

登录后点击“收集一道错题”，选择一张 JPEG、PNG 或静态 WebP 图片（最多 15 MiB、4000 万像素）。拖动框住题目，或点击“选择整页”，选好学科即可保存。来源、页码、题号、备注可留空，也可日后在详情中补充。

尚未整理完可“保存草稿”，之后从草稿列表继续。已收集列表可打开详情及完整原始页，原图中的作答和批改不会被裁剪覆盖。上传失败会保留待传图片，连接恢复后重新打开页面可继续上传；完整离线能力仍在后续 #9 实现。

当前不需要配置识别、语音或 AI 服务。图片、数据库均保存在上述本地数据目录。接口与重试约定见[手动收集设计](docs/manual-collection.md)。

## 家长管理与恢复

- 每台设备用家长账号、密码登录后，只获得日常会话，默认持续 30 天；退出、撤销、恢复账号会提前使它失效。
- 点击“家长管理”，再次输入密码；管理授权只属于当前设备，5 分钟后失效。可以查看设备并撤销，也可结束管理。
- 忘记密码：在登录页选择“使用恢复码”，设置新密码。账号与资料库保留，所有旧设备退出，同时生成新的恢复码。
- 首次页面误关或恢复码遗失，但仍记得密码：进入家长管理“重新生成恢复码”。旧码立即失效。
- 密码和恢复码均遗失时，当前版本没有绕过身份验证的重置入口。账号恢复与完整资料备份恢复不同；自动备份/完整恢复仍由 #23 实现。

不要将设置码、恢复码、密码或数据目录内容提交到 Git 或议题。

## 开发和验证

```powershell
npm.cmd run typecheck
npm.cmd run build
npx.cmd playwright install firefox webkit
npm.cmd test
```

浏览器测试使用本机 Microsoft Edge（Chromium）及 Playwright 的 Firefox、WebKit。上面的浏览器安装命令首次需要联网，浏览器保存在 Playwright 用户缓存中；不替换系统浏览器。测试自动创建、清理独立临时数据库，并启动隐藏的测试后端进程。浏览器测试依赖最新生产构建，请先 build。`npm.cmd run test:api` 可单独运行 API 测试；`npm.cmd run test:e2e` 单独运行浏览器流程。

排查特定存储目录的兼容性时，可以给 API 测试设置 `KLBOOK_TEST_DATA_PARENT`（已存在的绝对目录）。每个用例只在其中新建并清理独立的 `klbook-api-*` 子目录，不复用原有资料库；未设置时使用系统临时目录。环境差异应在实际部署目录验证，不能仅凭默认临时目录通过就判断兼容。

本机 npm 12 可能提示阻止 better-sqlite3 的原生重编译脚本；已验证 Windows x64 可直接使用此版本随包提供的二进制。无需为消除提示而放开全局安装脚本权限；以真实数据库测试结果为准。

交互开发可在两个终端分别运行 `npm.cmd run dev:server` 和 `npm.cmd run dev:web`，使用 Vite 提示的地址。正式可复现启动使用上面的 build/start。

## 项目导航

- [本地账号设计与 API](docs/authentication.md)
- [手动收集设计与 API](docs/manual-collection.md)
- [账号验证记录](docs/verification/issue-2.md) / [收集验证记录](docs/verification/issue-3.md)
- [技术选型](docs/technical-selection.md)
- [规格](docs/spec-collection-v1.md) / [开发任务](docs/development-tickets.md)
- [Android APK / iOS App Store 后续计划](docs/mobile-delivery.md)
