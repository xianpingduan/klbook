# Android APK 与 iOS App Store 交付约束

核对日期：2026-09-18。交付目标：Android 可安装 APK，iOS 可从 App Store 下载。仅核对 Apple、Android 官方资料；账号购买、发布地区、公开或非公开分发均未代用户决定。本文区分平台规则与项目建议，不代表审核已通过。

## 1. Apple 账号与构建条件

| 已核实的规则/事实 | 对项目的影响 |
| --- | --- |
| App Store 分发需要 Apple Developer Program；标准会员为 99 USD/年，地区价格以注册时当地币种为准。[会员选择](https://developer.apple.com/support/compare-memberships/)、[注册费用](https://developer.apple.com/help/account/membership/program-enrollment) | 发布前确认账号主体与预算；此调研不执行开户或付款。 |
| Apple 当前列出的提交最低要求自 2026-04-28 生效：Xcode 26 或更新版本，使用 iOS/iPadOS 26 SDK 或更新版本构建。[提交要求](https://developer.apple.com/news/upcoming-requirements/) | 这是提交 SDK 下限，不是用户设备必须安装 iOS 26；最低运行版本另定。不要把最新测试版或未经宣布的未来 SDK 当成强制条件。 |
| Xcode 系统要求表仅列 macOS；例如 Xcode 26 对应 macOS Sequoia 15.6 起的指定范围，更新 Xcode 的要求可能更高。[Xcode 兼容表](https://developer.apple.com/xcode/system-requirements) | 需要可使用的 Mac/macOS 构建环境（自有或授权远程环境）及匹配的 Xcode；现有 Windows 主机不能独立完成标准 Xcode 构建。具体组合在打包时复核。 |

## 2. 本地局域网后端如何接受审核

**规则。** 4.2 要求超出网站套壳的实际价值；2.1 要求完整审核。因法律/安全义务用内置演示替代账号，须获 Apple 事先批准且展示完整功能。[审核指南 4.2 / 2.1](https://developer.apple.com/app-store/review/guidelines/)

**官方补充。** 审核信息应包含演示账号、特殊配置说明；难以复现的环境或专用硬件应准备演示视频或硬件。[Apple 审核准备说明](https://developer.apple.com/app-store/review/)

**项目建议。** 将可运行的客户端功能随包交付，让拍照/相册采集、本机草稿、题目区调整和查找形成真实流程，继续遵守当前收集范围。单纯显示远程网页、首屏只要求填写家庭服务地址，会增加最低功能和完整访问风险；使用 WebView 或跨端技术本身不能推导出必然通过或必然被拒。

建议随包提供**明确标记、可重置、与真实家庭资料库隔离的合成示例库**，让审核员不接入家庭 LAN 也能体验主要流程。外部识别的预置结果必须标明示例，不能假装实时调用。LAN 同步另准备安装/配对说明和真实设备演示，向 App Review 说明依赖；若以演示模式替代账号，按适用规则先取得认可。示例库和录屏是本项目的审核方案建议，不能代替平台要求的完整访问，也不构成必须暴露家庭服务到公网的要求。

## 3. 儿童受众、Kids Category 与 OCR 隐私

### 分类和真实受众分别判断

**事实。** 年龄分级是必填信息；Kids Category 则通过 Made for Kids 和年龄段单独选择，获批后不能随意撤销其持续要求。面向四年级学习者不等于已经选择该商店分类，也不能仅凭目标年级确定内容分级。[年龄分级与 Made for Kids](https://developer.apple.com/help/app-store-connect/manage-app-information/set-an-app-age-rating)

**规则。** 5.1.4 对实际涉及未成年人信息的应用仍适用；非 Kids 元数据不得暗示主要儿童受众，家长门槛不等于数据同意。[审核指南 5.1.4](https://developer.apple.com/app-store/review/guidelines/#kids)

**需确认的边界。** 1.3 禁止 Kids 向第三方发送个人可识别或设备信息；儿童总览却提到家长明确同意例外。发布前向 Apple 确认第三方 OCR 的适用方式，不能仅加同意框就承诺符合 Kids 要求。[审核指南 1.3](https://developer.apple.com/app-store/review/guidelines/#kids-category)、[Apple 儿童体验说明](https://developer.apple.com/kids/)

### 披露必须按真实数据流填写

**规则。** 分享个人数据至第三方（包括第三方 AI）前，需要清楚披露去向并取得明确许可。[审核指南 5.1.2](https://developer.apple.com/app-store/review/guidelines/#data-use-and-sharing)

**事实。** App Privacy 标签中的“收集”有专门定义：开发者或第三方可访问离开设备的数据，且保留超过实时请求所需时间。只在设备处理的数据不属于该定义；即时处理后丢弃可能免于标签申报，但这不取消其他许可义务。照片上传功能涉及相应图片数据类型，功能可选也不当然免填。[Apple App Privacy 说明](https://developer.apple.com/app-store/app-privacy-details/)

**项目建议。** 分别记录“手机本机”“用户自管的家庭资料库”“第三方图片识别服务”的接收者、数据种类、用途、保留和删除方式。家庭 LAN 不是手机本机；是否构成开发者/供应商收集，要核实谁能访问及保留，不能直接填“全部收集”或“完全不收集”。保留可独立关闭的图片识别开关；发送前由家长看清接收供应商、发送内容与用途，避免将含姓名、学校、面孔的整页无条件外传。App 内和商店需有可访问的隐私说明，系统相册授权也不等于同意外部 OCR。

## 4. 中国大陆商店区域：发布前待核实

**Apple 官方说明。** 中国大陆可用性可能要求 ICP 备案信息；适用时备案号与 App 元数据须匹配并接受验证。Apple 另列游戏、书报、宗教、新闻等内容的专项证明要求。[App 信息：中国大陆可用性](https://developer.apple.com/cn/help/app-store-connect/reference/app-information/app-information)

**本项目边界。** 此处只列发布检查项，不认定本地家庭工具自动豁免备案，也不把“错题集”名称等同于书报出版类资质。确定实际分发地区、发布主体和功能内容后，再按 Apple 当时界面及官方渠道确认所需材料；不能将“任意区域已上架”视为“中国大陆区域可下载”。

## 5. Android：签名 APK 与更新连续性

**规则。** APK 安装与更新前必须签名；正常覆盖更新需要保持签名身份连续。自管发布密钥丢失会影响为已安装应用继续发布更新。[Android 应用签名](https://developer.android.com/studio/publish/app-signing)

**事实与建议。** Android 官方明确签名后的 APK 可以直接分发给用户。当前按用户要求交付 release APK，固定应用标识和发布签名，安全备份 keystore 与密码并验证覆盖升级；不把调试签名当长期交付签名。Google Play 的 AAB/Play App Signing 属于另一个分发选择，不是“可安装 APK”自动附带的要求。[Android 发布准备](https://developer.android.com/studio/publish/preparing)

## 前置决策与风险建议

1. **构建与账号**：确认可用的 Mac/Xcode 环境、Apple 账号主体与年度费用负责人，再安排 iOS 打包验证。
2. **审核体验**：将合成示例库和脱离家庭 LAN 的完整体验纳入移动发布版本的候选方案；提前确认演示替代账号的审核安排。
3. **儿童定位与识别**：一起确定商店元数据、Kids 分类、第三方 OCR 数据边界；不可通过分类选择掩盖真实受众。
4. **地区与方式**：确认目标 App Store 地区，以及公开或其他可用分发方式；中国大陆材料要求随后针对性核实。
5. **密钥保管**：在首个长期使用 APK 前确定签名密钥保管和恢复责任，验证新版本能保留资料并覆盖升级。
