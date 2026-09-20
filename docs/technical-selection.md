# 收集版基础技术选型

日期：2026-09-18；实现补充：2026-09-20。对应 [任务 #2：确定基础技术方案并跑通本地家庭登录](https://github.com/xianpingduan/klbook/issues/2)。选型后的家庭登录、恢复、设备撤销和权限实现见[账号设计](authentication.md)与[验证记录](verification/issue-2.md)；可复现启动见根目录 [README](../README.md)。本记录中 9 月 18 日的兼容性探针仍只代表当时选型验证。

## 1. 选型结论

采用 **TypeScript + React + Vite 前端、Capacitor 移动端、Node.js + Fastify 后端、SQLite + 本地附件目录、Caddy HTTPS 入口和 Windows 原生服务**。共享网页主要界面与业务逻辑，最终交付 Android APK 与 iOS App Store App；电脑保留网页。用户确认目前没有 Mac 和开发者会员、先预留发布方案，当前 24 项继续完成网页收集里程碑，移动安装与发布单独跟踪，详见 [移动交付计划](mobile-delivery.md)。

| 层次 | 本次选择 | 为什么适合本项目 |
| --- | --- | --- |
| 语言与运行时 | 前后端 TypeScript；Node.js 24 LTS | 复用本机运行时，前后端共享接口类型；不因电脑已有 Python 就额外引入第二套后端运行时 |
| 前端 | React + Vite，构建为静态文件 | 收集、裁剪、离线暂存以客户端交互为主，无需服务端渲染；静态页面可由本机直接提供 |
| 移动端 | Capacitor，页面随 Android/iOS 安装包发布 | 复用主要界面，按平台适配相机、文件、凭据、网络和升级；不是把后端地址当远程页面加载 |
| 后端 | Fastify，REST/JSON API，单进程模块化应用 | 请求校验、权限和持久化集中处理；不拆微服务 |
| 数据库 | SQLite，通过 better-sqlite3 访问 | 单家庭、单服务器、少量设备写入，减少独立数据库服务的安装和运维 |
| 数据访问 | 带版本的 SQL 迁移、参数化 SQL、按业务职责封装存储模块 | 保留事务和约束的可见性；接口不暴露数据库连接，不预建通用 CRUD 框架 |
| 附件 | 后端管理的本地文件目录；sharp 解码和预览 | 原始页字节保留，预览为衍生文件、题目区保存坐标；客户端只经鉴权 API 访问。#3 的格式与限制见[收集设计](manual-collection.md) |
| 设备暂存 | 网页用 IndexedDB / Service Worker；移动 App 用私有文件与事务性元数据存储 | 同一同步规则、不同平台存储实现；网页在 #9 实施，原生存储在移动里程碑验证 |
| 登录 | 本地账号；可撤销的不透明设备会话令牌；管理操作另验家长身份 | 支持固定网页来源连接不同后端，避免依赖跨站 Cookie |
| HTTPS 与常驻 | Caddy 2；Node 后端由 WinSW 2 包装为自动 Windows 服务 | 满足开机后服务可用；不以 Docker Desktop 的用户登录启动为前提 |
| 测试 | Node 内置测试运行器 + Playwright；真实隔离 SQLite 和附件目录 | 验证完整操作及公开接口；外部服务适配器才使用替身 |
| 包管理 | npm；提交精确依赖与 package-lock.json，使用 npm ci | 复用已有工具，安装可复现；本项目不混用 npm/pnpm 锁文件 |

React 官方支持用 Vite 建立客户端应用；Node 24 当前处于 LTS；Fastify 的支持政策跟随受支持的 Node LTS，并要求相应版本线的最新补丁。因此本次在现有 Node 24.19.0 上验证，正式部署前还需核对并验证 24.x 的维护更新，不能将“本机可运行”当作长期补丁策略。[React](https://react.dev/learn/build-a-react-app-from-scratch)、[Node 发布状态](https://nodejs.org/en/about/previous-releases)、[Fastify 支持政策](https://fastify.dev/docs/latest/Reference/LTS/)

## 2. 用户要求、历史建议与本次决定

- **已确认要求**：中国大陆家庭局域网；本地电脑主存储；Android/Apple/电脑组合；客户端配置服务地址；保留原图；断网暂存、前台恢复补传；家长管理；可扩展学科；三类外部能力独立启停；每日备份与开机启动。
- **此前建议**：PostgreSQL 是部署文档中的候选建议，规格没有锁定数据库、框架、容器或具体版本。
- **基础决定**：以 SQLite 代替此前 PostgreSQL 建议；原生 Windows 部署；以设备令牌支持可变 API 目标。
- **后续用户补充（同日）**：最终 Android APK 和 iOS App Store 分发，当前无 Mac/会员、先预留。新增 Capacitor 方向及平台边界；安装包目标已纳入路线，不能把当前网页验收等同于移动发布完成。
- **仍按原任务决定**：OCR、语音转写、AI 供应商/模型分别在 #13、#15、#16 选定；每月 50 元服务预算保留。图像解码已在 #3 采用 sharp 并实测；PWA 具体插件和正式证书安装配置仍在后续任务落实。

## 3. 本机环境核实

只读核实于 2026-09-18；依赖验证仅写入项目 `.scratch/technical-selection/`。没有修改全局 Node、启动 Docker、安装系统服务、调整防火墙或导入根证书。

| 项目 | 实际结果 | 采用方式 |
| --- | --- | --- |
| 系统与硬件 | Windows 11 专业工作站版，64 位；Ryzen 9 7900X / 24 逻辑处理器；约 31.1 GiB 内存 | 足够承担当前本地服务，不以此推定外部大模型能在本机运行 |
| 磁盘可用空间 | C 约 79.6 GiB；D 约 148.8 GiB；E 约 1464.4 GiB | 数据目录可优先安排 E 盘；盘符不同不证明是不同物理磁盘 |
| Node/npm/pnpm | `E:\nvm4w\nodejs`：Node 24.19.0、npm 12.0.2、pnpm 11.9.0 | 开发验证复用 Node/npm；正式服务固定运行时位置，避免 NVM 切换影响服务 |
| Python | Python312 为 3.12.10；Python314 为 3.14.6 | 可用于工具脚本，当前后端不依赖 Python |
| Docker | Desktop 4.86.0；CLI 29.7.2；Compose 5.5.0；本次未连接到 Linux engine | 已安装，但不是本方案运行依赖 |
| PostgreSQL 等 | PATH、相关服务和所查安装登记未发现可复用 PostgreSQL；未发现 Caddy/WinSW 命令 | 不声称整机完全未安装；正式安装前再次查端口、服务和目标目录 |
| .NET | 当前解析到 x86 dotnet，`--list-sdks` 没有输出 | 不足以证明全机没有 SDK，也不以此建立 .NET 后端依赖 |

## 4. 比较过的主要方案

| 方案 | 收益 | 当前代价 / 结论 |
| --- | --- | --- |
| **React + Fastify + SQLite，Windows 原生** | 单一应用语言；无需独立 DB 服务；适合局域网家庭使用 | 要约束长事务和同步 SQL 耗时；**采用** |
| React + Fastify + PostgreSQL | 更适合多实例、大量并发写入，数据库管理能力丰富 | 当前没有已确认可直接复用的 PG 服务；增加安装、账号、升级和备份维护；**保留为规模扩大后的候选** |
| React + Python/FastAPI + SQLite | 可复用 Python，适合以后自托管识别或 Python 专用计算 | 此时外部能力通过后端适配器接入即可；前后端增加两套工具链，当前无必须使用 Python 的业务依赖；**不作为主后端** |
| Next.js 等全栈 SSR 框架 | 统一框架与服务端渲染 | 此项目没有 SSR/SEO 收益；固定客户端来源、离线和可变后端仍要单独设计；**不引入** |
| React + Capacitor | 共享网页界面，同时建立 Android/iOS 原生工程 | 增加插件、原生存储与平台验证；为新增 APK/App Store 目标**采用**，尚未构建验证 |
| Flutter/React Native/分别原生开发 | 更深入的平台界面和设备能力 | 增加另一套界面或多套实现；目前共享收集界面优先，**未选择** |

SQLite 适合应用本地存储，但 WAL 仍只有一个写者，且数据库必须在本机文件系统；增加家庭或多后端并发写入时要重新测量和评估 PostgreSQL，不能承诺无成本切换。[SQLite 适用场景](https://www.sqlite.org/whentouse.html)、[SQLite WAL](https://www.sqlite.org/wal.html)

选择 better-sqlite3 的事务及备份 API，代价是需要验证 Windows 原生二进制。Node 内置 `node:sqlite` 在当前 24.x 文档仍标为 Release candidate，本次不把它作为主要存储接口。驱动版本升级须复核其内置 SQLite 变化及恢复能力。[better-sqlite3](https://github.com/WiseLibs/better-sqlite3)、[Node SQLite 状态](https://nodejs.org/docs/latest-v24.x/api/sqlite.html)

## 5. 后续实现必须遵守的边界

### 数据与附件

- 仅本机后端打开数据库；手机不直接打开 SQLite 文件，不把运行中的数据库放入 SMB 共享、网盘同步目录。
- 每个连接启用外键；采用 WAL、`synchronous=FULL`、有限 busy timeout；用短事务、唯一约束、稳定操作 ID 和修订号防重复及静默覆盖。网络请求、OCR、图片转换不放进数据库事务；大型导入分阶段落地，最后原子发布。
- 图片先写尚未发布的独立 UUID 目录并完成校验/持久化，再以稳定附件 ID 关联数据库提交；附件仅在提交后能经 API 读取，不依赖目录重命名。失败可重试，未提交孤立文件可清理。原始文件不可就地覆盖，共享引用和回收站清理统一管理。
- 一致备份必须包含数据库快照及其所引用的附件；使用驱动备份 API 或受控停写，备份期间保护附件免于清理。不能只复制正在写入的 `.sqlite` 主文件。本次快照小验证不等于 #23 的全服务备份验收。
- 数据与应用分目录。正式部署建议 `E:\klbook\app`、`E:\klbook\data`，由显式 `KLBOOK_DATA_DIR` 指定；本次未创建这些目录。备份路径独立可配置，真正的其他磁盘/设备须再核实。

### 连接、账号和离线

- 一个后端实例管理一个家庭资料库和一个学习者。初始化生成并持久保存随机 `libraryId`，重启不重建。
- 网页保持稳定 HTTPS 来源；移动 App 随包携带页面和连接设置。两者所有 API/附件经统一客户端访问所选服务地址。新地址先无凭据探测，然后重新认证并核对资料库/账号；不能仅凭自报 UUID 将旧令牌发送过去。
- 会话采用随机不透明令牌，后端只保存摘要、有效期、设备与撤销状态；正常设备登录和短期管理授权分开，由服务端强制检查。具体密码哈希、恢复凭据和限速在 #2 登录实现中落实并验证。
- 网页持久设备凭据可被同源脚本读取，这是兼容跨站目标的代价；移动 App 单独通过 Keychain/Keystore 支持的存储适配保管凭据。两者限制脚本来源，禁止不可信 HTML、远程代码和令牌日志。网页受保护图片以鉴权 fetch 取得 Blob 显示；移动附件通过统一鉴权适配读取，不把令牌放 URL。精确 CORS 白名单不能代替身份验证。
- 设备暂存按资料库和账号隔离；未确认资料库前使用独立的未绑定空间。网页采用 IndexedDB，移动 App 另做原生存储；换址暂停旧队列，迟到响应不得写入新库。网页 Service Worker 缓存页面，不缓存登录凭据响应。
- 网页离线页面须先在线准备；移动页面由安装包提供，家庭资料仍需已下载或在本设备采集。空间不足、存储清理及锁屏后台限制必须如实处理。承诺联网重新打开后补传，不依赖 Background Sync。

上述选择的浏览器事实、来源及真机检查清单见 [浏览器与局域网研究](research/browser-and-lan-constraints.md)。其中 Safari 第三方 Cookie 限制是选择显式设备令牌的主要依据。[WebKit](https://webkit.org/blog/10218/full-third-party-cookie-blocking-and-more/)

### 部署与测试

- 开发时可用 Vite dev server；#4 的生产入口由 Caddy 提供 HTTPS，并将页面和 API 统一转发给回环地址上的 Fastify，沿用后端静态文件及响应头规则。各设备需实际信任根证书，步骤见[局域网采集](lan-capture.md)。
- Caddy 和后端以 Windows 自动服务运行；后端包装器采用 WinSW，设置服务账户、数据权限、重启策略和日志；证书、服务安装在 #4/#22 落实。本次没有运行生产服务。
- 默认不增加 Redis、RabbitMQ 或 MinIO。后台作业状态先持久化到 SQLite，由本地工作循环执行；到具体任务再验证失败重试、租约与停用行为。
- 测试使用真实隔离数据库和目录，从公开 API/浏览器验证初始化、登录、重启、撤销、恢复、管理越权；仅替换外部识别/转写/AI 服务。设备暂存用真实浏览器存储测，不以存储 mock 代替。
- 自动化浏览器覆盖 Chromium、Firefox、WebKit；实际 Android Chrome、iPhone/iPad Safari 的相机/相册、HTTPS、跨目标登录和离线重开仍需真机补验。Playwright WebKit 不等于 iOS 真机。

## 6. 版本基线与验证记录

版本来自本机命令、npm 官方注册表及项目官方发布页，核对日期为 2026-09-18。这些是本次验证基线，非永久固定在旧补丁；升级采用单独变更、锁文件和回归测试。

| 组件 | 基线 |
| --- | --- |
| Node / npm | 24.19.0 / 12.0.2（本机实测）；生产前复核 Node 24.x 最新维护补丁 |
| TypeScript | 7.0.2 |
| React / React DOM | 19.3.0 / 19.3.0 |
| Vite / React 插件 | 8.3.0 / 6.1.1 |
| Fastify | 5.12.5 |
| better-sqlite3 / SQLite | 13.0.3 / 3.53.4（实际加载查询） |
| Playwright | 1.63.0 |
| Capacitor core / cli / android / ios | 8.5.2（已查官方包元数据，未安装或构建验证） |
| Caddy / WinSW | [2.11.4](https://github.com/caddyserver/caddy/releases/tag/v2.11.4) / [2.12.0](https://github.com/winsw/winsw/releases/tag/v2.12.0)；#4 已校验并运行 Caddy，严格 TLS 探针通过，真机信任待验收；WinSW 在 #22 实施 |

Vite 的 Node 要求为 20.19+ / 22.12+，本机 24.19.0 满足范围；驱动及其他包同时用严格引擎检查和实际加载验证，不能只凭主版本推断兼容。[Vite 要求](https://vite.dev/guide/)

验证程序、复现命令及精确依赖放在 [临时兼容性验证目录](../.scratch/technical-selection/README.md)，仅包含虚构资料，不是业务应用。2026-09-18 本机结果：

- 严格引擎检查安装成功，生成 package-lock.json；better-sqlite3 13.0.3 可直接加载，无需在本次手动安装 C++ 编译工具。
- TypeScript 检查及 Vite 生产构建通过。
- 真实 SQLite 的 WAL、外键、操作 ID 唯一约束、事务回滚、旧修订更新拒绝通过；新 Node 进程读取到同一持久资料库 ID。
- SQLite 备份 API 生成的快照可重新打开，完整性检查通过，附件引用指向的实际文件可读取。
- Fastify 公开接口读真实数据库通过；Playwright 驱动本机 Edge 153.0.4234.32 打开生产构建页面，并经 HTTP 获取同一资料库 ID，无页面脚本错误。

原始结果：[result.json](../.scratch/technical-selection/result.json)。这不是登录功能测试、并发压力测试、突然断电恢复、完整备份恢复或手机真机测试；Caddy、WinSW、可信 LAN HTTPS、跨站登录和 PWA 离线仍按对应任务验收。

## 7. #2 剩余实施顺序

1. 建立正式前端、后端、共享契约及数据库迁移结构；数据目录独立配置，锁定并记录运行版本。将服务地址、API、设备凭据与暂存入口放在明确边界内，供后续 Capacitor 接入；本阶段实现网页适配，不要求未具备条件的 iOS 构建。
2. 实现家庭初始化、持久资料库身份、家长登录/退出/恢复，以及儿童设备普通会话。
3. 实现设备列表/撤销、家长短期管理验证与服务端越权拒绝。
4. 让首页从真实本地 API 读取账号/资料库；补公开接口与浏览器测试，验证重启后数据保留、互联网断开时本地可用。
5. 通过 #2 的完整验收后再关闭任务；本选型记录不能替代这些验收。
