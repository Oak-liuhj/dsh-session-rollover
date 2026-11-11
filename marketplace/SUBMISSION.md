# 市场投稿材料

## 投稿记录

2026-11-11 已提交市场更新 PR：[awesome-dsh-plugin/awesome-dsh-plugin#14240](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/14240)。只修改现有条目的中英文简介，补充宿主兼容检查；正文说明 1.2.0 已发布及支持的 DSH 版本，并附真实宿主与远程 CI 证据。分支为 `Oak-liuhj:codex/update-dsh-session-rollover-1-2-0`，提交为 `5cd4d474f448a42fc2828978d6e215f9078447e8`。提交不代表已合并，npm/version 元数据仍由市场自动采集。

2026-11-11 复核：首次收录 PR 已于 **2026-11-10 00:46:29 UTC** 合并，官方 main 的条目存在，在线 `plugins.json` 已包含本插件。市场条目指向本仓库，不锁定插件版本，后续发布无需重复投稿同名条目。

本次发布后再次下载目录，条目的 `npm`、`version` 展示字段仍为 `null`，需等待市场重新抓取元数据；不据此宣称市场已显示 1.2.0。GitHub main 已包含新版代码，npm 官方源按包名可安装 1.2.0。

2026-11-09 已提交首次上架 PR：[awesome-dsh-plugin/awesome-dsh-plugin#13453](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/13453)。

- 插件版本：`1.1.1`，投稿时已发布源码提交为 `541321a91e77942ba23bcc19267b2d5a8a79ccbf`。
- 投稿分支：`Oak-liuhj:codex/add-dsh-session-rollover`。
- 唯一新增文件：`data/plugins/Oak-liuhj__dsh-session-rollover.yml`。
- 校验与审核的实时状态以 PR 页面为准。提交 PR 不等于市场已收录；正式收录还需维护者合并及目录后续构建。

## npm 发布记录

### 1.2.0

2026-11-11，`dsh-session-rollover@1.2.0` 已发布，npm 官方源 `latest` 为 `1.2.0`，声明支持 DSH `0.2.1-rc.5 || 0.2.2-rc.1`。

- [npm 1.2.0](https://www.npmjs.com/package/dsh-session-rollover/v/1.2.0) 与 [GitHub Release v1.2.0](https://github.com/Oak-liuhj/dsh-session-rollover/releases/tag/v1.2.0) 均已公开；tag 指向 `5bfde1e93ca4021fc7fcab59609925125bc2f740`。
- 两处实际下载的 tgz 均与审核包逐字节哈希一致；SHA256 为 `b35a9fa386d176e7dcc133e1a8bf36ac853ac7841786059bf302563c65c984a3`，SHA1 为 `7b1b69e17abfbc76a960f277a31092f70187f669`。GitHub 附有 `SHA256SUMS`。
- 已从 npm 官方源按 `dsh-session-rollover@1.2.0` 隔离安装，并核对版本、宿主范围、导出入口及全部发布资源。未改动生产 profile。
- 发布后的远程检查发现一个测试夹具将 Windows 的不存在盘符当作跨平台不可写路径；Linux 实际能创建该目录。提交 `0b526f057fdc1662ed3a7e7f2f973525578556c0` 改用文件阻挡父目录，不改变已发布的运行代码或安装包，也不移动既有 tag。
- [远程复验](https://github.com/Oak-liuhj/dsh-session-rollover/actions/runs/42981276082) 全部通过：Windows/Linux、Node 22/24 四组回归与打包检查，以及三个 DSH 版本的公开声明检查。`v1.2.0` tag 的原始 CI 仍保留测试夹具失败记录。

桌面用户更新到 1.2.0 后重启 DSH；镜像尚未同步时，可使用 GitHub Release 附件或 GitHub 源。后续 DSH 版本仍需逐版真实宿主验收。

### 1.1.1

2026-11-11 **13:51（北京时间）**，`dsh-session-rollover@1.1.1` 已正式发布到 [npm](https://www.npmjs.com/package/dsh-session-rollover/v/1.1.1)。npm 发布账号为 `oak-ai`，插件作者与 GitHub 仓库所有者为 `Oak-liuhj`。

- npm 官方源与腾讯镜像的 `latest` 均已确认为 `1.1.1`。
- 下载的 tgz 与审核通过的原包一致，SHA1 为 `cbe802fe44f8ae14da3eebc8d6a92e3468609ab5`，SHA512 integrity 也已核对。
- 两个源均已通过按包名隔离安装；已验证服务端入口导入、挂载补丁、预构建客户端、图标、双语资源及许可证文件。
- 用户可在「填入插件 npm 包名」中输入 `dsh-session-rollover`；CLI 桌面 profile 示例为 `dsh plugin --profile desktop add dsh-session-rollover`。

本次验证未改动生产 DSH profile；正式版本发布与市场目录收录分别核实，npm 的 `0.0.0-stage` 占位版本不作为发布成功依据。

## 投稿规则与材料

投稿目录为 [awesome-dsh-plugin/awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)，市场应用代码仓库 `dsh-market/dsh-market` 不是插件条目的投稿目标。规则来源：[contributing.md](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/blob/main/contributing.md)（核对于 2026-11-07）。

首次投稿仅新增 `data/plugins/Oak-liuhj__dsh-session-rollover.yml`，后续更新修改同一文件，内容使用本目录同名文件；不手改自动生成的 README，不增加 npm/version/tags 等非目录字段。投稿规则已于 2026-11-11 再次核对，npm 关联无需另行通知维护者。

建议 PR 标题：`Add Oak-liuhj/dsh-session-rollover`

建议 PR 正文：

> Adds a community DSH session plugin that splits long conversations at safe turn boundaries, carries todo handoff snapshots and provides source navigation and read-only archives. The repository includes a DSH bundle patch, prebuilt client, English/Chinese metadata and details, a PNG icon, screenshots and both license notices. Verified against DSH 0.2.1-rc.5 with automated regression tests and an isolated local-model fixture; Bot group channels are not fully validated.

提交前确认公开 main 分支或安装目标包含 `client.js`、图标和截图；仓库 topic 包含 `dsh-plugin`，创建满一天。仓库创建时间核对为 2026-11-06 06:45:34 UTC，最早满一天时间为北京时间 **2026-11-07 14:45:34**。npm 发布可选，未发布 npm 时使用 GitHub 安装源。

本目录的 YAML 已通过上述 PR 收录。市场收录、npm 发布和 GitHub Release 是独立状态；首次市场投稿未包含 npm 发布，后续 npm 与 GitHub Release 的核验见上方版本记录。
