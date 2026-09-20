# 工程技能配置确认记录

状态：用户已采用草案并选择 AGENTS.md，配置文件已创建，且已核对与下列草案内容一致。使用 GitHub Issues，目标仓库为 `xianpingduan/klbook`。

生效入口为 [AGENTS.md](../AGENTS.md)，具体约定见 [议题跟踪](agents/issue-tracker.md)、[分类标签](agents/triage-labels.md)和[领域文档](agents/domain.md)。以下内容保留为本次确认快照；后续配置调整直接编辑生效文件。

## 配置情况

- 配置前没有 Git 远程仓库及任务跟踪配置；本次已创建任务跟踪配置，议题操作显式指定目标仓库。
- 用户已提供目标仓库 `https://github.com/xianpingduan/klbook.git`，对应 GitHub Issues 目标为 `xianpingduan/klbook`。2026-09-18 用户提供 GitHub CLI 路径 `E:\Program Files\GitHub CLI\gh.exe`，已验证可运行，版本为 2.101.0；现已验证账号 `xianpingduan` 登录成功，CLI 从系统凭据管理器读取凭据。
- 目标仓库公开可读、已启用 Issues、未归档，账号具有 ADMIN 权限。先前令牌写权限错误已解决，创建标签与发布议题均已成功。
- 2026-09-18 用户明确授权补齐指定证书，并在实际故障终端运行修复脚本，提供了 `TLS_BEFORE=TLS_UNKNOWN_AUTHORITY`、`TLS_AFTER=PASS_TLS_EXPECTED_HTTP_401` 和 `ROOTS_UNCHANGED=True` 的结果。用户终端的证书问题已修复，后续账号登录也已验证。详见[证书故障与修复记录](troubleshooting/github-cli-tls.md)。
- 已有领域词汇表和根目录设计决策记录，沿用单一领域结构。
- 本机已安装 triage 技能；用户已确认保留五个默认标签：needs-triage、needs-info、ready-for-agent、ready-for-human、wontfix。
- 用户已选择创建 AGENTS.md；入口文件已创建，没有另行创建 CLAUDE.md。
- 收集版规格及测试方案已经确认，已发布为 [GitHub Issue #1](https://github.com/xianpingduan/klbook/issues/1)，标签为 ready-for-agent。回读核对通过，正文包含 74 条用户故事和 28 项验收场景。

GitHub Issues、目标仓库、默认标签、入口文件及配置草案均已确认。本地工程技能配置已完成；远程四个缺失的标准标签已创建，原有 wontfix 已复用，五个标准标签均已核验。规格议题已发布。

## AGENTS.md（已采用的草案）

```markdown
## Agent skills

### Issue tracker

创建、读取、发布规格或开发任务时，使用本项目的 GitHub Issues；先读 `docs/agents/issue-tracker.md`。

### Triage labels

分诊或更新任务状态时，使用五个标准标签；先读 `docs/agents/triage-labels.md`。

### Domain docs

本项目使用 single-context；探索业务、编写规格或实施功能前，按 `docs/agents/domain.md` 读取领域词汇和相关设计决定。
```

## docs/agents/issue-tracker.md 草案

```markdown
# Issue tracker: GitHub

本项目的已发布规格与开发任务保存在指定仓库的 GitHub Issues，使用 gh CLI 操作。

目标仓库：`xianpingduan/klbook`。
仓库地址：`https://github.com/xianpingduan/klbook`。

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
```

## docs/agents/triage-labels.md 草案（默认值已确认）

```markdown
# Triage Labels

| Canonical role | 本项目标签 | 含义 |
| --- | --- | --- |
| needs-triage | needs-triage | 等待维护者评估 |
| needs-info | needs-info | 等待补充信息 |
| ready-for-agent | ready-for-agent | 规格已充分明确，可交给代理实施 |
| ready-for-human | ready-for-human | 需要人工实施 |
| wontfix | wontfix | 不予处理 |

技能提到某个标准角色时，使用表中对应的 GitHub 标签；核对仓库中的实际标签并复用，避免创建重复映射。
```

## docs/agents/domain.md 草案

```markdown
# Domain Docs

## Layout

本项目使用 single-context：根目录 `CONTEXT.md` 保存领域词汇，`docs/adr/` 保存相关设计决定。

## Before exploring

- 阅读根目录 `CONTEXT.md`，并阅读 `docs/adr/` 中与当前任务有关的决定。
- 若将来出现 `CONTEXT-MAP.md`，按映射读取相关领域的词汇和局部 ADR，并检查根目录的跨领域 ADR。
- 某项领域文档不存在时直接继续；domain-modeling 在实际形成术语或决定时再创建所需文档。

## Vocabulary and decisions

- 规格、任务、测试名称及设计说明使用领域词汇表中定义的术语。
- 遇到未定义的业务概念时，判断是否需要补充领域模型；由 domain-modeling 处理真实的词汇缺口。
- 方案与既有 ADR 冲突时，明确指出冲突和重新考虑的理由。
```

## 完成后接续

to-spec、to-tickets、triage 等工程技能现在可以读取这些约定。以后可直接编辑 docs/agents 下的配置文件，仅在切换议题跟踪器或重新初始化时才需要重跑 setup。

收集版规格已发布为 [GitHub Issue #1](https://github.com/xianpingduan/klbook/issues/1)，并标记 ready-for-agent；测试方案已经确认，正文与标签回读核对通过。用户随后确认 24 项开发任务拆分，已发布为 GitHub #2—#25，设置并核验 34 条原生前置依赖；见[开发任务索引](development-tickets.md)。当前可以从任务 01／议题 #2 的基础技术方案与本地登录流程开始实施，应用尚未实现。
