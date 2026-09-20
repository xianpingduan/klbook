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
