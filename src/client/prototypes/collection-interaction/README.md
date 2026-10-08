# 收集交互预览（可丢弃）

问题：如何在沿用现有学习端风格时，减少收集流程的按钮和选填内容，同时保持主要操作直接可达？

在独立分支 `codex/collection-interaction-demo` 中，沿用项目现有 `/prototype/<name>/` 演示路由。自动保留编辑进度尚未实现，本次包含模拟保存、取消和继续收集，因此使用隔离的静态预览，不连接正式页面的写入操作。正式应用仍位于 8787。

在本工作区运行 `npm run prototype:collection`，访问 http://127.0.0.1:8788/prototype/collection-interaction/?variant=A&step=confirm&size=phone 。无须安装中间件或数据库。

- A：分步精简（推荐）——原有两步，图片与学科优先，补充内容折叠，底部固定下一步/保存。
- B：图片优先——大图常驻，学科与保存集中在底部面板，附加信息用抽屉。
- C：一页收集——框题、学科、保存并列在同一页；减少一次步骤跳转，但同屏操作更多。

通过底部左右箭头或键盘方向键切换 `variant=A|B|C`；输入框内不拦截方向键。侧边流程导航切换 `step=collect|crop|confirm|detail`；顶部切换 `size=phone|tablet|desktop`。全部状态仅在内存中，刷新重置。

可以演示选图、拖动框选、换图、选学科、展开补充内容、保存、返回续接、取消和撤销。拍照、相册、同步、OCR 均为模拟；示例图片是代码生成的虚构材料，没有使用家庭资料。

2026-10-08，用户选择 **A：分步精简**，确认保留两步流程、折叠选填内容与底部固定主要操作，并在 Q4 回复「按推荐」，确认一并实现自动保留草稿。自动保留不等于完成收集，仍需点击「保存到错题集」。完整 A/B/C 原型保存在提交 `ea22317`。正式设计选择记录于主工作区 `docs/design/collection-interaction.md`；[#9](https://github.com/xianpingduan/klbook/issues/9) 承接自动草稿与断网恢复基础，[#34](https://github.com/xianpingduan/klbook/issues/34) 跟踪 A 布局集成。原型不作为生产代码直接合并，预览中的持久化与同步仍是模拟。
