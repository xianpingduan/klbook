# Android APK 与 iOS App Store 交付计划

更新：2026-09-18。用户已明确最终需要 Android APK 安装及 iOS App Store 下载，并确认“目前没有 Mac 和 Apple Developer 会员，先预留发布方案”。因此当前继续完成已发布的 24 项收集功能，架构从现在支持移动端接入；安装包与上架是已确认的后续交付目标，不能将网页里程碑完成视为这些目标已完成。

GitHub 跟踪：[后续移动交付里程碑 #26](https://github.com/xianpingduan/klbook/issues/26)，待分诊与细拆；当前基础任务 #2 已增加平台边界验收，规格 #1 与当前网页验收任务 #25 同步注明阶段区别。

2026-09-20 检查已在 #26 明确：逐项映射父规格 T01—T28 的平台适用性，移动 App 需覆盖完整收集、归档查找及系统文件导入导出，不能仅以单张照片流程验收。尚待细化的移动场景与任务见 [检查记录](spec-tickets-review.md)。

## 1. 选型与交付形态

采用 **React + TypeScript + Vite + Capacitor**：共享主要界面和业务逻辑，移动端用原生工程承载，并通过插件调用相机、文件与安全凭据存储。电脑继续用网页；家庭资料库继续由 Windows 本地后端管理，手机 App 安装成功不代表电脑关机后仍能访问服务器资料。

| 目标 | 交付物 | 当前状态 |
| --- | --- | --- |
| Android 手机/平板 | 正式签名 APK、安装说明、可保留资料的升级路径 | 纳入后续里程碑，尚未构建 |
| iPhone/iPad | 经测试、提交审核并获准在所选 App Store 地区提供的 App | 纳入后续里程碑，构建/签名资源尚未具备 |
| 电脑及浏览器 | 自适应网页，按原任务增加 PWA 能力 | 当前 24 项开发任务的主要交付形态 |

Capacitor 官方支持 Android、iOS、Web，能接入已有现代 JavaScript 项目；本项目据此选择复用 React 页面。React Native/Flutter 同样能做移动 App，但会增加另一套界面实现，本项目当前优先保留网页与电脑端复用。[Capacitor 官方介绍](https://capacitorjs.com/docs)

**页面随安装包发布。** Vite 产物复制进 Android/iOS 工程，正式 App 不通过 `server.url` 加载家庭电脑网页；该配置官方定位为开发热重载。客户端的“服务地址”仍只是数据 API 目标，不能控制带有原生插件权限的页面加载来源。[Capacitor 配置](https://capacitorjs.com/docs/config)

## 2. 现在预留哪些接口

#2 建立前端时，由页面通过少量明确接口访问设备能力；只实现当前需要的网页适配，不预建没有用例的插件框架。

| 边界 | 网页实现 | 移动 App 实现方向 |
| --- | --- | --- |
| 采集图片 | 文件选择/浏览器相机 | 原生相机与相册选择；取消、权限拒绝及进程恢复可处理 |
| 草稿与待同步文件 | IndexedDB | 应用私有文件目录及事务性元数据存储；不把 WebView IndexedDB 当唯一可靠副本 |
| 设备凭据 | 原有网页来源内的设备凭据策略 | Keychain/Android Keystore 支持的安全存储适配；Preferences 仅存普通设置 |
| 请求与附件传输 | fetch、精确 CORS | 同一 API 契约下验证 WebView 请求或原生网络适配；保留超时、取消、重试、目标隔离语义 |
| 导入导出 | 浏览器下载和文件选择 | 系统文件选择/分享；仍遵守资料包格式和家长权限 |

设备暂存的具体原生数据库与安全存储插件在移动可行性验证时固定。Capacitor 官方提醒 WebView 存储可能被系统回收，Preferences 适用于少量设置；图片不能仅保存在相机临时 URI 或 Preferences 中。[存储指南](https://capacitorjs.com/docs/guides/storage)、[Preferences](https://capacitorjs.com/docs/apis/preferences)

应用级 API 客户端继续执行：新服务地址不携带旧凭据、认证后核对 `libraryId` 和账号、同库续传、异库隔离、迟到响应不污染当前目标。原生安全存储也不能消除不可信脚本调用插件的风险，App 仅加载随包可信代码。

## 3. 移动端必须另做的验证

- **局域网 HTTPS**：保留证书和主机名验证。Android App 的证书信任与浏览器不同，面向 Android 7+ 的应用默认不信任用户添加的 CA；动态家庭地址、Caddy 本地 CA、原生网络与 WebView 的信任方案必须在发布构建上验证。不能通过信任所有证书或关闭 TLS 校验解决。[Android 网络安全配置](https://developer.android.com/privacy-and-security/security-config)
- **iOS 局域网权限**：说明访问家庭电脑的用途，并处理拒绝、重新授权和地址改变；局域网权限、ATS 传输策略、证书信任分别验证，不能互相替代。[Apple 局域网用途说明](https://developer.apple.com/documentation/bundleresources/information-property-list/nslocalnetworkusagedescription)
- **图片与生命周期**：验证批量相册、原图字节/方向、HEIC、超大图片、取消和系统回收后恢复。Android 不依赖 Google 服务才能完成基本选图；官方 Camera 插件对不支持系统 Photo Picker 的设备有文档选择回退，仍需国产实际设备验证。[Camera 插件](https://capacitorjs.com/docs/apis/camera)
- **大文件传输**：图片和资料包采用文件/流式方案实测，不能假定原生桥接能安全承载任意大小的 base64。原生 HTTP 插件也不豁免 TLS 校验。[Capacitor HTTP](https://capacitorjs.com/docs/apis/http)
- **离线**：App 自带页面，服务不可达时仍能打开连接设置；尚未连接过任何资料库时不自动替孩子决定草稿归属。已成功暂存的图片在退出、重启与正常升级后保留；同库登录后前台补传。不承诺锁屏一直上传或卸载后保留未同步资料。
- **升级**：稳定 App ID、Android 签名和客户端存储迁移；老客户端与新后端不兼容时阻止上传并给出可恢复提示。证书/签名私钥不进入 Git，也不包含在学习资料包里。
- **实际能力**：安装包内可完成采集、整理、离线暂存、查找等功能；仅打开远程网站不足以作为完整移动交付。商店审核要求见 [发布调研](research/app-store-delivery.md)。

## 4. 环境与版本记录

以下是选型基线，不是已构建通过的清单。正式实施时重新核对相互兼容的稳定版本并生成锁文件。

| 项目 | 本次核实 |
| --- | --- |
| Capacitor core / cli / android / ios | npm 官方注册表均为 8.5.2；cli 要求 Node >=22，本机 Node 24.19.0 符合；未安装 Capacitor |
| Camera / Filesystem | 官方包当前分别为 8.2.4 / 8.1.3，要求 core >=8；尚未选定完整插件组合 |
| Android 构建 | 已核实本机 Temurin JDK 21.0.11；PATH 的 java 指向旧 Java8，后续构建应显式配置兼容 JDK，不能直接依赖当前 PATH |
| Android Studio / SDK | PATH 和本次检查的常用目录未发现；不能据此证明整机绝对没有，安装前需再查 |
| iOS 构建 | 用户确认当前没有 Mac 或开发者会员；本地 Windows 不能直接完成 Xcode 构建，后续使用自有或受控云端 macOS 环境 |

Capacitor 8 文档要求 Node 22+、Xcode 26+、Android Studio 2025.2.1+；具体 Android compile/target SDK、Gradle 与插件要求在工程建立时一起固定。工具的最低版本、App 的最低可运行系统版本和 App Store 提交 SDK 要求是三件不同的事。最低 Android/iOS/WebView 支持版本结合家中实际设备及插件能力确定，不用框架最低版本替代真机验收。[Capacitor 环境要求](https://capacitorjs.com/docs/getting-started/environment-setup)

## 5. 后续里程碑的工作顺序

1. **接通最小移动流程**：建立 Android/iOS 工程，复用已构建页面；在设备上完成配置家庭服务、登录、选一张图并保存，优先验证 HTTPS/权限/文件路径。Mac 可用后尽早验证 iOS，不等上架前才验证。
2. **补齐移动可靠性**：原生暂存和凭据、图片与文件传输、重启/升级、切换资料库隔离；复用服务端行为测试，另补真实安装包验证。
3. **Android 签名交付**：可安装 APK、签名保管、升级验证和安装指南；未要求 Google Play 发布，AAB/Play 发布可另作决定。
4. **iOS 测试和发布准备**：具备 Mac/云端 Mac 与会员后，完成签名、真机测试和 TestFlight 测试；准备商店资料、隐私说明和可供审核访问的完整功能。TestFlight 仅代表测试分发。
5. **App Store 提交及结果跟踪**：确认发布主体、地区、商店受众分类及适用材料，按当时要求提交并处理反馈；以审核结果和实际可下载状态记录最终交付，不保证提前通过审核。

前三类外部能力的每月 50 元运行预算保持原约定；Mac/云端 Mac、Apple Developer 会员和发布费用属于另行安排的开发/发布成本。本次只记录计划，不购买、不开户、不提交商店审核。

家庭局域网后端无需因上架而公开到互联网。审核访问方案要提前设计，可研究隔离的合成示例资料或其他 Apple 接受的验证方式；方案必须支持真实功能体验，不能使用家庭真实材料，也不能未经允许开启外网服务。
