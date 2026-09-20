# 浏览器、离线与 Windows 局域网约束

核对日期：2026-09-18。用途：基础技术选型的浏览器与部署依据；本文件是调研建议，不代替已接受的 ADR。范围为单家庭、单学习者，Windows 11 主机与 Android、iPhone、iPad、桌面浏览器。下文将官网事实与本项目建议分开。

同日用户补充 APK/App Store 目标后，浏览器约束仍适用于网页端；Capacitor App 的本地页面、原生存储、权限和网络路径另见 [移动交付计划](../mobile-delivery.md)，不能用浏览器通过替代安装包验证。

## 结论

建议采用 React + Vite + TypeScript 响应式网页，保留稳定的 HTTPS 网页来源，客户端单独配置 HTTPS 服务地址；后续用 Service Worker 缓存应用外壳，IndexedDB 暂存原始页和待同步操作。跨任意局域网主机/IP 的鉴权采用显式设备会话令牌，不以跨站 Cookie 为前提。家庭常用部署可由 Caddy 托管静态网页并代理同源 API，但客户端仍须覆盖配置其他服务地址的路径。

Windows 常驻部署建议使用自动启动的 Windows 服务。Docker Desktop 可用于开发，但其“登录时启动”设置不能证明“重启后无人登录即可访问”。这些建议的依据和边界如下。

## 1. 网页来源与服务地址必须分别管理

**事实。** IndexedDB 遵循同源策略；Service Worker 也按来源和路径注册。因此改变网页来源会改变可访问的本地存储与离线控制范围。[MDN IndexedDB](https://developer.mozilla.org/en-US/docs/Web/API/IndexedDB_API)、[MDN Service Worker](https://developer.mozilla.org/en-US/docs/Web/API/Service_Worker_API)

**建议。** 长期固定打开网页的协议、主机名和端口，优先固定局域网名称；电脑 IP 变化由名称解析处理。修改客户端服务地址只改变 API 目标，不跳转网页、不重建前端来源。若网页自身换来源，必须另做旧来源导出/迁移；不能承诺自动读取旧 IndexedDB。手机的 `localhost` 是手机自身，不能作为 Windows 主机地址。

资料库使用持久 `libraryId`，不以 IP 或 URL 标识。草稿、原始页 Blob、待同步操作与已同步缓存均按 `libraryId` 隔离；服务地址是当前连接配置。地址变化时先暂停上传，再认证、核对资料库身份，同库才恢复队列，异库保留旧队列并切换隔离空间。

## 2. 动态服务地址的鉴权

### 官网约束

- `HttpOnly` 阻止 JavaScript 直接读取 Cookie；它不授予跨站访问能力。跨站 Cookie 的 `SameSite=None` 需要 `Secure`，Cookie 的域也不能随意覆盖无关主机或其他 IP。[MDN Set-Cookie](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Set-Cookie)
- Safari 默认阻止第三方 Cookie。跨站 API 即使设置 `SameSite=None; Secure` 并正确配置 CORS，也不能保证 Cookie 被接受或发送。[WebKit 第三方 Cookie 策略](https://webkit.org/blog/10218/full-third-party-cookie-blocking-and-more/)
- CORS 是浏览器对跨来源访问的许可机制，不是登录。带 `Authorization` 的跨来源请求需要预检；预检不应依赖登录凭证；使用 Cookie 凭证时必须返回明确来源而非 `*`，且第三方 Cookie 策略仍然有效。[MDN CORS](https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/CORS)

### 本项目建议

1. **统一 API 客户端**：对用户确认的 HTTPS 服务地址显式发送 `Authorization: Bearer …`，不用第三方 Cookie 维持会话。后端保存可撤销、可过期的设备会话；具体令牌格式不必采用 JWT。
2. **凭证范围**：凭证与资料库、已确认的服务地址关联。新地址的首次探测不附旧令牌；在可信 TLS 连接上重新登录或完成由主机确认的配对，取得新会话，并从认证响应核对 `libraryId` 后才续传。未认证接口返回相同 UUID 只能用于提示，不能作为身份真实性证明。若以后需要无感换址，再设计可验证的资料库身份连续性协议。
3. **离线重开**：离线读取本机草稿不要求远程登录成功；上传前必须恢复有效会话。短期访问令牌宜留在内存；若提供“记住此设备”，持久设备凭证放在固定网页来源并支持撤销、轮换与过期。此类凭证仍可被同源脚本读取，需要严格脚本来源、避免不可信 HTML 和令牌日志；它没有 HttpOnly 的脚本隔离属性。
4. **服务端边界**：CORS 精确允许部署时配置的网页来源，允许实际使用的方法以及 `Authorization`、必要内容类型和幂等请求头，正确处理 `OPTIONS`；正常响应和错误响应都带相应 CORS 头。服务端对业务请求独立鉴权，不能只检查 `Origin`。
5. **受保护图片**：统一用鉴权请求取得 Blob，再生成临时显示 URL；不把令牌拼进图片 URL，也不假定普通 `<img src>` 会附自定义 Authorization。登录响应和凭证不进入离线响应缓存。

同源部署可以使用 HttpOnly Cookie，但将它作为唯一机制会使“固定网页连接其他局域网主机/IP”的要求无法普遍成立；本任务不建议同时维护两套主登录机制。

## 3. HTTPS、证书与局域网权限

**事实。** Service Worker 需要安全上下文；本机 `http://localhost` 的开发例外不等于任意 `http://192.168.x.x` 也安全。HTTPS 网页访问 HTTP API 通常受到 mixed content 阻止。[MDN 安全上下文](https://developer.mozilla.org/en-US/docs/Web/Security/Defenses/Secure_Contexts)、[MDN Mixed content](https://developer.mozilla.org/en-US/docs/Web/Security/Defenses/Mixed_content)

**事实。** Chrome 142 对公网网页访问本地网络/回环地址、局域网页访问回环地址引入安全上下文中的权限提示；获准后的部分 HTTP 例外是 Chrome 特定行为，不是跨浏览器部署依据。新的 Local Network Access 取代此前暂停的 Private Network Access 方案；不要把旧 `Access-Control-Allow-Private-Network` 响应头当成普遍解决办法。[Chrome 142 发布说明](https://developer.chrome.com/release-notes/142)、[Chrome LNA 说明](https://developer.chrome.com/blog/local-network-access)

**事实。** Caddy 能为本地域名/IP 使用本地 CA 签发证书；自动安装根证书并不保证成功，客户端设备仍需信任其根证书。iOS/iPadOS 手动安装证书描述文件后，还需在证书信任设置中启用 SSL/TLS 完全信任。[Caddy 自动 HTTPS](https://caddyserver.com/docs/automatic-https)、[Apple 手动信任证书](https://support.apple.com/en-us/102390)

**建议。** 前端与每个 API 地址均使用设备实际信任、名称匹配的 HTTPS；证书信任、名称解析和 Windows 防火墙是部署步骤。首次连接由前台页面触发，便于显示权限提示。将“权限被拒绝”“证书/网络不可达”“登录失效”作为不同恢复路径；Fetch 的普通网络错误可能不能直接区分前两者，因此提供连接检查而非断言原因。LNA 行为以目标浏览器实机为准，不把 Chrome 的权限 API 或放宽规则套用到 Safari。

## 4. 离线可承诺的范围

**事实。** Service Worker 安装和缓存资源需要首次访问；IndexedDB 能存储文件/Blob。Background Sync 仍是兼容性有限的能力，不能作为全平台可靠补传的基础。[MDN Service Worker](https://developer.mozilla.org/en-US/docs/Web/API/Service_Worker_API)、[MDN IndexedDB](https://developer.mozilla.org/en-US/docs/Web/API/IndexedDB_API)、[MDN Background Sync](https://developer.mozilla.org/en-US/docs/Web/API/Background_Synchronization_API)

**事实。** WebKit 的网站存储受配额、磁盘压力和清理策略影响；`persist()` 可以申请持久模式，但批准取决于浏览器，空间不足仍需处理。`navigator.onLine` 只是连接提示，不能证明家庭资料库可达。[WebKit 存储策略](https://webkit.org/blog/14403/updates-to-storage-policy/)、[MDN onLine](https://developer.mozilla.org/en-US/docs/Web/API/Navigator/onLine)

**建议。** 承诺“在线完成准备后，能离线重开、暂存，联网打开时补传”；准备完成应检查应用外壳缓存和 Service Worker 激活。离线首次访问、浏览器清理数据后重开，以及后台/锁屏持续传图不在此承诺内。应用打开、回到前台、收到在线提示和用户点击重试时，实际探测目标 API 并恢复队列；Background Sync 仅作可选增强。

本机暂存成功和后端确认持久化分开记录，只有后者显示“已同步”。图片与操作记录先原子暂存，补传使用稳定幂等键；未知响应结果可以重试。处理配额不足、认证过期和图片上传中断，保留未确认材料；申请持久存储并提供剩余空间提示，不能把 IndexedDB 当成永久备份。

## 5. 拍照、相册与图片格式

**事实。** 文件输入的 `accept` 只是选择提示，不能替代服务端验证；`capture="environment"` 可表达后置拍照意图，但可用性与交互因浏览器而异。若使用实时相机 `getUserMedia()`，还要求安全上下文和用户许可。[MDN 文件输入](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/input/file)、[MDN capture](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Attributes/capture)、[MDN getUserMedia](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia)

**事实。** Safari 17 增加了 HEIC 支持；这不足以证明所有 Android/桌面浏览器均能解码苹果相册原件。JPEG、PNG 等有更广泛的浏览器支持。[WebKit Safari 17 图片格式](https://webkit.org/blog/14445/webkit-features-in-safari-17-0/#heic)、[MDN 图片格式](https://developer.mozilla.org/en-US/docs/Web/Media/Guides/Formats/Image_types)

**建议。** 提供“拍照”和“从相册选择”两个入口，保留普通文件选择退路。首轮验收覆盖 JPEG、PNG、WebP 及 iPhone 相册实际交付的 HEIC/HEIF；选择器可能给出转换结果，不能假定总是原生 HEIC 或总是 JPEG。按 ADR 0001 保留应用实际接收的原始字节，另生成通用预览/题目派生图；不要以压缩后的预览替换原始页。HEIC 无法本机解码时可先保留草稿，联网由后端转预览，明确显示当前不可预览。另验收旋转方向、超大像素图与格式/扩展名不符；图片编解码库选型仍需验证 Windows 支持。

## 6. Windows 主机的运行方式

| 官网事实 | 对选型的影响 |
| --- | --- |
| Windows 服务控制管理器在系统启动时启动自动服务及其依赖。[Microsoft](https://learn.microsoft.com/en-us/windows/win32/services/automatically-starting-services) | “开机后尚未登录即可使用”应由真正的自动服务实现，并安排网络就绪重试、进程恢复和日志。 |
| Caddy 官方支持用 `sc.exe` 或 WinSW 作为 Windows 服务运行。[Caddy 运行指南](https://caddyserver.com/docs/running) | 静态网页与 HTTPS 入口可常驻；Node/Python 后端也需要对应的服务包装，不能仅把普通程序路径注册成兼容服务。 |
| Docker Desktop 的设置是用户登录时自动启动；`com.docker.service` 是权限辅助服务，不能仅凭它存在证明 Linux 容器已经可用。[Docker 设置](https://docs.docker.com/desktop/settings-and-maintenance/settings/)、[Docker Windows 权限](https://docs.docker.com/desktop/setup/install/windows-permission-requirements/) | Docker Desktop 已安装不等于守护进程可用，更不等于开机未登录即可提供本项目服务；只有明确接受登录后可用时，才把这种部署作为家庭使用前提。 |

**建议。** Windows 原生后端 + Caddy 服务作为轻量部署方向，开发工具和运行服务分开管理。采用固定绝对数据目录与明确服务账户权限，前端静态产物由 Caddy 提供，API 仅监听回环并由 Caddy 代理。安装后分别验证“重启未登录”“登录后”“退出终端”三种状态；电脑关机、睡眠或网络不可达时，客户端进入本机暂存流程。此次仅调研，未安装或更改服务。

## 7. React + Vite + TypeScript 的适用性与后续验证

**事实。** React 官方给出 Vite 的 `react-ts` 路径，并明确构建工具方案还需要自行安排路由、数据获取等能力；Vite 生产构建可部署为静态网站，`vite preview` 不用于生产服务。Vite PWA 项目提供 manifest 与 Service Worker 集成，但不能代替业务同步协议。[React 官方](https://react.dev/learn/build-a-react-app-from-scratch)、[Vite 静态部署](https://vite.dev/guide/static-deploy)、[Vite PWA 文档](https://vite-pwa-org.netlify.app/guide/)

**建议。** 当前家庭工具无需为 SEO 或服务端渲染引入额外框架；React + Vite + TypeScript 能承载上述需求。本任务先保留 API 客户端、设备配置、资料库身份和本地队列边界，PWA 插件及完整离线流程在后续任务实现；版本应根据本机 Node 与最终依赖的兼容条件锁定，此调研不强制版本。

实现前的最小验证范围：真实 iPhone/iPad Safari、Android Chrome、Windows Edge/Chrome，覆盖默认隐私设置下跨主机登录、证书信任、局域网权限拒绝/恢复、离线关闭重开、联网前台补传、同库换地址重新认证续传、异库不串传、HEIC 采集，以及主机重启后的服务状态。官方能力说明不替代这些端到端验证。
