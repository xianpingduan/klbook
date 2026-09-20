# 手动收集与公共写入约定

对应 [#3](https://github.com/xianpingduan/klbook/issues/3)。当前流程：电脑选图 → 手动框题或选择整页 → 选学科 → 保存 → 从列表查看题目区和原始页。来源、页码、题号、备注均可留空和后补；答案、错因总结、解题思路不作为收集门槛。

## 图片与存储

- 接受 JPEG、PNG、静态 WebP；每张最多 15 MiB、4000 万像素。后端按真实内容解码，不依赖扩展名或请求 MIME。HEIC、批量、跨页由后续采集任务处理。
- 使用 sharp 0.35.4 解码，依赖随锁文件安装，不另装图片服务。原始页保留上传字节及 SHA-256；单独生成最长边 2800 像素的 WebP 预览，按 EXIF 调整方向。原图的 EXIF 等信息仍在原文件中。
- `width/height` 表示按 EXIF 摆正后的原始页尺寸；题目区使用这一坐标系下的归一化矩形 `x/y/width/height`（0～1）。裁剪只存坐标，绝不覆盖原件。
- 文件位于 `KLBOOK_DATA_DIR/attachments/pages/<服务端生成的 UUID>/`，包含 `original` 与 `preview`。路径和上传文件名无关，客户端通过鉴权接口获取 Blob。
- 写入顺序：解码验证 → 新建尚未发布的 UUID 目录 → 两个文件写完并各自同步磁盘 → 短 SQLite 事务提交原始页、草稿及操作标识。附件只在数据库提交后才能经 API 获取，不依赖目录重命名。转换与文件 I/O 不占数据库事务。
- 文件失败不插入题目；数据库提交失败清理本次未被引用的文件。进程在文件完成而数据库提交前异常退出，可能留下未引用目录，不会成为可见题目；自动孤立文件巡检与备份维护由后续任务统一处理，勿手动清理已引用附件。
- 保存及写入重试检查两个文件的内容摘要。缺失或损坏返回 503，不确认写入成功。普通列表中的同步状态表示该记录已完成发布；读取附件仍单独检查完整性并提供失败提示。

官方依据：[sharp metadata](https://sharp.pixelplumbing.com/api-input/)、[EXIF 自动调整方向](https://sharp.pixelplumbing.com/api-operation/#autoOrient)、[Fastify 二进制请求解析](https://fastify.dev/docs/latest/Reference/ContentTypeParser/)。

## 身份、修订与重复请求

数据库迁移 4 新增学科、原始页、题目与写入操作表；沿用已有家庭、学习者、账号和会话，不重新初始化。单实例共用一个 SQLite 连接，开启外键、WAL 和 FULL 同步。

| 字段 | 约定 |
| --- | --- |
| `libraryId / learnerId` | 由已登录家庭确定，不接受客户端指定其他家庭 |
| 题目 / 原始页 `id` | 服务端随机 UUID，跨设备和重启保持不变 |
| `revision` | 草稿初始为 1，每次成功的新编辑加 1；重试不再加 1 |
| `operationId` | 客户端为一次操作生成 UUID，在收到确定结果前与相同内容一起重试 |
| `state` | `draft` 或 `collected`；后者要求题目区及有效学科；已收集不能退回草稿 |
| `createdAt / updatedAt / collectedAt` | 服务端 Unix 毫秒时间；首次收集生成 `collectedAt`，补充信息不改收集日期 |

操作唯一性按 `libraryId + accountId + operationId` 保存，跨设备会话仍能辨认重试。同一标识与不同请求内容搭配返回 409；相同内容返回该题当前版本。每次编辑须携带读到的 `expectedRevision`；版本过旧返回 409，页面保留填写内容，不自动覆盖其他设备的修改。完整的冲突核对界面由 #10 扩展。

## API

以下路径均以 `/api/v1/collection` 开头，需要普通设备 Bearer 会话；响应禁止缓存。附件没有公开静态目录，也不把令牌放入图片 URL。

| 方法与路径 | 输入 / 返回 |
| --- | --- |
| `GET /subjects` | 初始语文、数学、英语、科学的稳定 ID 和显示名称 |
| `POST /drafts` | 原始图片二进制；`Content-Type` 为受支持图片类型，`Idempotency-Key` 为操作 UUID；201 返回完整草稿 |
| `GET /questions?state=draft或collected&offset=0` | 每页最多 50 条，返回 `items/total/offset/limit` |
| `GET /questions/:id` | 完整题目、修订、整理字段及原始页元数据 |
| `PUT /questions/:id` | 完整编辑字段，见下方；200 返回最新题目 |
| `GET /pages/:id/original` | 原件字节与实际 MIME |
| `GET /pages/:id/preview` | 摆正方向的 WebP 预览 |

编辑字段：`operationId, expectedRevision, state, subjectId, region, source, pageNumber, questionNumber, note`。草稿允许 `subjectId/region=null`，选填文本使用空字符串。来源最多 200 字符，页码及题号各 32，备注 2000。400 为格式错误，401 为会话失效，409 为版本或操作冲突，413 为请求过大，415/422 为不支持或不能解码的图片/不满足收集条件，503 为材料存储不可用。

## 本设备暂存与恢复范围

上传前通过平台存储接口将图片、原文件名与操作 UUID 写为一个 Blob，按家庭资料库和账号隔离。长度头、JSON 元信息和图片字节一起保存，避免图片与重试标识分离。浏览器适配器将 Blob 转为 ArrayBuffer 与 MIME 元信息，在同一次 IndexedDB 事务内持久化，读取时恢复 Blob；兼容 Windows WebKit 无法直接持久化 Blob 的实测限制。已有 Blob 暂存仍可读取。上传失败可重试，页面刷新后可选择继续上传；确认服务端保存后删除本设备暂存。设备存储不可用时，图片只保留在当前页面内存，返回列表仍能继续上传，关闭或刷新页面前需先恢复设备存储。

本任务只保留一张待上传图片。编辑保存失败时，字段与操作标识保留在当前页面，点击重试不会重复写入；草稿一经保存可在其他已登录会话继续整理。尚未成功保存的文字编辑不承诺刷新后保留。完整离线页面、多任务队列和编辑自动暂存归 #9；当前仍需能连接家庭电脑来重新打开应用和登录。浏览器清理站点数据会清除本设备暂存。

无需 OCR、语音、AI 或互联网即可完成手动流程。此版本在本机浏览器验证；家庭局域网 HTTPS、手机拍照/相册及真机适配属于 #4，移动安装包属于 #26。
