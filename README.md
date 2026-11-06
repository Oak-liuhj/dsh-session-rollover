# dsh-session-rollover

DeepSeek Harness 会话分卷插件。长会话达到轮次阈值后，新建会话并注入交接摘要，让后续工作沿着待办和上下文继续推进；旧卷保留记录，便于回溯。

当前版本 **1.0.1**，零第三方运行时依赖。插件通过宿主公开服务接入，用于内部安装，不提交公共 npm。版本与宿主兼容字段以 [package.json](./package.json) 为准。

## 功能与行为

- **自动分卷**：默认 `auto` 模式、10 轮阈值，首次将原标题改为 `<原名>-1`，新卷命名为 `<原名>-2`；后续按卷号递增，重名时寻找空位。
- **交接内容**：八段摘要、完整待办、当前进度、后台任务记录、约束、文件线索和来源链。新卷首条消息包含可读清单与完整 JSON，创建会话前校验整条消息不超过 **16 KiB**。
- **手动分卷**：通过 `sessionRollover.rollover(sessionId)` 显式调用，支持面板联动；新卷继承来源工作区及模型选择。
- **旧卷保护**：普通分卷完成后封存来源卷，由服务端在后续回合首步拦截写入。改名使用宿主 `sessionTitle.rename`，新卷改名失败时尝试恢复原标题。
- **数据持久化**：簇索引、交接快照、只读标记与提示队列写入独立插件数据目录，升级安装包时继续使用。
- **一次性提示**：服务端按会话与原因去重，浏览器端从同源接口取件并展示 toast。

轮次统计从完整事件日志读取，优先统计 `turn/end`；没有完成事件时，依次回退到 `turn/start`、`user/message`。这与界面中用户消息条数可能不同。

## 安装与卸载

本插件依赖 DSH 宿主服务，不能作为独立 Web 应用启动。先准备可用的 `dsh` 命令，再在本仓库根目录执行：

```powershell
dsh plugin --profile <name> add .
```

卸载插件：

```powershell
dsh plugin --profile <name> remove @deepseek-ai/dsh-session-rollover
```

卸载保留插件数据，复装可继续读取。确认不再需要历史索引与快照后，可手动删除对应数据目录。

## 配置

宿主挂载补丁见 [cordis.patch.yml](./cordis.patch.yml)：

```yaml
- insert:
    - id: session-rollover
      name: '@deepseek-ai/dsh-session-rollover'
      config:
        mode: auto
        threshold: 10
        # forceAuto: false
        # dataDir: 'D:/dsh-data/session-rollover'
```

| 配置 | 默认值 | 说明 |
| --- | --- | --- |
| `mode` | `auto` | `auto` 自动执行；`manual` 达阈值时提示；`off` 跳过自动分卷 |
| `threshold` | `10` | 自动分卷的轮次阈值 |
| `forceAuto` | `false` | `auto` 检出外部 `[Checkpoint N]` / `[Handoff · part N]` 标记后，默认降为 `manual`；设为 `true` 保持自动 |
| `dataDir` | 自动解析 | 显式指定插件数据目录 |

显式手动调用绕过轮次和模式门槛，包括 `mode: off`；只读卷、已封卷、子会话和未收尾工具检查仍然生效。普通系列最多到 `-9`，达到上限后自动分卷停止；手动调用可以建立 `原名（接续 N）` 独立系列，保留到来源卷的链接，此路径不改名或封存来源卷。

## 面板集成

服务端插件注册 `ctx.sessionRollover`，供经过认证的宿主操作桥接调用，例如 `dsh-todo-progress >= 1.1.0` 的面板入口：

```js
const result = await ctx.sessionRollover.rollover(sessionId);
// result.status: 'rolled-over' | 'skipped' | 'failed'
// 成功时 result.newSessionId 指向新卷；其他情况可查看 result.reason。

const info = ctx.sessionRollover.info(sessionId);
// { source: { sessionId, title } | null, handoff: object | null, readonly: boolean }
```

`info()` 返回来源链接、完整交接快照与只读状态。新卷尚无 `todo/write` 事件时，宿主适配器可读取继承的待办快照；出现实时待办事件后以日志为准，包括显式清空的清单。连续手动交接保留父链与尚未被新投影替代的快照。

浏览器端使用 `GET /api-dsh-session-rollover/pending?session=<id>` 获取提示。登录校验交给宿主 `webServer`；取件即删除队列项，接口不提供分卷操作，也不确认浏览器已完成展示。

## 项目结构

```text
index.js                         服务端稳定入口，导出插件类
client.js                        宿主直接加载的浏览器提示脚本
cordis.patch.yml                 宿主挂载补丁
src/
  domain/                        纯业务规则，不访问宿主或文件系统
    cluster-index.mjs            内存簇索引与标题对账
    turns.mjs / mode.mjs         轮次统计、触发与模式规则
    naming.mjs                   卷号解析、命名与冲突处理
    todos.mjs / inflight.mjs     待办及未收尾工具解析
    summary.mjs / handoff.mjs    八段摘要、交接载荷与预算
  application/                   分卷流程
    rollover.mjs                T0–T8 编排、失败补偿与提交
    handoff-message.mjs         首条交接消息排版
  storage/                       文件持久化
    index-store.mjs             数据目录解析与簇索引落盘
    rollover-state.mjs          待清理清单、交接快照、只读标记
    notices.mjs                 提示去重与待投递队列
  server/                        宿主接入
    plugin.mjs                  SessionRolloverPlugin 生命周期与调度
    host-adapter.mjs            公开宿主服务到分卷接口的转换
    notice-route.mjs            提示取件路由注册与响应
  *.mjs                          旧路径兼容转导出入口
test/                           按 domain/application/storage/server/client/package 分类
docs/architecture.md            分层约定、调用流程与维护注意事项
```

新代码直接引用分类目录；原有 `src/assembly.mjs`、`src/cluster.mjs` 等路径继续可用，仅转导出实现。浏览器脚本由宿主模块加载器直接执行，保留根目录入口与单文件形式，无需额外构建。详细设计见 [架构与维护说明](./docs/architecture.md)。

## 数据目录

按以下优先级解析，首个已设置值生效：

1. 配置 `dataDir`。
2. 环境变量 `DSH_ROLLOVER_DATA_DIR`。
3. `<DSH_HOME>/plugin-data/dsh-session-rollover`。
4. `~/.dsh/plugin-data/dsh-session-rollover`。

环境变量的空白值视为未设置。目录不应放进仓库或安装包目录。

| 文件 | 用途 |
| --- | --- |
| `cluster-index.json` | 会话簇七字段记录及 `turn_counts`，同文件原子替换 |
| `handoff-<sessionId>.json` | 交接快照，包含任务文本、待办及来源信息 |
| `readonly-<sessionId>.json` | 单卷只读标记；兼容读取旧版 `readonly-by-rollover.json` |
| `pending-cleanup.json` | 注入或改名失败后遗留的新卷登记，不自动删除宿主会话 |
| `notices.json` | 提示去重键与待投递队列 |
| `plugin.log.jsonl` | 启动、分卷步骤、失败原因和提示投递日志 |

簇索引写盘失败会通过 `degraded` 暴露；各文件分别写入，不提供跨文件原子事务。手动将单卷只读标记的 `readonly` 改为 `false` 可放行继续写入，但已封卷的索引仍会阻止再次分卷。

## 开发与验证

无需安装第三方依赖或执行构建。本轮验证环境为 Node.js **24.22.1**、npm **11.19.1**。

```powershell
npm test
node --test test/server/wiring.test.mjs
npm pack --dry-run
```

`npm test` 通过 Node 内置测试运行器自动发现各分类目录的 `*.test.mjs`。测试覆盖业务规则、失败补偿、手动交接、存储、宿主接线、包导出兼容与浏览器提示；浏览器提示使用 VM 和模拟 DOM，宿主接线使用接口夹具，均不等同于真实 DSH / ds-bot 环境验收。

修改挂载方式或宿主接口后，应在目标宿主复验插件注入、前端加载/提示、工作区及模型继承、Bot 改名语义与旧卷拦截。打包清单只包含入口、源码、挂载补丁、README、维护文档和许可证等发布文件。

## 宿主兼容与已知限制

| 元数据 | 仓库记录 |
| --- | --- |
| `dsh.manifestVersion` | `1` |
| `dsh.verifiedDsh` | `0.2.1-rc.5` |
| `dsBot.min` / `dsBot.verified` | `0.2.6` / `0.2.6` |

这些字段记录此前适配基线，本次结构整理未重新完成真实宿主验收，也不代表其他插件使用的 ds-bot 版本已获兼容验证。宿主升级后需复验注入清单、前端加载入口与改名行为；兼容性未确认时可先改为 `manual`，由人工控制触发。

- 摘要为事件与待办的确定性摘录，不调用模型。Bot 团队会话中，“任务目标”可能取到 `[Bot team setup]` 等系统注入文本；工具参数中的文件路径仅是线索，不证明文件已修改。
- 后台任务只记录句柄与状态，不迁移或恢复执行进程；未收尾工具调用会阻止分卷。
- toast 使用页面第一个 `div[contenteditable="true"]` 上沿定位；出现模态富文本编辑器时可能锚错。普通提示 5 秒、回滚异常 8 秒，会话切换后延迟 300 毫秒取件，视觉样式随宿主主题变化。提示验收结合 DOM 出现/消失与日志，截图仅作归档。
- 索引对账和摘要重试辅助函数已有实现，但主插件未自动调用对账重建，也未接入有次数上限的摘要重试状态机；不要将辅助函数测试视为完整运行时能力。
- 1.0.1 的手动服务与快照是面板联动适配，不表示其他 R3 历史需求已全部实现。

## 许可证

仓库原有 Apache-2.0 许可证见 [LICENSE](./LICENSE)。导入插件源码的原 MIT 许可与版权声明保留在 [LICENSE.upstream](./LICENSE.upstream)。
