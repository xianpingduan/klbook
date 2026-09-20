# 共享 React 界面并用 Capacitor 交付移动安装包

用户在基础选型后明确最终需要 Android APK 和 iOS App Store 下载，并确认目前无 Mac/开发者会员、先预留发布方案，因此保留 React + TypeScript + Vite，新增 Capacitor 作为移动端运行方案，共享界面并为相机、设备存储、凭据和传输提供平台适配。相比 Flutter/React Native 的另一套界面，接受 WebView、原生插件、签名和双平台验证的维护成本，以保留现有电脑网页和收集流程的复用。

正式 App 随包携带页面，客户端服务地址只配置数据 API；移动暂存和凭据使用相应原生存储能力，不能将网页缓存假设直接套入 App。当前 24 项仍推进网页收集里程碑，移动构建与发布单独跟踪；技术方案见 [移动交付计划](../mobile-delivery.md)，现有网页登录策略见 [ADR 0003](0003-explicit-device-sessions.md)。
