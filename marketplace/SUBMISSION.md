# 市场投稿材料

## 投稿记录

2026-11-09 已提交首次上架 PR：[awesome-dsh-plugin/awesome-dsh-plugin#13453](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/13453)。

- 插件版本：`1.1.1`，投稿时已发布源码提交为 `541321a91e77942ba23bcc19267b2d5a8a79ccbf`。
- 投稿分支：`Oak-liuhj:codex/add-dsh-session-rollover`。
- 唯一新增文件：`data/plugins/Oak-liuhj__dsh-session-rollover.yml`。
- 校验与审核的实时状态以 PR 页面为准。提交 PR 不等于市场已收录；正式收录还需维护者合并及目录后续构建。

## npm 发布记录

2026-11-11 **13:51（北京时间）**，`dsh-session-rollover@1.1.1` 已正式发布到 [npm](https://www.npmjs.com/package/dsh-session-rollover/v/1.1.1)。npm 发布账号为 `oak-ai`，插件作者与 GitHub 仓库所有者为 `Oak-liuhj`。

- npm 官方源与腾讯镜像的 `latest` 均已确认为 `1.1.1`。
- 下载的 tgz 与审核通过的原包一致，SHA1 为 `cbe802fe44f8ae14da3eebc8d6a92e3468609ab5`，SHA512 integrity 也已核对。
- 两个源均已通过按包名隔离安装；已验证服务端入口导入、挂载补丁、预构建客户端、图标、双语资源及许可证文件。
- 用户可在「填入插件 npm 包名」中输入 `dsh-session-rollover`；CLI 桌面 profile 示例为 `dsh plugin --profile desktop add dsh-session-rollover`。

本次验证未改动生产 DSH profile；正式版本发布与市场目录收录分别核实，npm 的 `0.0.0-stage` 占位版本不作为发布成功依据。

## 投稿规则与材料

投稿目录为 [awesome-dsh-plugin/awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)，市场应用代码仓库 `dsh-market/dsh-market` 不是插件条目的投稿目标。规则来源：[contributing.md](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/blob/main/contributing.md)（核对于 2026-11-07）。

仅新增 `data/plugins/Oak-liuhj__dsh-session-rollover.yml`，内容使用本目录同名文件；不手改自动生成的 README，不增加 npm/version/tags 等非目录字段。

建议 PR 标题：`Add Oak-liuhj/dsh-session-rollover`

建议 PR 正文：

> Adds a community DSH session plugin that splits long conversations at safe turn boundaries, carries todo handoff snapshots and provides source navigation and read-only archives. The repository includes a DSH bundle patch, prebuilt client, English/Chinese metadata and details, a PNG icon, screenshots and both license notices. Verified against DSH 0.2.1-rc.5 with automated regression tests and an isolated local-model fixture; Bot group channels are not fully validated.

提交前确认公开 main 分支或安装目标包含 `client.js`、图标和截图；仓库 topic 包含 `dsh-plugin`，创建满一天。仓库创建时间核对为 2026-11-06 06:45:34 UTC，最早满一天时间为北京时间 **2026-11-07 14:45:34**。npm 发布可选，未发布 npm 时使用 GitHub 安装源。

本目录的 YAML 已通过上述 PR 提交。市场收录、npm 发布和 GitHub Release 是独立状态；首次市场投稿未包含 npm 发布，后续 npm 发布见上方记录。本记录不表示已创建 GitHub Release。
