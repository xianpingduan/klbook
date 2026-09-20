# GitHub CLI 证书链故障

检查日期：2026-09-18。状态：用户已在实际故障终端运行修复脚本，证书补齐及真实登录路径的 HTTPS 复测通过；证书故障已解决，账号 xianpingduan 登录也已验证。后续令牌权限问题也已解决，规格已成功发布，见文末。

## 已确认的原因

- GitHub CLI：`E:\Program Files\GitHub CLI\gh.exe`，版本 2.101.0。
- 使用明确无效的测试令牌请求 GitHub API，连续两次在 HTTPS 层失败：`x509: certificate signed by unknown authority`。这不能用于判断用户真实令牌是否有效。
- GitHub 返回正常的 Sectigo 证书链。使用现有 Git CA bundle 校验两个域名均成功；Windows 的链验证均失败，错误是不能建立到可信根的证书链。
- 当前用户及本机根证书存储中缺少 `Sectigo Public Server Authentication Root E46` 与 `USERTrust ECC Certification Authority`；已有 `AAA Certificate Services` 根证书。
- 观察到 `HKLM\SOFTWARE\Policies\Microsoft\SystemCertificates\AuthRoot` 的 `DisableRootAutoUpdate=1`，根证书自动更新处于关闭状态。尚未确定该策略由谁设置。

## 已完成的无持久修改验证

Sectigo 官方证书层级文档列出了由 AAA 签发的 E46 交叉签名证书。下载该证书后，将它加入内存中的链验证候选集合，`github.com` 与 `api.github.com` 均验证通过，最终信任锚仍为机器已有的 AAA 根证书。

该检查使用服务器身份验证用途，验证证书链签名与有效期；离线链检查没有执行吊销查询。它证明候选链可用，不能代替修复后的真实 GitHub CLI HTTPS 测试。

证书信息：

| 项目 | 内容 |
| --- | --- |
| 主体 | Sectigo Public Server Authentication Root E46 |
| 颁发者 | AAA Certificate Services |
| SHA-256 | `6802701F0FD0960FF2B51F39AAEB20A778D83261A959AD0D7FF0BE54240F673D` |
| SHA-1 指纹，仅作存储定位 | `8A7EEC444904F9D0234F5456EE71F0F7DDE7C561` |
| 有效期截止 | 2028-12-31 23:59:59 UTC |
| 已有 AAA 根指纹 | `D1EB23A46D17D68FD92564C2F1F1601764D8E349` |
| 下载证书的位置 | `%TEMP%\codex-klbook-tls\Sectigo-E46-cross-signed-AAA.crt` |

来源：[Sectigo 官方证书层级文档](https://www.sectigo.com/uploads/resources/Sectigo-CA-Heirarchy-v4.pdf)，其中该交叉签名证书指向 [crt.sh 记录 11405664273](https://crt.sh/?id=11405664273)。Windows 根证书更新机制见 [Microsoft 文档](https://learn.microsoft.com/en-us/windows-server/identity/ad-cs/configure-trusted-roots-disallowed-certificates)。

## 已授权并执行的修复

1. 再次校验下载证书的 SHA-256 与上表完全一致，核实执行账号为 dcy，并记录原有根证书指纹集合。
2. 将这**一张**交叉签名证书加入 `Cert:\CurrentUser\CA`（当前用户的中间证书存储）。它会持久存在，并可能参与当前用户其他应用的证书链构建。
3. 核对原有可信根集合保持一致；根证书自动更新策略保持当前设置。
4. 重新运行 GitHub CLI HTTPS 检查。使用无效测试令牌时应得到 HTTP 401，而不是 TLS 错误；这只验证传输链，不能证明真实账号已经登录。
5. 若检查失败，撤销本次新加入的证书；已存在的证书不删除。
6. 传输检查通过后再进行真实浏览器登录及仓库权限核验。

首次自动审批认为持久修改证书存储超出诊断授权，因此拒绝了执行。用户随后明确回复“授权”，本次已在 dcy 账号下执行上述修复。

执行结果：

- 导入前再次校验证书 SHA-256，通过。
- 在 `Cert:\CurrentUser\CA` 新增且仅新增目标证书，导入前该条目不存在。
- GitHub CLI 对 API 的两个连续请求均通过 HTTPS，并得到无效测试令牌应有的 HTTP 401；原来的 `x509` 错误不再出现。
- 导入前后当前用户可信根指纹集合一致；`DisableRootAutoUpdate` 仍为 1。没有关闭 TLS 验证。
- 随后以真实用户环境执行 `gh auth status`，结果仍为未登录。浏览器授权请求曾发生网络连接超时，不能把传输层修复等同于登录成功。

如需撤销本次修复，仅删除 `Cert:\CurrentUser\CA\8A7EEC444904F9D0234F5456EE71F0F7DDE7C561`。该条目已确认由本次修复新增；删除后原证书链问题可能重现。

## 与规格发布的关系

工程技能配置、用户终端的证书修复与账号登录均已完成，测试方案也已由用户确认；令牌写权限问题解决后，规格已发布为 [GitHub Issue #1](https://github.com/xianpingduan/klbook/issues/1)。证书回归检查仅使用无效的测试令牌，没有使用或保存用户在对话中暴露的令牌。

## 用户终端仍失败后的复查

- 用户明确确认：错误来自修复后重新执行的命令。
- 在 dcy 账号的代理执行环境中，解析到的 gh 仍是 `E:\Program Files\GitHub CLI\gh.exe`，已授权的中间证书仍存在。
- 再次运行 `gh api`，使用无效测试令牌得到 HTTP 401。
- 进一步复现用户的 `gh auth login --hostname github.com --with-token` 路径，输入无效测试令牌，同样得到 `error validating token: HTTP 401: Bad credentials`，没有 TLS 错误。
- 用户提供的检查结果确认：账号同为 dcy、gh 路径相同，但目标证书的 Test-Path 为 False，假令牌登录仍报 x509 错误。这证明目标证书在两个执行环境中的可见性不同；目前没有证据确定具体隔离机制。
- 已提醒用户撤销在对话中暴露的访问令牌；文档不记录其值，后续诊断不使用该令牌。是否已撤销尚未验证。

## 在故障终端直接修复

使用[修复脚本](repair-github-cli-tls.ps1)，在用户刚才报错的 PowerShell 中运行：

```powershell
& 'C:\Users\dcy\Documents\ChatGPT\错题集\docs\troubleshooting\repair-github-cli-tls.ps1'
```

用户此前已授权补齐这一张证书，本脚本沿用该授权范围。脚本内置公开证书，并校验固定 SHA-256，不读取真实令牌；通过当前进程的 Windows 证书 API 操作 CurrentUser\CA。它先复现令牌登录的证书错误，仅在匹配本次故障时补齐证书，复测失败会撤销本次新增条目。可信根存储及更新策略不做修改。

脚本不会尝试真实登录。成功结果为 `RESULT=REPAIRED_TLS_LOGIN_STILL_REQUIRED`；若执行前 HTTPS 已正常，则输出 `RESULT=TLS_OK_NO_CHANGE_NEEDED` 并保持证书存储原状。

验证范围：已完成脚本语法和内置证书指纹检查；在代理的 dcy 环境下使用 Windows PowerShell 5.1.26100.9444 执行 `-CheckOnly`，得到 `TLS_BEFORE=PASS_TLS_EXPECTED_HTTP_401`。该只读检查未覆盖用户终端的实际导入；用户随后在原故障终端运行脚本并提供了完整成功结果，见下节。

## 用户终端的最终验证

用户返回的实际执行结果：

```text
POWERSHELL_VERSION=5.1.26100.9444
PROCESS_64BIT=True
CERT_PRESENT_BEFORE=False
TLS_BEFORE=TLS_UNKNOWN_AUTHORITY
CERT_ADDED=CurrentUser\CA
TLS_AFTER=PASS_TLS_EXPECTED_HTTP_401
ROOTS_UNCHANGED=True
RESULT=REPAIRED_TLS_LOGIN_STILL_REQUIRED
```

该结果确认：同一故障终端从证书校验失败变为 HTTPS 通过，新增证书位于已授权的中间证书存储，可信根列表保持不变。HTTP 401 来自无效测试令牌，是这项传输层检查的预期结果。

此时代理检查 `gh auth status --hostname github.com`，仍报告未登录；用户后来完成了登录，结果见下节。证书修复与账号认证分别验证。已提醒用户撤销暴露的旧令牌，撤销情况尚未验证；凭据不发送到对话中。

## 后续登录与发布权限核验

- 用户报告“已登录”后，已通过 CLI 验证账号为 `xianpingduan`，凭据来源为系统凭据管理器；没有 GH_TOKEN、GITHUB_TOKEN 或 GH_CONFIG_DIR 环境变量覆盖。
- 目标仓库 `xianpingduan/klbook` 启用 Issues、未归档，账号具有 ADMIN 权限；发布前查询没有已有议题。这些结果不能证明令牌有写权限。
- 创建缺失的 needs-triage 标签时，GitHub 返回 `403: Resource not accessible by personal access token`。用户报告已调整并保存权限后，重试仍然返回相同错误；脚本立即停止，没有执行议题创建。
- 当时提出核对当前 CLI 实际使用的令牌是否授权目标仓库，且 Repository permissions 中 Issues 为 Read and write；如果调整的是另一枚令牌，需要在本机更新登录凭据。此前具体不匹配原因未能确定。
- 用户随后要求继续。2026-09-18 再次执行时，四次创建标签均返回 HTTP 201；已复用原有 wontfix，五个标准标签齐备。规格成功发布为 [GitHub Issue #1](https://github.com/xianpingduan/klbook/issues/1)，并回读确认标题、正文和 ready-for-agent 标签一致。权限问题已不再阻碍发布，不推断期间具体变更或权限生效机制。

权限依据：[GitHub 创建标签接口](https://docs.github.com/en/rest/issues/labels#create-a-label)与[REST API 权限错误说明](https://docs.github.com/en/rest/using-the-rest-api/troubleshooting-the-rest-api#resource-not-accessible)。上述 403 来自 GitHub API，与 TLS 故障及本机自动审批分别处理；两项故障现均已解决。
