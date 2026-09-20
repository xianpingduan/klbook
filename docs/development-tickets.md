# 收集版开发任务索引

发布日期：2026-09-18。状态：用户已确认按当前 24 项发布；24 个开发议题均已发布并回读核验，标签为 ready-for-agent。

父规格：[错题集收集版规格 #1](https://github.com/xianpingduan/klbook/issues/1)。开发任务以 GitHub Issues 中的正文与状态为准。

## 发布与验证结果

- 初次发布的 GitHub 开发议题为 #2—#25，共 24 项、149 条验收标准，设置了 34 条原生前置依赖。
- 初次发布已逐项核对标题、完整正文、标签及依赖，无重复任务；当时父规格正文、标题、状态和标签保持一致。后续用户补充及同步修改见下方记录。
- 方案编号 01—24 与 GitHub 议题编号不同，下表明确列出对应关系。每个议题通过 Parent 引用规格 #1。
- 本轮完成任务发布，应用尚未实现，验收清单尚未作为应用测试执行。

## 任务与前置依赖

| 方案编号 | GitHub 开发任务 | 前置议题 |
| --- | --- | --- |
| 01 | [#2 确定基础技术方案并跑通本地家庭登录](https://github.com/xianpingduan/klbook/issues/2) | 无，可立即开始 |
| 02 | [#3 手动收集并找回一道错题](https://github.com/xianpingduan/klbook/issues/3) | [#2](https://github.com/xianpingduan/klbook/issues/2) |
| 03 | [#4 通过局域网拍照和批量相册采集](https://github.com/xianpingduan/klbook/issues/4) | [#3](https://github.com/xianpingduan/klbook/issues/3) |
| 04 | [#5 一页收集多题与跨页排序](https://github.com/xianpingduan/klbook/issues/5) | [#3](https://github.com/xianpingduan/klbook/issues/3) |
| 05 | [#6 让多个小题共享阅读材料](https://github.com/xianpingduan/klbook/issues/6) | [#5](https://github.com/xianpingduan/klbook/issues/5) |
| 06 | [#7 关联纸质答案并允许后补](https://github.com/xianpingduan/klbook/issues/7) | [#3](https://github.com/xianpingduan/klbook/issues/3) |
| 07 | [#8 扩展学科并按学习阶段查找](https://github.com/xianpingduan/klbook/issues/8) | [#3](https://github.com/xianpingduan/klbook/issues/3) |
| 08 | [#9 断网暂存、重开与补传](https://github.com/xianpingduan/klbook/issues/9) | [#4](https://github.com/xianpingduan/klbook/issues/4)、[#8](https://github.com/xianpingduan/klbook/issues/8) |
| 09 | [#10 处理两台设备的修改冲突](https://github.com/xianpingduan/klbook/issues/10) | [#3](https://github.com/xianpingduan/klbook/issues/3) |
| 10 | [#11 在客户端配置和测试服务地址](https://github.com/xianpingduan/klbook/issues/11) | [#3](https://github.com/xianpingduan/klbook/issues/3) |
| 11 | [#12 切换服务时保护凭据和未同步资料](https://github.com/xianpingduan/klbook/issues/12) | [#9](https://github.com/xianpingduan/klbook/issues/9)、[#11](https://github.com/xianpingduan/klbook/issues/11) |
| 12 | [#13 配置并测试图片识别服务](https://github.com/xianpingduan/klbook/issues/13) | [#2](https://github.com/xianpingduan/klbook/issues/2) |
| 13 | [#14 用识别建议辅助选题和更正文字](https://github.com/xianpingduan/klbook/issues/14) | [#5](https://github.com/xianpingduan/klbook/issues/5)、[#13](https://github.com/xianpingduan/klbook/issues/13) |
| 14 | [#15 配置并测试语音转写服务](https://github.com/xianpingduan/klbook/issues/15) | [#13](https://github.com/xianpingduan/klbook/issues/13) |
| 15 | [#16 配置并测试 AI 学习服务](https://github.com/xianpingduan/klbook/issues/16) | [#13](https://github.com/xianpingduan/klbook/issues/13) |
| 16 | [#17 统一查看三类服务用量并限制预算](https://github.com/xianpingduan/klbook/issues/17) | [#15](https://github.com/xianpingduan/klbook/issues/15)、[#16](https://github.com/xianpingduan/klbook/issues/16) |
| 17 | [#18 回收站恢复及共享材料保护](https://github.com/xianpingduan/klbook/issues/18) | [#6](https://github.com/xianpingduan/klbook/issues/6)、[#7](https://github.com/xianpingduan/klbook/issues/7)、[#9](https://github.com/xianpingduan/klbook/issues/9)、[#10](https://github.com/xianpingduan/klbook/issues/10) |
| 18 | [#19 导出完整学习资料包](https://github.com/xianpingduan/klbook/issues/19) | [#14](https://github.com/xianpingduan/klbook/issues/14)、[#18](https://github.com/xianpingduan/klbook/issues/18) |
| 19 | [#20 校验预览并完整导入资料包](https://github.com/xianpingduan/klbook/issues/20) | [#19](https://github.com/xianpingduan/klbook/issues/19) |
| 20 | [#21 处理导入冲突、重复与学科对应](https://github.com/xianpingduan/klbook/issues/21) | [#20](https://github.com/xianpingduan/klbook/issues/20) |
| 21 | [#22 开机自动运行并提供电脑维护入口](https://github.com/xianpingduan/klbook/issues/22) | [#4](https://github.com/xianpingduan/klbook/issues/4) |
| 22 | [#23 生成并验证完整资料库备份](https://github.com/xianpingduan/klbook/issues/23) | [#17](https://github.com/xianpingduan/klbook/issues/17)、[#21](https://github.com/xianpingduan/klbook/issues/21) |
| 23 | [#24 每日变化备份、启动补做与保留七份](https://github.com/xianpingduan/klbook/issues/24) | [#22](https://github.com/xianpingduan/klbook/issues/22)、[#23](https://github.com/xianpingduan/klbook/issues/23) |
| 24 | [#25 完成家庭安装交付与四科真机验收](https://github.com/xianpingduan/klbook/issues/25) | [#12](https://github.com/xianpingduan/klbook/issues/12)、[#24](https://github.com/xianpingduan/klbook/issues/24) |

## 开始位置与技术选型

当前正在执行：[任务 01／议题 #2：确定基础技术方案并跑通本地家庭登录](https://github.com/xianpingduan/klbook/issues/2)。2026-09-18 已分配给 xianpingduan，完成 [基础技术选型](technical-selection.md) 与临时兼容性验证；下一步完成可验证的家庭登录流程。#2 保持开放，其他任务在各自前置议题完成后推进。

基础选型包括前后端语言和框架、数据库、附件存储、部署方式及测试工具，并考虑局域网 HTTPS、安卓／苹果浏览器、离线暂存和同步约束。供应商与模型由相应能力任务落实，不把现有技术建议视为已安装或已选定的事实。

拆分依据和覆盖表见[已确认的拆分方案](../.scratch/collection-v1/proposal.md)；本地另保存了逐项发布正文、发布回执及总核验结果。

## 后续移动安装与商店发布

2026-09-18 用户补充最终交付 Android APK 和 iOS App Store App，并确认目前没有 Mac/开发者会员、先预留发布方案。已登记 [后续移动交付里程碑 #26](https://github.com/xianpingduan/klbook/issues/26)，标签为 `needs-triage`；它是后续范围跟踪，尚未细拆为可直接执行的开发任务。

- 前端方向扩展为 React + TypeScript + Vite + Capacitor，具体边界和资源见 [移动交付计划](mobile-delivery.md)。
- #1 已记录最终移动交付目标与当前网页里程碑的区别；#2 增加一条平台边界验收，当前 24 项合计 150 条验收标准，原有 34 条原生依赖不变。
- #25 仍负责网页收集的家庭验收；它完成不表示 APK/App Store 发布完成。#26 没有被设置为当前基础开发的阻塞。
- #2 原有选型两项完成；新增平台边界及其余登录验收待实施。移动端尚未安装依赖、打包或真机验证，本次也未执行购买、开户或商店提交。
- 初次批准的拆分方案和发布回执保留为历史记录；新一轮变更回读存于 `.scratch/mobile-delivery/`。

2026-09-20 完整性检查：24 项的 34 条原生依赖与正文一致、无循环，原有用户故事和验收场景均有实施任务引用；修正了 #1 的过时选型说明，并在 #26 补充完整移动收集和资料包流转验收。移动端独立验收场景及可执行任务仍待细拆，见 [Spec 与 tickets 检查记录](spec-tickets-review.md)。
