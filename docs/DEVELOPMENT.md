# 开发与集成

面向插件维护者和集成方。用户安装、配置与操作入口见 [README](../README.md)。

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

`workingDirectory`、`agents` 同样通过可选注入获取，用于新版领域状态读取。`sessionRollover.compatibility()` 返回关键方法的能力报告；会话 `info().compatibility` 还检查读取结果形状。逐版检查、CI 与真实宿主验收流程见 [升级适配指南](./COMPATIBILITY.md)。

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
npm run check:release
npm run check:package
npm pack --dry-run
npm pack --pack-destination <输出目录>
```

`npm test` 构建后运行 `test/**/*.test.mjs`，不把 support 夹具当测试。发布前检查实际压缩包解压导入、静态入口与兼容导出，而不只看 dry-run 清单。

既有验证已在**已安装 DSH 的隔离 Web profile** 中接入本地模型夹具，验证真实宿主事件、浏览器加载、十条真实用户消息分卷、`todo_write` 接续、摘要/JSON/剪贴板一致、来源导航和双向只读开关；这不是生产模型质量或 Bot 群端验收。详细记录见 [验证文档](./r3-validation.md)。

## 兼容与边界

`dsh.verifiedDsh: 0.2.1-rc.5`、`dsBot.min/verified: 0.2.6` 是保留的历史适配元数据，不代表新增了群端版本验收。宿主升级后需复验公开注入、插槽、用户消息来源与改名行为。

- 摘要是确定性摘录，不调用语言模型；文件路径仅为线索，不证明文件已修改。当前未迁移或恢复后台进程。
- 自动重试由后续用户轮次触发，没有后台定时无限重试。已封卷恢复写入只允许继续对话，不重新分卷。
- 正式界面的输入保护依赖公开 `conversation.blocks`；侧栏徽标仅显示在宿主开放的列表装饰槽上，宿主运行状态图标可能暂时占用该位置。
- 提示定位沿用原实现，依据第一个富文本输入框；多编辑器页面需另行复验。
- 自动化测试、交互原型、真实宿主加模型夹具分别提供不同证据，不替代真实服务商模型和 Bot 端完整业务验收。

## 发布与维护

发布步骤、scoped 旧包迁移和市场展示资源见 [发布指南](./PUBLISHING.md)。分层、事务失败边界和前端插槽说明见 [架构文档](./architecture.md)。

浏览器入口须随源码一同提交。GitHub 安装使用预构建入口，不依赖安装时构建。更改包名、导出、展示资源或挂载补丁后，运行 npm run check:release，并核对实际 tgz 中的文件。
