# dsh-session-rollover

DeepSeek Harness 会话分卷与进度续接插件，当前版本 **1.1.1**。达到用户消息阈值后，在安全切点创建新卷、注入完整交接快照，保留旧卷供只读回溯。与 R2 `dsh-todo-progress` 共用待办来源，不另建一套任务状态。

零第三方运行时依赖，通过宿主公开服务和 UI 插槽接入；公开包名为 `dsh-session-rollover`，支持 GitHub / 本地压缩包安装；npm 发布可选。宿主兼容元数据见 [package.json](./package.json)，本轮验证范围见 [R3 修复与验证记录](./docs/r3-validation.md)。

![会话分卷与续接](./assets/icon.png)

[使用说明](./docs/DETAIL.zh-CN.md) · [English](./docs/DETAIL.md) · [发布指南](./docs/PUBLISHING.md) · [更新记录](./CHANGELOG.md)

## 主要行为

- **计数和切点分离**：一条真实 `user/message` 算一轮；排除交接消息、时间上下文、技能目录和运行时上下文。达到默认 10 轮后，等待 `turn/end`；未完成工具调用、压缩/换段期间不分卷，子会话不自动分卷。
- **避免误降级**：宿主原生 `system/message` Handoff 和内部上下文标记不触发外部分段降级；真实外部 `[Checkpoint N]` / `[Handoff · part N]` 标记使 auto 降为 manual。`forceAuto` 只豁免该降级，不绕过安全切点。
- **同源快照**：一次捕获待办与后台任务，生成四段正文和结构化 JSON；保留全部进行中步骤、原文约束、文件线索和未收尾 job。首条交接卡展示六块内容及卷标识、交接健康，共八组信息。
- **预算与重试**：正文摘要最多 1500 字符，载荷及包含 JSON 的完整首条消息最多 16 KiB UTF-8；超限拒绝交接，不静默裁剪关键内容。初次失败后最多再试两次，后续用户轮次提供重试机会；计数落盘，重启不重置。手动操作开启一次新的尝试。
- **卷号独立于标题**：默认原会话改为 `原名-1`、新会话为 `原名-2`；重名寻找空位，但真实卷序不会随名称后缀跳号。保留用户手动标题。同簇最多 9 卷，满额常驻提示；显式换会话可开独立接续系列。
- **模型与工作区继承**：继承来源工作区/目录、模型；模型继承抛错时使用可选的公开默认模型服务并提示。后台 job 只传递句柄和状态，不迁移进程。
- **归档保护**：旧卷由服务端拦截后续回合首步，浏览器使用宿主 `conversation.blocks` 禁用输入；可双向切换“允许再次写入/恢复只读”，刷新和重启保留状态。已封旧卷恢复写入后仍不会重复分卷。
- **恢复与降级**：启动时读取索引，并用已注入的交接消息补齐缺失记录；损坏/丢失索引可重建，废弃待清理卷不当成成功分卷。跨文件存储不是数据库事务；保存异常通过 `degraded` 与界面提示暴露。

## 界面

会话标题栏展示本卷用户轮数、阈值、真实卷序、来源与归档状态；`⋯` 提供“现在换会话”“新建独立会话”和“使用说明”。列表使用宿主 trailing 徽标槽，旧宿主自动回退到 leading 槽。

新卷首条消息渲染接续摘要卡，默认三行预览，可展开全部、独立展开 JSON、复制原始快照、跳转上一卷。交接卡始终保留切卷时的历史，右侧 R2 面板显示后续实时进度；回看旧卷不会被反复跳回新卷。宿主缺少 `userText` 扩展时，摘要回退到输入区域上方。

样式适配宿主浅色和 `body[data-ds-dark-theme]` 深色主题；支持键盘焦点、ARIA 展开/开关状态、长文本换行及 JSON 内滚动。操作菜单使用原生 dialog，避免被标题栏裁切。

独立交互示意：[R3 优化原型](./docs/r3-demo.html)。它演示固定任务与一次分卷，不连接模型，不等同于插件运行页面。

## 安装与卸载

需要可用的 DSH 宿主，已验证版本为 `0.2.1-rc.5`。本插件不需要额外 API Key，继续对话使用宿主已有模型设置。右侧实时任务面板由可选的 [dsh-todo-progress](https://github.com/Oak-liuhj/dsh-todo-progress) 提供。

浏览器入口已预构建，安装时无需构建。建议从插件市场或桌面插件管理器安装；市场尚未收录时可使用 GitHub 源或本地包：

```powershell
dsh plugin --profile <name> add github:Oak-liuhj/dsh-session-rollover
# 或：dsh plugin --profile <name> add D:/release/dsh-session-rollover-1.1.1.tgz
# 卸载：dsh plugin --profile <name> remove dsh-session-rollover
```

桌面安装请选择实际的 `desktop` profile，完成后通过桌面客户端重启宿主。旧 scoped 包 `@deepseek-ai/dsh-session-rollover` 必须先移除或在同次依赖变更中替换，且只保留一条新包 bundle / `session-rollover` 配置，避免双重注册。升级前备份 profile 配置和数据；公开包更名不改变数据目录、服务名或旧 `src/*` 接口。详见 [发布与升级指南](./docs/PUBLISHING.md)。

卸载保留独立插件数据；复装可继续读取。数据目录不应位于代码仓库或安装包目录。

## 配置

挂载补丁：[cordis.patch.yml](./cordis.patch.yml)。

```yaml
- insert:
    - id: session-rollover
      name: 'dsh-session-rollover'
      config:
        mode: auto
        threshold: 10
        # forceAuto: false
        # dataDir: 'D:/dsh-data/session-rollover'
```

| 配置 | 默认 | 说明 |
| --- | --- | --- |
| `mode` | `auto` | `auto` 自动分卷；`manual` 达阈值只提示；`off` 关闭自动判定 |
| `threshold` | `10` | 真实用户消息阈值 |
| `forceAuto` | `false` | 外部分段标记不再降级为 manual，安全检查照常执行 |
| `dataDir` | 自动 | 独立持久化目录 |

显式手动分卷绕过轮数和 mode，但仍检查只读、封卷、子会话、执行中回合、压缩及工具调用。9 卷上限后的独立接续不封存或改名来源卷；新卷属于新簇、`parent_session_id: null`，JSON 仍保存 `from_session_id` 作为历史出处。

## 服务和 HTTP 接口

```js
const result = await ctx.sessionRollover.rollover(sessionId);
// status: rolled-over | skipped | failed
// 成功时 newSessionId；其他情况查看 reason。

const info = ctx.sessionRollover.info(sessionId);
// source, handoff, readonly, sealed, turnCount, threshold,
// volume, cap, capped, summaryRetry, retryLimitReached,
// previousTurnCount, nextSessionId, degraded 等。

ctx.sessionRollover.setReadonly(sessionId, false); // 仅允许已归档卷
```

R2 面板可继续调用原有 rollover/info 服务；无实时 `todo/write` 时继承交接快照，出现实时事件后以日志为准，包括显式清空待办。

浏览器控制接口要求宿主 owner 身份；POST 校验同源、JSON、请求体大小及会话 ID，不接收客户端提供的交接正文。

| 方法与路径 | 用途 |
| --- | --- |
| `GET /api-dsh-session-rollover/session?session=<id>` | 会话状态与快照 |
| `POST /api-dsh-session-rollover/session` | `{sessionId, action: 'readonly', readonly: false}`；或 `action: 'rollover' / 'new'` |
| `GET /api-dsh-session-rollover/pending?session=<id>` | 已认证浏览器取走一次性提示；取件即删除，不是展示确认协议 |

`connection` 为显式必需注入；`jobs`、`agentDefaultModel` 通过独立可选注入获取，避免 Cordis 未声明服务访问报错。

## 项目结构

```text
index.js                         稳定服务端入口
client.js                        生成的宿主 ModuleLoader 浏览器入口
cordis.patch.yml                 挂载补丁
src/
  domain/                        计数、切点、模式、命名、待办、摘要与载荷纯规则
  application/                   T0–T8 分卷编排与交接消息排版
  storage/                       索引、快照、只读、重试、提示队列
  server/                        生命周期、公开宿主适配器、HTTP 路由
  client/
    rollover-ui.js              React 状态订阅、摘要卡和归档输入保护
    toast-client.js             原提示实现与 ModuleLoader 构建模板
  *.mjs                          旧路径兼容转导出
scripts/build-client.mjs         无第三方构建依赖，嵌入 UI factory
test/                          按 domain/application/storage/server/client/package 分类
docs/architecture.md           分层、失败边界及维护规则
docs/r3-validation.md           本轮修复、验证和边界
docs/r3-demo.html               固定数据交互原型
```

根入口默认/具名导出和旧 `src/*.mjs` 子路径保持兼容；新代码引用分类目录。修改 `src/client/` 后运行构建，不直接编辑生成的 `client.js`。

## 数据目录

优先级为配置 `dataDir` → `DSH_ROLLOVER_DATA_DIR` → `<DSH_HOME>/plugin-data/dsh-session-rollover` → `~/.dsh/plugin-data/dsh-session-rollover`。环境变量空白视为未设置。

| 文件 | 内容 |
| --- | --- |
| `cluster-index.json` | 七字段簇记录及 `turn_counts`，同文件原子替换 |
| `handoff-<id>.json` | 完整历史交接快照 |
| `readonly-<id>.json` | 双向只读设置；优先于索引默认值，兼容旧聚合标记 |
| `retry-<id>.json` | 摘要尝试次数 |
| `pending-cleanup.json` | 废弃新卷；仅登记，不自动删除宿主会话 |
| `storage-health.json` | 建卷前存储预检 |
| `notices.json` / `plugin.log.jsonl` | 提示队列/去重与诊断日志 |

每个文件采用临时文件加 rename，不能保证宿主会话与多个文件之间的跨系统原子提交。提交后提示/重试状态写盘失败仍保留成功结果并标记降级，避免重复创建新卷。索引恢复依赖宿主中仍保存的交接消息；历史消息也已删除时无法凭空恢复。

## 开发与验证

开发验证使用 Node.js 24.22.1、npm 11.19.1，无需安装第三方依赖。

```powershell
npm test
npm run build:check
npm pack --dry-run
npm pack --pack-destination <输出目录>
```

`npm test` 构建后运行 `test/**/*.test.mjs`，不把 support 夹具当测试。发布前检查实际压缩包解压导入、静态入口与兼容导出，而不只看 dry-run 清单。

本轮已在**已安装 DSH 的隔离 Web profile** 中接入本地模型夹具，验证真实宿主事件、浏览器加载、十条真实用户消息分卷、`todo_write` 接续、摘要/JSON/剪贴板一致、来源导航和双向只读开关；这不是生产模型质量或 Bot 群端验收。详细记录见 [验证文档](./docs/r3-validation.md)。

## 兼容与边界

`dsh.verifiedDsh: 0.2.1-rc.5`、`dsBot.min/verified: 0.2.6` 是保留的历史适配元数据，不代表本轮新增了群端版本验收。宿主升级后需复验公开注入、插槽、用户消息来源与改名行为。

- 摘要是确定性摘录，不调用语言模型；文件路径仅为线索，不证明文件已修改。当前未迁移或恢复后台进程。
- 自动重试由后续用户轮次触发，没有后台定时无限重试。已封卷恢复写入只允许继续对话，不重新分卷。
- 正式界面的输入保护依赖公开 `conversation.blocks`；侧栏徽标仅显示在宿主开放的列表装饰槽上，宿主运行状态图标可能暂时占用该位置。
- 提示定位沿用原实现，依据第一个富文本输入框；多编辑器页面需另行复验。
- 自动化测试、交互原型、真实宿主加模型夹具分别提供不同证据，不替代真实服务商模型和 Bot 端完整业务验收。

## 许可证

本项目采用 [Apache-2.0](./LICENSE)，包含 Fei2411 的 [MIT 上游贡献](./LICENSE.upstream)；分发时须同时保留两份许可证及 [NOTICE](./NOTICE)。SPDX：`(Apache-2.0 AND MIT)`。
