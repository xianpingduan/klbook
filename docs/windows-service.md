# Windows 自动启动与电脑维护

对应 [任务 #22](https://github.com/xianpingduan/klbook/issues/22)。沿用已选的 Windows 原生服务部署；SQLite 是随应用加载的本地库，不需要另启动数据库服务器。

## 运行方式

- `KlbookApp`：WinSW 包装 Node 后端，只监听本机回环地址。
- `KlbookGateway`：WinSW 包装 Caddy，依赖 `KlbookApp`，提供原家庭局域网 HTTPS 入口。
- 两者以无密码的 `NT AUTHORITY\LocalService` 运行，设置自动延迟启动。异常退出依次等 30、60、120 秒重试，之后每 120 秒重试；不会自动重启电脑或更改休眠策略。
- 服务账号对程序只有读取/执行权限，只能修改指定数据目录、日志和证书状态目录。准备目录复制完整构建、生产依赖和运行时，后续运行无需打开开发工具或依赖源码目录。

配置依据：[WinSW 2.12.0 配置文档](https://github.com/winsw/winsw/blob/v2.12.0/doc/xmlConfigFile.md)、[微软 LocalService 说明](https://learn.microsoft.com/en-us/windows/win32/services/localservice-account)。安装、启停系统服务需要 Windows 管理员权限。

## 启动检查

正式服务固定已校验的资料目录及资料库身份，并启用 `KLBOOK_REQUIRE_EXISTING=1`。启动时先核对数据库、附件目录、写入权限、SQLite 完整性及外键、所有已登记原图和预览的 SHA-256，以及网页构建入口；通过后才开始监听业务端口。

目录丢失、附件损坏或接错资料库会退出并写明原因，不新建空资料库。修复后可在维护工具中重新启动。`logs/startup.json` 记录 checking/ready/failed/stopped、时间和进程；不包含密码、服务密钥或题目内容。未启用常驻模式的首次手动启动仍支持原有家庭初始化流程。

维护工具同时检查两个 Windows 服务、当前进程、后端接口和严格验证证书的 HTTPS 请求；只有全部就绪才显示可用，不能把端口监听或 SCM 的 Running 单独当作业务就绪。

维护探测也按 UTF-8 解码 Node 返回的 JSON，避免中文状态消息在 Windows PowerShell 的本地代码页下破坏 JSON 并误判服务失败。`test/windows/service-probe.ps1 -ServiceDir '<ServiceDir>'` 使用真实且可用的 HTTP/HTTPS 验证代码页 936 与 UTF-8；仅有接口可达不会把未安装的 Windows 服务报告为就绪。

启停命令会等待最多 40 秒观察业务状态。此时若当前进程仍在校验资料，返回“正在校验”并保留服务继续运行，窗口自动刷新；不因资料较多就卸载服务，也不提前标为就绪。已确认的启动失败仍显示原因。

## 准备与安装

先完成原家庭初始化及一次完整备份，构建当前版本。准备工具只接受独立且不存在的目标目录，保留原资料和原根证书，不覆盖已有服务目录。

```powershell
npm.cmd run build
.\scripts\prepare-windows-service.ps1 `
  -ServiceDir "$env:ProgramData\klbook\service" `
  -DataDir '<已初始化并确认可供服务访问的资料目录>' `
  -GatewayDir '<已有网关目录>' `
  -NodeExe '<Node 24 的 node.exe>' `
  -CaddyExe '<已验证的 caddy.exe>' `
  -WinSWExe '<WinSW.NET461.exe>'
```

WinSW 使用官方 [2.12.0 发布](https://github.com/winsw/winsw/releases/tag/v2.12.0)的 `WinSW.NET461.exe`，SHA-256 为 `b5066b7bbdfba1293e5d15cda3caaea88fbeab35bd5b38c41c913d492aadfc4f`。该摘要是首次从官方 HTTPS 发布获取后固定的文件摘要，不冒称发布方签名；本机文件版本 2.12.0.0，Windows .NET Framework Release 值 534296。Node 与 Caddy 实际版本记录于准备目录的 `deployment.json`。

准备工具会按 UTF-8 读取 npm 输出的依赖路径，再恢复原控制台编码，兼容 Windows PowerShell 5.1 的中文代码页及中文项目目录。完整准备回归入口为 `test/windows/prepare-service.ps1`，参数与准备工具一致；应提供隔离且已初始化的资料副本及新的独立目标。回归只生成并校验运行副本，不注册服务。

核对生成的 `deployment.json`、两个 XML、`Caddyfile` 和维护脚本。先在旧服务仍运行时检查存储：

```powershell
& '<ServiceDir>\scripts\maintain-windows.ps1' -ServiceDir '<ServiceDir>' -Action CheckStorage
```

若目录或其中任何文件使用用户专属 EFS 加密，准备/安装工具会拒绝继续。目录 ACL 放行不等于服务账号获得了解密密钥；工具不自动解密原资料。通过后才停止已确认身份的旧临时应用及网关进程，再在管理员 PowerShell 执行：

```powershell
& '<ServiceDir>\scripts\install-windows-service.ps1' -ServiceDir '<ServiceDir>'
```

安装脚本会验证原资料库、拒绝覆盖已有同名服务或占用端口，授予限定目录权限，注册服务，并添加只允许本机局域网地址、HTTPS 和证书下载端口、LocalSubnet 及新 Caddy 程序的防火墙规则 `Klbook-Service-HTTPS`。不开放后端回环端口、不安装系统信任根、不修改旧规则。启动失败时撤销本次新建服务和防火墙规则，保留目录、诊断与资料，便于修复后重新安装。

## 电脑维护入口

开始菜单搜索 **错题集电脑维护**，或打开安装目录中的 `maintenance.cmd`。窗口能刷新状态、查看日志、启动、停止和重新启动；后端已停止时仍可使用。启停需要管理员授权，停止/重启前提示保存当前编辑。普通查看状态不需要管理员权限。

也可运行命令：

```powershell
& '<ServiceDir>\scripts\maintain-windows.ps1' -ServiceDir '<ServiceDir>' -Action Status
# 管理员 PowerShell：Action 可选 Start、Stop、Restart
```

维护窗口显示实际运行版本、数据目录和局域网入口。日志位于 `logs`，各服务日志按大小轮换，保留五份；如服务未启动，先阅读 `startup.json` 和对应 wrapper/err 日志。端口占用时核对占用程序，工具不会结束其他程序。局域网 IP 改变需重新核对 Caddy 绑定、允许来源及防火墙规则；固定 DHCP 租约有助于维持原网页入口。

## 证书与数据保护

准备时复制原 Caddy 状态及公开根证书并核对摘要，保持已信任该根的手机连接方式。公开根在 `public/klbook-root.crt`；私钥只在 `gateway-state`。新设备仍需按[局域网采集步骤](lan-capture.md)信任根证书。维护探测显式使用该根，不关闭 TLS 校验。

证书下载保留在 `http://<家庭电脑IP>:8080`（准备参数 `CertificatePort` 可调整）。HTTP 仅允许入口说明和公开根证书，其余路径返回 404，账号和题目仍只能通过 HTTPS 访问。安装前请在电脑上核对根证书，不能只信任下载页面自身显示的摘要。

资料、服务凭据密钥仍保留在原 data 目录；程序文件和资料分开。停止服务不是删除资料。升级前停止两个服务并备份一致的 SQLite、附件、密钥及网关状态，换入经过验证的完整构建后再启动；不要把源码的 `dist` 更新当作独立运行副本已自动更新。完整备份/恢复及每天备份分别由 #23/#24 实施。

### 原目录采用 EFS 时

本机已发现用户 `AppData` 及其服务程序、家庭数据库采用 EFS。LocalService 与当前 Windows 用户身份不同，不能仅靠增加目录权限访问用户专属加密文件。[微软 EFS 说明](https://learn.microsoft.com/en-us/windows/win32/fileio/file-encryption)。

迁移方案：服务程序使用 `C:\ProgramData\klbook\service`，资料使用 `C:\ProgramData\klbook\data`；先停服制作一致备份，再创建受限目录并复制，逐表逐附件核对后切换。新副本不使用用户专属 EFS 加密，以 Windows 目录权限限制为原用户、管理员、SYSTEM 与 LocalService；服务账号对程序只读，对专用资料目录可写。原加密目录和备份保留。该方案改变新副本的静态存储保护方式，必须取得用户同意，不能因用户允许安装服务就自动解密或迁移。当前用户已于 2026-10-20 明确同意此方案，实际执行结果见[验收记录](verification/issue-22.md)。

如果用户希望继续保留原 EFS 保护，应保持现有手动运行方式，另行明确是否接受“登录 Windows 后启动”的需求调整。

### 管理员终端找不到旧目录时

同一 Windows 用户下，打包应用启动的进程与外部管理员终端可能看到不同的 `AppData` 文件视图。Windows 可以把写入重定向到应用的 `LocalCache`，因此仅把当前环境中的绝对路径交给系统服务，仍可能报告路径不存在。[微软打包应用文件系统说明](https://learn.microsoft.com/en-us/windows/msix/desktop/desktop-to-uwp-behind-the-scenes)。

本机已通过 Windows 文件句柄的实际路径确认这一情况。迁移时使用核实后的物理源路径，并在停服前核对原家庭资料库身份、附件和凭据文件可读性；备份及失败恢复也使用同一物理源。原 `deployment.json` 内的逻辑路径仅作为原安装身份记录，不直接传给外部服务。目标仍为已批准的 `C:\ProgramData\klbook`，不修改 Windows 的应用虚拟化策略、不删除原加密资料。

## 实机验收

1. 保存所有工作，用户手动重启电脑。验证未打开开发工具时两个服务自动启动，维护入口显示全部就绪。
2. 同一 Wi-Fi 的手机使用原 HTTPS 地址登录/恢复会话，打开既有题目和原图，核对题目数量及内容。
3. 电脑维护入口停止服务，确认手机提示无法连接并保留未同步材料；维护窗口仍能查看状态及重新启动。
4. 重新启动后手机重试，确认材料可找回且不重复；记录设备、浏览器、时间、服务自动状态和手动启停结果。

服务进程重启、隔离目录故障与桌面浏览器自动化均不能代替真实电脑重启和第二设备验收；未完成项在任务中保留开放。
