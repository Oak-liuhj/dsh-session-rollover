# dsh-session-rollover

解决"一个会话聊到几万 token 越来越笨"的问题—按用户轮次自动把长会话"分卷"，像书一样分成第 1 卷、第 2 卷，旧卷留档、新卷带着交接摘要继续干。

会话分卷接续（R3）。按接口契约 v0.2 实现：轮次计数、八段交接摘要、`-N` 分卷命名、簇索引、只读回溯。旁挂实现，不改宿主。

## 它是什么
- **轮次计数**：统计会话里的用户消息轮次（默认阈值 10 轮，`threshold` 可配）。
- **分卷**：到阈值且 `mode=auto` 时，把当前会话改成 `<原名>-1`，新建 `<原名>-2` 并把八段交接摘要作为首条消息注入，接着上一轮把「第 X 步」写进摘要的 Current Work 段。
- **改名链路**：Bot 会话一律走 ds-bot rename（`ctx.sessionTitle.rename`），不直接改元数据；新建会话失败时把原会话名回滚回原名。
- **只读回溯**：`-1` 卷对用户只读呈现，避免在旧卷继续写导致断簇。
- **簇索引**：`cluster_id` / `parent_session_id` / `vol_no` 等 7 字段只落插件自有数据目录，不进工作区、不进发布包。

## 配置
`cordis.patch.yml` 里一条 insert：

```yaml
- insert:
    - id: session-rollover
      name: '@deepseek-ai/dsh-session-rollover'
      config:
        mode: auto        # auto | manual | off
        threshold: 10     # 轮次阈值
```

`dataDir` 留空时自动落到 `<DSH_HOME>/plugin-data/dsh-session-rollover`——在包目录之外，因此升级或重装 npm 包不会重置簇索引。

## 安装 / 卸载
```
dsh plugin --profile <name> add <本目录>
dsh plugin --profile <name> remove @deepseek-ai/dsh-session-rollover
```
卸载不删数据目录（簇索引与日志留着，便于复装后续上簇）；要彻底清理时手动删除上面那个 `plugin-data` 子目录。

## 版本边界
当前发布版 `1.0.0`（装机包以 `package.json` 为准）。包名 `@deepseek-ai/dsh-session-rollover` 沿用宿主官方 scope，**只作内部安装包**，本版不提交公共 npm。

两个版本字段指向不同层：
- `dsh.verifiedDsh = 0.2.1-rc.5`：dsh 运行时（`dsh --version` 实测 `0.2.1-rc.5`）。
- `dsBot.min 0.2.6` / `dsBot.verified 0.2.6`：ds-bot 桌面壳；**本插件取证跑在 0.2.6，不与 todo-progress 的 0.2.7 互相背书**。

`dsh.manifestVersion = 1`。宿主 minor 升级须复验三件事：注入清单、插槽名存活、Bot 会话改名语义；不过则把 `mode` 降到 `manual`。

## 已知限制（发布说明）
1. **告警验收口径（B6）**：分卷告警以一次性 toast 提示呈现，验收以 toast 的 DOM 出现/消失读数与 `plugin.log.jsonl` 日志读数为准；界面截图仅作归档，不构成像素级验收判据。toast 展示时长（普通 5s、回滚异常 8s）按实现值，视觉样式随宿主主题浮动。
2. **M3 观察项**：Bot 团队会话中，分卷交接摘要的「任务目标」段可能取到系统文本（如 `[Bot team setup]`）而非会话标题；八段结构与「待办」逐项一致性判据不受影响。内容质量复核与修正排 1.0.0 之后。
3. **R-33 已知锚点限制**：toast 定位以页面第一个 `div[contenteditable]` 元素上沿为锚；宿主页面若未来引入模态内富文本编辑器，存在锚错元素的可能。修正方案（`querySelectorAll` 取 `rect.bottom` 最大者）已排 M4 末尾随下次重冻搭车实施。

## 开发
```
node test/core.test.mjs
node test/assembly.test.mjs
node test/wiring.test.mjs
node test/inflight.test.mjs
node test/todos.test.mjs
node test/notices.test.mjs
node test/client-toast.test.mjs
```
零第三方依赖、零网络请求；日志落 `plugin.log.jsonl`（同数据目录），告警落 `notices.json`（取件即删，同一会话同一原因只提示一次）。

## 许可证

本仓库原有 Apache-2.0 许可证保留在 `LICENSE`。本次导入的插件源码来自原 MIT 许可源码仓库，原始许可与版权声明保留在 `LICENSE.upstream`。
