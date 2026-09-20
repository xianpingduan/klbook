# Issue tracker: GitHub

本项目的已发布规格与开发任务保存在指定仓库的 GitHub Issues，使用 gh CLI 操作。

目标仓库：`xianpingduan/klbook`。
仓库地址：`https://github.com/xianpingduan/klbook`。

本机 GitHub CLI 位于 `E:\Program Files\GitHub CLI\gh.exe`。未加入 PATH 时，在 PowerShell 中通过 `& 'E:\Program Files\GitHub CLI\gh.exe'` 调用下述 gh 命令。

## Conventions

- gh 议题命令显式指定 `--repo xianpingduan/klbook`，以本配置记录的目标为准。
- 创建议题使用 `gh issue create`。规格和评论等多行正文先保存为 UTF-8 文件，再通过 `--body-file` 提交，保留实际换行。
- 阅读议题使用 `gh issue view <number> --comments`，同时获取正文和标签。
- 列出议题使用 `gh issue list`，按需要过滤状态及标签，并读取编号、标题、正文、标签与评论。
- 评论使用 `gh issue comment <number> --body-file <正文文件>`。
- 修改分类使用 `gh issue edit <number> --add-label` 或 `--remove-label`；标签映射见 `docs/agents/triage-labels.md`。
- 关闭议题使用 `gh issue close <number>`；需要解释时先提交评论。

## Pull requests as a triage surface

PRs as a request surface: no.

GitHub 议题与 PR 共享编号空间。只有编号且对象类型不明时，先确认其类型，再使用对应 issue 或 pr 命令。

## Publish and fetch

- 技能要求“发布到议题跟踪器”时，在指定仓库创建 GitHub issue，发布后记录实际议题链接。
- 技能要求“应用标签”时，使用分类标签映射更新该议题。
- 技能要求“获取相关任务”时，读取指定仓库内的议题及评论。

## Wayfinding operations

- 决策地图使用一个带 `wayfinder:map` 标签的议题，包含 Notes、Decisions-so-far 和 Fog。
- 子任务使用 GitHub sub-issue 关联到地图，并标记 `wayfinder:research`、`wayfinder:prototype`、`wayfinder:grilling` 或 `wayfinder:task`；不可用时，改用地图任务列表和子任务中的 `Part of #<map>`。
- 阻塞关系优先使用 GitHub 原生议题依赖；传递议题的数据库 id，不将显示编号当作数据库 id。不可用时记录 `Blocked by: #<n>`。
- 按地图顺序选择开放、无开放阻塞且未分配的子任务；开始前先分配给负责开发者。
- 解决后先评论答案，再关闭子任务，最后将摘要和链接追加到地图的 Decisions-so-far。
