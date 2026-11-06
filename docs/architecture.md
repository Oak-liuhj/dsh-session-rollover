# 架构与维护说明

项目使用 JavaScript ESM，服务端无需编译；浏览器 UI 通过无依赖脚本生成单文件 ModuleLoader 入口。

## 模块边界

| 层 | 职责 | 依赖 |
| --- | --- | --- |
| `domain/` | 用户轮次/切点、模式、命名、摘要、载荷和内存簇索引 | 不访问宿主、磁盘、网络或 DOM |
| `application/` | T0–T8 顺序、预算、失败补偿与消息排版 | domain；以参数传入 host、state、index、persistence |
| `storage/` | 索引、只读、快照、重试和提示持久化 | 可依赖 domain，不依赖插件类 |
| `server/` | 生命周期、事件、安全闸、公开服务适配和 HTTP | 组装各层 |
| `client/` | 共享状态订阅、交接卡、归档输入保护和 toast | 宿主 React、slots、uiWorkspace、uiConversation、conversation |

唯一插件类位于 `src/server/plugin.mjs`。根 `index.js` 保留默认/具名导出，旧 `src/*.mjs` 仅转导出，兼容包 `./src/*` 使用者。

`npm run build` 将 `src/client/rollover-ui.js` 的 factory 嵌入 `toast-client.js` 模板，生成根 `client.js`；`build:check` 防止源码与产物不一致。测试与打包前自动构建，无额外 npm 运行时依赖。

## 入口与切点

自动入口为 `session/event` 的 `turn/end`、`compaction/end`、`part/end`、`tool/result`，同时保留 `agent/pre-step` 兼容检查。`countTurns` 统计真正的用户消息，`hasOpenTurn` 检查执行是否结束，两者互不代替。宿主内部时间、技能目录、运行时上下文及交接注入不占用户轮数。

同一会话的自动/手动入口共用 `rollover:<id>` 锁；`lastCheckedTurn` 防同轮重复检查。不安全工具/换段切点释放本轮检查标记，等结束事件再次判定。`forceAuto` 不绕过切点检查。

服务端在后续回合首步拦截归档只读。手动 `ctx.sessionRollover.rollover` 绕过 mode/threshold，但仍检查执行状态、封卷、只读、子会话、工具与预算。`setReadonly` 只允许已归档卷，写入单卷设置后再同步索引；单卷设置为查询优先来源，保持重启一致。

必需服务由 static inject 声明，包括 HTTP owner 准入使用的 `connection`。可选 `jobs` / `agentDefaultModel` 分别使用 `ctx.inject`，服务撤销时清理引用，禁止跨 Cordis 注入范围直接取值。

## 事务阶段

| 阶段 | 工作 | 失败边界 |
| --- | --- | --- |
| T0 | 读取快照、检查执行中回合/换段、统计用户轮数 | 不建卷 |
| T1 | mode 和有来源信息的外部 marker 检测 | 不建卷；manual 可提示 |
| T2 | 子会话/工具安全闸、命名预演、一次捕获 todos/jobs | 不建卷 |
| T3 | 四段正文与完整载荷、1500 字符/16 KiB 闸、存储预检 | 不建卷、不裁剪关键内容 |
| T4 | 按来源 workspace/cwd 创建空会话 | 原会话不变 |
| T5 | 保存快照、继承模型、注入首条消息 | 原会话不变；废弃卷登记 pending |
| T6 | 必要时原会话改名 | 失败登记 pending |
| T7 | 新卷改名 | 失败尝试恢复原标题，回滚失败独立告警 |
| T8 | 索引/计数提交、旧卷只读、清理 pending | 分文件原子替换；异常显式 degraded |

这不是跨宿主与多个 JSON 的原子数据库事务。建卷前的存储预检发现常见目录不可写问题；提交后辅助状态/提示失败不能将已成功建卷重新报告成失败并再次创建。清理登记本身失败也记录降级，避免二次异常覆盖主结果。

真实 `vol_no` 独立于命名后缀；冲突使后缀超过 9 时使用索引确认后缀，避免名称嵌套，也避免把普通 `Q3-26` 猜成卷号。第九卷显式接续可创建新簇，父链为 null，JSON 来源 ID 只提供历史出处；此路径不封存或改名来源。

## 一致性与恢复

一次适配器捕获源事件与 live job 列表；一次事务取 todos/jobs 后，同时用于人读和机器快照。保留全部 active 步骤、约束和文件；正文四段映射为 UI 六块内容及卷标识/健康两组。用户原文和路径不能用静默截断满足预算。

待办取最后一个合法 `todo/write`。完全没有实时事件时继承快照，明确空数组表示清空。后台任务合并 workflow、`job/registered` / `job/settled` 和可选 live registry，按 owner 过滤，记录 running/stopping 等状态而不迁移进程。

摘要失败尝试次数写 `retry-<id>.json`，初次加两次重试后停止，重启不重置；后续用户轮次提供重试机会，手动操作可开始新尝试。

启动读取合法索引，然后扫描宿主中已注入的 `rollover: v1` 交接消息，补齐缺项或重建丢失/坏索引；使用快照 true volume，旧快照可沿父链推导。pending 废弃卷不参与恢复，不凭任意标题后缀归簇。显式 readonly false 不被重建覆盖。旧 `rebuildFromTitles` / `createSummaryRetry` 导出继续兼容，但运行时使用上述更严格恢复与持久化尝试流程。

## 浏览器与控制面

每会话共用轮询缓存，多 UI 订阅复用请求；最后订阅卸载后清理轮询。切换会话当帧不借用旧卷状态。

正式接口 `GET/POST /api-dsh-session-rollover/session` 通过宿主 `connection.admit` 检查 owner；POST 校验 Origin、JSON、体积与 ID。摘要由服务器生成，不接受浏览器传入快照。旧 pending GET 继续用于一次性 toast，取走即删，不确认展示。

归档输入使用公开 `conversation.blocks`，释放时撤销自己的原因并恢复其他插件最新状态。不要覆盖 `conversation.composer.bar`：其子槽拥有独占声明和 renderSlot 授权，简单包装会崩溃，重复声明也会被拒绝。

首条 userText 渲染卡固定显示历史快照；后续 R2 进度消费实时待办。缺少 userText 扩展时在 dock 回退展示。列表优先 trailing，旧宿主回退 leading；宿主状态图标可能临时占据 leading。来源导航与自动跳转区分：只有当前浏览器观察到活动→封卷时跳新卷，回看旧卷不跳回。

## 验证约定

规则改动在 domain 测试；副作用/补偿用 application 夹具；重启/存储/权限/注入用 server 与 storage 测试；UI 资源释放和提示用 client 测试；兼容导出用 package 测试。运行 `npm test`、`npm run build:check`，并实际解包导入 npm pack 产物。

宿主接口与前端加载变更需要真实宿主浏览器验证。已安装宿主加本地模型夹具、交互原型和纯测试分别记录证据；不能将其等同于生产服务商模型或 Bot 群端验收。详见 [R3 修复与验证记录](./r3-validation.md)。
