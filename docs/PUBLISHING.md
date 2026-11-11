# 发布与升级指南

公开包名为 `dsh-session-rollover`，版本 1.1.1，维护者 Oak-liuhj。仓库：[Oak-liuhj/dsh-session-rollover](https://github.com/Oak-liuhj/dsh-session-rollover)。支持在宿主中直接填写 npm 包名安装；维护者需将实际发布包上传到 npm 官方注册表，市场收录不代替 npm 发布。

## 构建与打包

```powershell
npm test
npm run check:release
npm pack --pack-destination D:/release
```

`prepack` 构建并核对清单、挂载补丁、ModuleLoader 包名、双语说明、图标和截图。GitHub 源安装依赖已提交的 `client.js`，不运行 prepare 或安装时构建。包无第三方运行时依赖。除静态检查外，还应解压实际 tgz 并验证入口、兼容导出及资源是否齐全。

## 发布到 npm

1. 使用有权维护此包的 npm 账号登录。浏览器登录与双重验证由账号持有人完成，不将密码、验证码或令牌写入仓库。
2. 完成上述测试、发布校验和打包，审核 tgz 文件清单；首次发布前确认包名可用。
3. 发布审核通过的同一个 tgz，避免检查后重新打包产生不同内容：

```powershell
npm login --auth-type=web --registry=https://registry.npmjs.org/
npm whoami --registry=https://registry.npmjs.org/
npm publish "D:/release/dsh-session-rollover-1.1.1.tgz" --access public --registry=https://registry.npmjs.org/
npm view dsh-session-rollover@1.1.1 version dist.integrity --registry=https://registry.npmjs.org/
```

4. 在隔离目录从 npm 安装并核对包名、版本、挂载补丁、预构建客户端与模块导入；只有 npm 返回该版本且下载验证通过，才确认包名安装可用。
5. 国内 npm 镜像同步可能晚于官方源。若官方源可安装而镜像返回 404，应等待镜像同步或使用 GitHub 安装源。

`publishConfig.registry` 固定为 npm 官方源；公开包名为 `dsh-session-rollover`。npm 已发布的同一版本不能覆盖，后续发布需先提升版本号。认证和双重验证失败时保留待发布包，完成认证后继续发布，不绕过验证。

### 已进入暂存区时

使用支持 `npm stage` 的 CLI，先查询已有暂存记录，再确认同一个包：

```powershell
npm stage list dsh-session-rollover --json --registry=https://registry.npmjs.org/
npm stage view <stage-id> --json --registry=https://registry.npmjs.org/
npm stage approve <stage-id> --registry=https://registry.npmjs.org/
```

核对版本、`latest` 标签和 shasum 与已审核 tgz 一致。`staged` 仅表示待审批，同一暂存版本不能再次普通发布；保留原 tgz 和 stage id，完成审批后再执行下载与隔离安装验证。首次暂存可能产生 `0.0.0-stage` 占位版本，不能以包名可查询作为正式版本发布成功的依据。

CLI 登录授权、注册安全密钥和本次发布的本人认证是不同步骤。账号已启用 2FA 但审批仍要求配置时，先核对账号状态并尝试全新登录，不反复注册密钥；认证 URL 失效也不代表 tgz 丢失。若全新登录后问题仍存在，保存不含凭据的错误、时间和 stage id，向 [npm 支持](https://www.npmjs.com/support)反馈。不要通过关闭 2FA 或创建绕过认证的令牌处理审批异常。

认证请求有有效期，应在本人准备好设备验证后再启动命令，并让 npm 直接打开系统浏览器。不要先生成地址再等待聊天确认；手工打开时核对完整地址，避免回调参数混入中文标点或正文。有效期已过时重新运行原审批命令，不复用旧地址。

## 从 scoped 旧包迁移

1. 记录真实运行的 profile，桌面通常是 `~/.dsh/profiles/desktop`。备份该 profile 的 package.json、锁文件、Cordis 配置和旧插件目录，并备份 `<DSH_HOME>/plugin-data/dsh-session-rollover`；自定义 dataDir 也需备份。
2. 通过桌面插件管理器/宿主支持的依赖管理渠道，将 `@deepseek-ai/dsh-session-rollover` 替换为新包。CLI 可使用 `dsh plugin --profile desktop remove @deepseek-ai/dsh-session-rollover`，然后 `dsh plugin --profile desktop add <本地tgz或GitHub源>`。分步操作时先停止宿主，避免短暂缺包。
3. profile 的 `dsh.profile.bundles` 只保留新包一次；显式 Cordis 节点的 `name` 改为新包名，原 `id: session-rollover`、用户配置值和相邻插件保留。不可同时加载两个包来注册同一个服务。不能只覆盖 node_modules 而保留过期依赖来源。
4. 从桌面客户端重启实际宿主；不要用普通 Web profile 的重启操作接管桌面生命周期。
5. 核实已加载 1.1.1、面板图标/简介、会话 `⋯ → 使用说明`、旧卷快照和只读状态。不要为了安装验证向生产会话发送测试消息。

本次更名不迁移数据；数据目录、`sessionRollover`、HTTP 路由、Cordis id 和旧 `src/*` 导出保持兼容。卸载也不删除数据。回滚时停止宿主，恢复备份的 profile 配置、锁文件和依赖，再重启；不要覆盖更新后已产生的用户数据。

## 市场展示

| 资源 | 作用 |
| --- | --- |
| package.json | 包名、版本、作者、仓库、兼容声明和 PNG 图标 |
| locale/zh.json、locale/en.json | 插件面板的标题、简介及 meta.detail 路径 |
| docs/DETAIL.zh-CN.md、docs/DETAIL.md | 中英文功能、入口、配置、数据和限制说明 |
| assets/icon.png | 方形市场卡图；SVG 仅作可维护源文件 |
| screenshots.json | 1–8 张仓库内图片；宿主截图来自隔离夹具，未使用用户生产会话 |
| marketplace/*.yml | 待提交市场目录的唯一条目 |

旧宿主可能只显示标题/简介/图标，不支持 meta.detail；会话菜单内置指南补足入口。截图中的右侧实时任务面板由独立的可选 R2 插件提供。截图是本地模型夹具演示，不证明生产模型效果。

## 外部发布顺序

1. 审核本地改动、验证记录与实际包；确认没有凭据、会话数据或机器配置进入包。
2. 将代码及预构建 client.js 推送至公开仓库；如使用 tag / Release，确保引用同一版本的完整资源。需要支持 npm 包名安装时，再按上文完成 npm 发布与下载验证。
3. 等仓库创建满一天并确保 topic 为 `dsh-plugin`。按 [投稿材料](../marketplace/SUBMISSION.md) 向官方插件目录发起 PR。
4. 确认市场抓取后的简介、图标、截图及安装源正确；外部收录前不要宣称已上架。

`engines.dsh` 保持已验证的 `0.2.1-rc.5`，不推测扩大兼容区间。许可证声明为 `(Apache-2.0 AND MIT)`，必须同时分发 LICENSE、LICENSE.upstream 和 NOTICE。
