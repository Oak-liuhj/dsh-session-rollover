# 市场投稿材料

## 投稿记录

2026-11-09 已提交首次上架 PR：[awesome-dsh-plugin/awesome-dsh-plugin#13453](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/13453)。

- 插件版本：`1.1.1`，投稿时已发布源码提交为 `541321a91e77942ba23bcc19267b2d5a8a79ccbf`。
- 投稿分支：`Oak-liuhj:codex/add-dsh-session-rollover`。
- 唯一新增文件：`data/plugins/Oak-liuhj__dsh-session-rollover.yml`。
- 校验与审核的实时状态以 PR 页面为准。提交 PR 不等于市场已收录；正式收录还需维护者合并及目录后续构建。

## 投稿规则与材料

投稿目录为 [awesome-dsh-plugin/awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)，市场应用代码仓库 `dsh-market/dsh-market` 不是插件条目的投稿目标。规则来源：[contributing.md](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/blob/main/contributing.md)（核对于 2026-11-07）。

仅新增 `data/plugins/Oak-liuhj__dsh-session-rollover.yml`，内容使用本目录同名文件；不手改自动生成的 README，不增加 npm/version/tags 等非目录字段。

建议 PR 标题：`Add Oak-liuhj/dsh-session-rollover`

建议 PR 正文：

> Adds a community DSH session plugin that splits long conversations at safe turn boundaries, carries todo handoff snapshots and provides source navigation and read-only archives. The repository includes a DSH bundle patch, prebuilt client, English/Chinese metadata and details, a PNG icon, screenshots and both license notices. Verified against DSH 0.2.1-rc.5 with automated regression tests and an isolated local-model fixture; Bot group channels are not fully validated.

提交前确认公开 main 分支或安装目标包含 `client.js`、图标和截图；仓库 topic 包含 `dsh-plugin`，创建满一天。仓库创建时间核对为 2026-11-06 06:45:34 UTC，最早满一天时间为北京时间 **2026-11-07 14:45:34**。npm 发布可选，未发布 npm 时使用 GitHub 安装源。

本目录的 YAML 已通过上述 PR 提交。市场收录、npm 发布和 GitHub Release 是独立状态；本次投稿不包含 npm 发布或创建 GitHub Release。
