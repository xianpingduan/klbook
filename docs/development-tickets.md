# 收集版开发任务索引

发布日期：2026-09-18。状态：用户已确认按当前 24 项发布；24 个开发议题均已发布并回读核验，标签为 ready-for-agent。

父规格：[错题集收集版规格 #1](https://github.com/xianpingduan/klbook/issues/1)。开发任务以 GitHub Issues 中的正文与状态为准。

## 发布与验证结果

- 初次发布的 GitHub 开发议题为 #2—#25，共 24 项、149 条验收标准，设置了 34 条原生前置依赖。
- 初次发布已逐项核对标题、完整正文、标签及依赖，无重复任务；当时父规格正文、标题、状态和标签保持一致。后续用户补充及同步修改见下方记录。
- 方案编号 01—24 与 GitHub 议题编号不同，下表明确列出对应关系。每个议题通过 Parent 引用规格 #1。
- 发布当时尚未实现应用；2026-09-20 已实施 #2 家庭登录和 #3 电脑手动收集。实现与测试证据见[账号验证](verification/issue-2.md)及[收集验证](verification/issue-3.md)。

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

任务 01／议题 #2 在 2026-09-18 完成[基础技术选型](technical-selection.md)，2026-09-20 已完成本地家庭登录、恢复、设备撤销与平台边界，详见[账号验证记录](verification/issue-2.md)。

任务 02／议题 #3 已完成电脑选图、框题、学科确认、草稿继续整理、信息更正、原始页追溯与失败重试；完整 15 个 API 用例、三引擎共 15 个浏览器用例通过，双路审查无未解决项，详见[收集验证记录](verification/issue-3.md)。议题状态以 GitHub 为准。下一条主要用户流程是 [#4 通过局域网拍照和批量相册采集](https://github.com/xianpingduan/klbook/issues/4)。

基础选型包括前后端语言和框架、数据库、附件存储、部署方式及测试工具，并考虑局域网 HTTPS、安卓／苹果浏览器、离线暂存和同步约束。供应商与模型由相应能力任务落实，不把现有技术建议视为已安装或已选定的事实。

2026-09-20，#4 已实现拍照入口、批量相册采集、单张取消及进度恢复，并启动本机 Caddy HTTPS 网关。17 个 API 与 24 个浏览器用例通过，真实 TLS 和旧版暂存升级探针通过，双路审查无未解决代码发现；[验证记录](verification/issue-4.md)与[真机操作清单](lan-capture.md)已提供。防火墙配置已完成；用户确认小米 14、Android 16 的证书安装、登录、拍照收集与电脑找回正常，批量 3 张中取消 1 张、刷新续传后只新增 2 道题，方向正常且手指框题顺畅；取消拍照后改为相册单选、保存和电脑找回也已通过。实际外网断开、局域网正常时，重新登录、查看与收集均经用户确认正常。实际停止服务时，手机准确提示无法连接且材料保留；恢复服务后重试成功，电脑只新增 1 道题。用户补充格式为 JPG：拍照找回、批量处理和取消拍照后相册单选在手机内置浏览器及 Chrome 151.0.7922.71 均通过；断外网、停服及恢复重试仅内置浏览器通过，Chrome 未测试这三项。内置浏览器版本仍待补。相机权限拒绝或入口不可用及其他设备结果仍待补齐，#4 保持开放。

拆分依据和覆盖表见[已确认的拆分方案](../.scratch/collection-v1/proposal.md)；本地另保存了逐项发布正文、发布回执及总核验结果。

## 试用补充需求

2026-09-20 用户要求来源可下拉选择且单独管理，并确认由家长负责新增、改名、停用；已登记 [#27 来源下拉选择与独立管理](https://github.com/xianpingduan/klbook/issues/27)。这是原 24 项之外的明确补充需求，沿用 #3 的收集流程，后续检索任务使用稳定来源身份。实现规则与验证见[来源管理](source-management.md)。

## 界面改造补充

2026-09-22 用户确认两端独立布局及 Demo 整体风格，要求精简重复入口并保留首页鼓励语，随后确认按四项任务发布。正式规格为 [#28](https://github.com/xianpingduan/klbook/issues/28)（[本地规格](spec-ui-separation.md)）；四项开发任务已发布并回读核验，均标记 ready-for-agent：

- [#29 独立入口、真实登录与管理概览](https://github.com/xianpingduan/klbook/issues/29)：无前置，是本轮开始位置。
- [#30 学习端收集、查阅与草稿续接](https://github.com/xianpingduan/klbook/issues/30)：仅依赖 #29。
- [#31 后台资料整理与来源管理](https://github.com/xianpingduan/klbook/issues/31)：仅依赖 #29。
- [#32 后台设备、账号恢复与管理退出](https://github.com/xianpingduan/klbook/issues/32)：仅依赖 #29。

四项均已原生关联父规格 #28，共 36 条验收标准、3 条原生前置依赖，详见[界面改造任务索引](ui-separation-tickets.md)。#29/#31/#32 已完成；#30 的代码、自动化及审查已完成，新版真机仍待验证。整体验收矩阵见 [#32 验证记录](verification/issue-32.md)，父规格 #28 保持开放。原有 24 项和 #4 的真机状态保持不变。

2026-09-23 返回原收集版顺序推进 #5：同一原始页继续收集独立题目、一题追加跨页图片、有序题目区的编辑和原图追溯已实现；22 项 API、三引擎共 102 项浏览器场景及原址升级取得通过结果（完整回归中的失败已修复并定向复验），独立审查与运行记录见 [#5 验证记录](verification/issue-5.md)。后续按顺序为 [#6 共享阅读材料](https://github.com/xianpingduan/klbook/issues/6)，仅依赖 #5；#4/#30 的真机待验继续单独保留。

2026-09-23，#6 已实现共享阅读材料、跨页有序原文、独立小题引用与解除关联保护；24 项 API 与三引擎 108 项浏览器场景均取得通过结果（完整回归中的测试等待问题修正后定向复验通过），本机资料备份升级核验完成。以用户确认的 `c4bb9fb` 为基线，Standards 与 Spec 各 1 项 P2 均已修复，独立复核无未解决项；另修复新建原文漏带刚保存页面的边界。证据见 [#6 验证记录](verification/issue-6.md)。下一项为 [#7 关联纸质答案并允许后补](https://github.com/xianpingduan/klbook/issues/7)，议题状态以 GitHub 为准。

2026-09-23，#7 已实现同页与另页纸质答案后补、有序解答区、共享答案页及解除关联保护；答案选填，原始手写、批改和图形保留。构建、27 项 API 与三引擎 114 项浏览器完整回归全部通过，隔离旧版原址升级及本机备份更新核验完成。以用户确认的 `1d8fac5` 为基线，Standards 初审 2 项（P2/P3）与 Spec 初审 2 项 P2 均已修复，独立复核无未解决项。操作与证据见 [纸质答案](paper-answers.md)及 [#7 验证记录](verification/issue-7.md)。下一项为 [#8 扩展学科并按学习阶段查找](https://github.com/xianpingduan/klbook/issues/8)，仅依赖已完成的 #3；#4/#30 真机待验仍单独保留。

2026-09-23，#8 已实现自定义学科、家庭默认学习阶段、单题归属更正及六类条件组合查找；变更默认值不重写旧题、服务端草稿或已暂存批次。构建与30项API通过，三引擎120项浏览器场景均取得通过结果（完整运行118项通过，设置刷新问题修复后相关18项定向复验通过）。以用户确认的 `1934699` 为基线，Standards 无发现，Spec 初审1项P2已修复并独立复验，无未解决项；隔离旧版原址升级及本机备份更新核验完成。操作与证据见 [学科与学习阶段](study-archive.md)及 [#8 验证记录](verification/issue-8.md)。#9 仍依赖开放的 #4，下一项无开放前置阻塞的任务为 [#10 处理两台设备的修改冲突](https://github.com/xianpingduan/klbook/issues/10)；#4/#30 真机待验继续单独保留，任务实时状态以 GitHub 为准。

2026-09-24，#10 已实现题目、答案、共享原文及关联的版本核对：保留本次编辑或采用当前版本后再保存，期间再次修改仍受修订保护，回执丢失后的重试不重复创建。构建、32项API及累计132项浏览器场景取得通过结果（完整运行和定向复验详情见验证记录）。以用户确认的`2fd8387`为基线，Standards无发现，Spec的2项P2均已修复并独立复核，无未解决项；旧版原址升级、本机备份更新及最终HTTPS入口复查通过。操作与证据见[修改冲突处理](editing-conflicts.md)及[#10验证记录](verification/issue-10.md)。下一项无开放前置阻塞的任务为[#11在客户端配置和测试服务地址](https://github.com/xianpingduan/klbook/issues/11)；#9仍依赖开放的#4，真机待验与移动交付继续单独跟踪，任务实时状态以GitHub为准。

2026-09-24，#11 已实现首次连接、登录前和“我的”中的服务地址设置，无凭据兼容性测试、待连接地址保存及明确登录所选资料库；其他浏览器设置不变。构建、32项API和三引擎141项浏览器完整回归通过，旧版原址升级及真实资料备份核验完成。以用户确认的`b8ab2d7`为基线，Standards初审1项P3建议已修正并独立复核，Spec无发现；相关9项浏览器流程复验通过，无未解决审查项。Windows WebKit合成Cookie探针和Windows Edge家庭证书信任限制单独记录，未把未通过的HTTPS浏览器补测或真机记为通过。操作及证据见[服务地址](service-address.md)和[#11验证记录](verification/issue-11.md)。下一项无开放前置阻塞的任务为[#13配置并测试图片识别服务](https://github.com/xianpingduan/klbook/issues/13)；#9/#12仍等待各自前置完成，实时状态以GitHub为准。

## 后续移动安装与商店发布

2026-09-18 用户补充最终交付 Android APK 和 iOS App Store App，并确认目前没有 Mac/开发者会员、先预留发布方案。已登记 [后续移动交付里程碑 #26](https://github.com/xianpingduan/klbook/issues/26)，标签为 `needs-triage`；它是后续范围跟踪，尚未细拆为可直接执行的开发任务。

- 前端方向扩展为 React + TypeScript + Vite + Capacitor，具体边界和资源见 [移动交付计划](mobile-delivery.md)。
- #1 已记录最终移动交付目标与当前网页里程碑的区别；#2 增加一条平台边界验收，当前 24 项合计 150 条验收标准，原有 34 条原生依赖不变。
- #25 仍负责网页收集的家庭验收；它完成不表示 APK/App Store 发布完成。#26 没有被设置为当前基础开发的阻塞。
- 移动补充时 #2 仅完成选型；2026-09-20 已实现平台边界和网页登录。移动端仍未安装依赖、打包或真机验证，也未执行购买、开户或商店提交。
- 初次批准的拆分方案和发布回执保留为历史记录；新一轮变更回读存于 `.scratch/mobile-delivery/`。

2026-09-20 完整性检查：24 项的 34 条原生依赖与正文一致、无循环，原有用户故事和验收场景均有实施任务引用；修正了 #1 的过时选型说明，并在 #26 补充完整移动收集和资料包流转验收。移动端独立验收场景及可执行任务仍待细拆，见 [Spec 与 tickets 检查记录](spec-tickets-review.md)。
