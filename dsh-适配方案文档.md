# Paseo 适配 DeepSeek Harness（dsh）

核对日期：2026-11-08。上游依据是 [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) 的 `master`，提交 `fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159`（2026-11-04，合入 `0.2.2-rc.1`）。dsh 仍是开发者预览，Remote 方法和会话事件会变。插件按该提交的源码实现。本机没有启动过 dsh。

## 结论

dsh 以 coding agent 接入 Paseo，和 Claude Code、Codex、Muse Code 同一工作流：布置任务、看它在做什么、中途纠正、检查结果。桌面、手机、网页和 CLI 看到的是同一个 Paseo agent。

实现是内置 provider 插件 `plugins/dsh-provider`，provider id 为 `dsh`。插件先检索这台机器上已经安装的 **DSH NEXT** 和 **DeepSeek Harness 官方客户端**。检索到以后，每一条都给出两个动作，由用户选，不替用户默认启动第二个 Host：

- **用此客户端构建。** 用该安装自带的 Host 入口再起一个 Paseo 拥有的 Host。版本、home、profile 和插件与那个客户端一致。不下载另一份 `@deepseek-ai/dsh`，也不打开第二个窗口。
- **直接使用此客户端。** 连到那个客户端已经在跑的 Host。Paseo 不启动、不重启、不退出它。

控制面仍是该 Host 的 Typert Remote API，也就是 dsh 网页客户端用的那一套。ACP profile 和 `dsh --profile sdk` 的方法表更窄，两种用法都不用它们。

Paseo 的每个客户端都通过 daemon 看同一条时间线。不内嵌 dsh 的窗口。

## 和 Paseo 设计对齐的地方

依据是 `docs/product.md`、`docs/providers.md`、`docs/plugins.md`。

| 设计                                                    | 本方案怎么落地                                                                                                                                                                     |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Agent 是中心。熟悉的界面本身不是需求                    | dsh 的能力接到现有的任务、时间线、权限、命令、模式、子会话、文件和 diff。不为 dsh 在核心里加一套页面                                                                               |
| 低门槛。装好并登录的 agent 打开就能用，用户不必知道插件 | 内置插件，登记在 `packages/server/src/server/plugins/builtin/index.ts`。`status()` 列出检索到的 DSH NEXT 和官方客户端。没装时给出两边的安装说明，不要求手写 `config.json`          |
| 瘦核心，provider 走插件                                 | 协议、进程和事件映射都在 `plugins/dsh-provider`。打包约束不允许内置插件依赖 npm 包，客户端只用 Node 内置的 `fetch` 和 `WebSocket`，加上宿主提供的 `@getpaseo/plugin/*` 和 `zod`    |
| 能力可以按版本长，Paseo 协议保持兼容                    | 不改 `packages/protocol`。插件只广播自己实现了的 provider capability。dsh 升级带来的新事件先以插件时间线条目出现，不造一条核心协议                                                 |
| 自托管、密钥留在用户机器                                | 登录、模型和密钥留在 `$DSH_HOME`。Paseo 不复制 API key，不把 launch token 写入配置或日志                                                                                           |
| 跨设备                                                  | 时间线、权限和命令走 daemon。手机看到的和桌面相同                                                                                                                                  |
| Hub 无人值守失败关闭                                    | 在插件能精确预批准被注入的那一个 Paseo MCP server 及其工具之前，不把 dsh 的审批策略改成 `never`，也不设置 `DSH_PERMISSION_MODE=danger-full-access`                                 |
| 辅助进程可回收                                          | 只有「用此客户端构建」拉起的 Host 由插件记下 pid 并在连接关闭时终止。内置插件不能引用 daemon 的 managed-process registry，所以这份所有权留在插件里。直接使用的客户端不记录、不终止 |

`agents.providers.dsh` 只放覆盖项：`command`、`env`、`enabled`。不要写 `extends`。写了 `extends` 会盖住内置适配器，这是 Muse 已经定下的规则（`docs/plugins.md`）。

## 已安装的客户端

检索在 daemon 所在的机器上做，结果进插件设置，不进 Paseo 核心界面。同一台机器可以同时有多条，全部列出。

| 种类     | 认什么                                                                                                                | 说明                                                                                  |
| -------- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| 官方 CLI | `PATH` 上的 `dsh`，以及 npm 全局前缀里的 `dsh`                                                                        | 官方启动器。`dsh --version` 能读出版本                                                |
| 官方桌面 | 产品名 DeepSeek Harness 的已安装应用：macOS 的应用程序目录和 Launch Services，Windows 的卸载项，Linux 的 desktop 文件 | 官方 Electron 客户端。Host 由应用自己拉起，默认绑 `127.0.0.1` 和系统分配的端口        |
| DSH NEXT | 产品名 DSH NEXT 的已安装应用。Linux 的 desktop 图标名是 `dsh-desktop-next`                                            | 社区客户端，不是 DeepSeek 官方产品。上游同样是 DeepSeek Harness，另外带自己的桌面插件 |

每条记录保存：种类、显示名、版本、应用位置、自带 Host 入口、该客户端实际使用的 home 和 profile。官方 CLI 的 profile 是 `web`，home 是 `$DSH_HOME`（默认 `~/.dsh`）。两个桌面客户端的 profile 是 `desktop`。DSH NEXT 的 home 以它自己的 `desktop-next-location.json` 为准，不另造一个目录。官方 CLI 拒绝启动名为 `desktop` 的 profile，所以桌面安装不能改用 PATH 上的 `dsh web` 冒充。

读不到 Host 入口的安装仍然列出。它不能构建，直接使用仍可以，只要用户有该 Host 的本机登录链接。

### 用此客户端构建

用该安装自己的 Host 入口再起一个进程。官方 CLI 是 `dsh web --no-open --host 127.0.0.1 --port 0`。官方桌面和 DSH NEXT 在应用里能找到 `dsh-desktop-host` 时，用 Electron 的 Node 模式启动该入口，profile 为 `desktop`。profile 和 home 用上面记下的那一对，因此账号、技能、以及装在这个 profile 上的插件会生效。桌面客户端正在开着也照样起这个进程：端口错开，窗口不多开一个。Paseo 拥有这个进程。关掉 Paseo 只停这一代，不退出用户的桌面应用。读不到 Host 入口的安装不能构建。

启动后 stdout 上的根 URL 带一次性 `?token=`。插件只对 `GET /` 或 `/connect` 用它换签名 cookie，随后丢掉 token。cookie 只留在插件进程内存里。`/api` 不接受 query token，也不接受 `Authorization` 头。请求带 loopback `Host`，POST 的 `Content-Type` 是 `application/json`。不把进程绑到 `0.0.0.0`，不放宽 `--trusted-host`。

同一个 Session 已被桌面应用写着时，恢复返回 `session/writer-held`。插件把这句话显示出来，不抢锁，不另建一个空会话冒充原会话。

### 直接使用此客户端

连接用户指定的、已经在听的 Host。Paseo 不拥有这个进程：不启动、不重启、不回收，`session.can_stop_runtime` 对这个 Host 回答 `false`。

授权只来自用户从该客户端界面复制的本机登录链接（`http://127.0.0.1:<port>/?token=…` 或 `/connect?token=…`）。插件立刻换 cookie，链接和 token 不写入设置、日志或时间线。Host 重启后 cookie 失效，设置里要求再贴一次新链接。

这个链接今天从哪来：

- 官方 CLI 的 `dsh web` 会在自己的终端里打印。
- DSH NEXT 默认关闭浏览器访问。用户在桌面设置里打开本地访问之后，设置页给出这条链接。浏览器访问关着时，外部 HTTP 会被拒绝。
- 官方桌面把 token 只交给自己的 Electron 窗口，没有给外部客户端的登录链接。这一行的「直接使用」保持不可用，并写明原因。要用官方桌面里的账号和 `desktop` profile，选「用此客户端构建」。

插件不读另一个进程的标准输出、Electron IPC、cookie 库或诊断包来拿 token。

直接使用时，Paseo 注入的 MCP 只能走该 Host 已经加载的组合。对方的进程不是 Paseo 启动的，不能在连接之后改它的启动参数。这一 Host 上还没有 Paseo MCP 时，设置里说明 Paseo 工具不可用，其余 dsh 能力仍按特性表可用。

### 进程

两种用法连上之后，Remote 调用方式相同。dsh 的 MCP 组合在进程启动时确定。构建出来的 Host 上，Paseo 注入的 HTTP MCP 按「注入的 server 集合 + 进程环境」分进程：相同的共用一个，不同的各起一个。用户装在该 profile 里的 MCP 跟着每个这样的进程走，避免把一个 agent 的 Paseo 工具授权套到另一个 agent 上。直接使用不按这套规则再起进程。

### 会话

`session.create` 使用 Paseo 给出的 cwd、模型和 agent preset。持久化句柄是 dsh 的 `sessionId`，Paseo 原样保存。重新打开时走 dsh 的 resume，并用 `session/follow` 把已有事件放进时间线，`history` 用 `replay`。dsh 不提供的 `session/load` 回放不另做一套。

`session/list` 用于导入。导入一行只调用一次恢复，不再次列举。冷会话的列表不激活 Agent。

子代理用 `session.subsession`：`session.opened` 带 `parentSessionId` 和拉起它的 `toolCallId`，`restoration` 为 `parent`。dsh 对 `origin: subagent` 的所有权围栏保持有效，父会话的归档会挡住子树的下一步。

空闲一小时后 daemon 会问 `session.can_stop_runtime`。还有后台作业、未回答的提问、未结束的子代理或排队输入时回答 `false`。直接使用的 Host 也回答 `false`。构建出来的 Host 上，回答 `true` 只表示这个 dsh Session 可以释放；进程是否退出由同一 Host 上还有没有别的会话决定。

## 特性怎么进 Paseo

原则：dsh Web 客户端能通过 Remote API 或会话事件做到的事，Paseo 用户也能做到。已有 Paseo 表面的，映射到那个表面。没有对应表面的，用插件自己的时间线、composer 设置或命令完成，仍然到达每个已连接的客户端。纯浏览器控件、且没有任何 Remote 方法和会话事件的，不在这套代理里；把它装进当前客户端的 profile，并且它会改代理行为时，行为会跟着出现。

下表是首发就要能操作的映射。事件名来自 session controller 和 SDK 对同一套运行时的描述；实现时以 `fcc0ad46` 上该客户端 profile 的实际 Remote 方法为准，方法改名就改插件，不改 Paseo 协议。

| dsh 能力                                                   | Paseo 表面                                           | 插件行为                                                                                                                                                                 |
| ---------------------------------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 用户消息、附件、图像                                       | `prompt.message`、`prompt.image`                     | `session.prompt`。图像按 dsh 的附件收据提交。只在当前模型声明支持图像时发送                                                                                              |
| 斜杠命令、`/plan`、`/plan off`、`/compact`、用户可调用技能 | `prompt.command`、`session.commands`                 | 命令目录来自 dsh 的 command 服务和 `skills/list`。`session/query` 能识别命令时走它；否则按 dsh 客户端的同一调用发送。技能正文由 dsh 在运行时加载，Paseo 不另存一份       |
| 排队和 steer                                               | `prompt.steer`                                       | 活动回合用 dsh 的队列 steer。停止回合时丢掉还没被读到的 steer                                                                                                            |
| 模型、reasoning effort                                     | catalog、`session.configure`                         | 目录来自 Host 的模型目录。选中值是 provider 加 model。reasoning 用 `thought_level` 那一组；空的 “Provider default” 在界面上用稳定的非空 id，写回 dsh 时还原成省略 effort |
| 权限预设、审批策略、额外目录                               | `session.config` 的 select / toggle                  | 对应 `--permission-mode`、`--approval-policy`、`--add-dir`。默认保持 dsh 的 workspace-write 和询问，不在目录项里改成全开                                                 |
| 工具审批                                                   | `permission`，`kind: "tool"`                         | 允许一次或拒绝。自动接受只选择明确的 allow 动作。没有 allow 动作时继续等用户                                                                                             |
| `exit_plan_mode` 的计划审阅                                | `permission`，`kind: "plan"`                         | 正文是那份 markdown。Approve 离开 plan；Keep planning 把反馈送回去。关掉卡片等于结束这一轮，下一句用户消息开始新请求                                                     |
| 用户提问                                                   | `permission`，`kind: "question"`                     | 选项、多选和自定义输入原样送回。取消映射为 dsh 的 `ASK_CANCELLED`，不合成默认答案                                                                                        |
| plan 模式开关                                              | mode                                                 | 进入和退出用 `/plan` 与 `/plan off`。恢复和 fork 之后读 dsh 记下的状态，不在 Paseo 另存一份                                                                              |
| bash、PowerShell、作业                                     | 时间线工具                                           | 工具参数和输出按完整快照更新。dsh 没有把这些作业做成 ACP terminal，Paseo 不造一个空终端标签。用户在 Paseo 终端里自己跑的命令仍走 Paseo                                   |
| 文件读写和搜索                                             | 时间线工具，工作区 diff                              | 文件落在会话 cwd 里，Paseo 现有的 diff 和文件视图直接读磁盘                                                                                                              |
| todo、goal                                                 | 时间线 todo；goal 的字段对不上时用 `timeline.plugin` | 同一条 id 反复发完整快照                                                                                                                                                 |
| 子代理、agent team                                         | `session.subsession`                                 | 父子会话都在 Paseo 的 subagents 轨道里。子运行时仍归 dsh                                                                                                                 |
| 压缩、token                                                | 时间线 compaction、`session.usage`                   | 回合结束前先把还在转的压缩条收成终态                                                                                                                                     |
| 归档                                                       | `session.archive`、`session.unarchive`               | 调用 dsh 的 Workspace 归档。归档会话的 `agent/pre-step` 会被 dsh 挡住                                                                                                    |
| fork                                                       | 命令加新的 Paseo 会话                                | `session.fork` 产生的新 `sessionId` 成为新 agent 的持久化句柄。不把 fork 伪装成子代理                                                                                    |
| 取消                                                       | `session.interrupt`                                  | 调用会话控制器的 live cancel。不靠杀掉进程来停一轮                                                                                                                       |
| 标题                                                       | `session.opened` 的 title                            | 采用 dsh 的标题投影，包括它自己的 LLM 标题                                                                                                                               |
| Web 搜索和 dsh 账号工具                                    | 时间线工具                                           | 凭据留在 dsh。失败时 `status` 和会话通知写明要在 dsh 里登录                                                                                                              |
| 用户安装在该客户端 profile 上的 dsh 插件                   | 该插件注册的工具、命令、Remote 和事件                | 不在 Paseo 里重写这些插件。新工具走工具时间线；新命令进 `session.commands`                                                                                               |
| Paseo 自己的工具                                           | dsh 的 HTTP MCP                                      | 注入 `/mcp/agents`。SSE 不被 dsh 接受。发现失败时会话不要半开着留下                                                                                                      |
| hooks、`AGENTS.md`、项目技能                               | dsh 运行时                                           | 由 dsh 读取 `$DSH_HOME` 和项目文件。Paseo 不把这些规则再注入一遍系统提示                                                                                                 |

`session.revert.*` 只在 dsh 的检查点或 fork 能按 Paseo 的 conversation / files / both 语义还原时才广播。对不上就不广播，Paseo 会隐藏入口。不做一个只回滚 Paseo 时间线、dsh 日志却还在的假 rewind。

### 新特性不能漏

会话事件解码器对未知类型发一条 `timeline.plugin`：`pluginId` 为 `dsh-provider`，`kind` 为 `dsh-event`，`version` 为 1，`data` 里是原始事件。客户端渲染器显示类型名和格式化后的 JSON，并提供事件里已经带上的动作。这样 dsh 预览期新增的能力在专门映射落地之前仍然可见、可点。专门映射落地后，同一种事件改走上表，不再双写。

插件不解析失败时把原始帧留在诊断里。不丢字段，不把未知字段裁掉之后当成成功。

## 要改的文件

| 文件                                                  | 变化                                                                                                                                                     |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `plugins/dsh-provider/`                               | 新内置插件。`paseo-plugin.json`、`index.server.ts`、`index.client.tsx`、图标、安装检索、构建/直接使用的设置页、Remote 客户端、事件映射、渲染器、夹具测试 |
| `packages/server/src/server/plugins/builtin/index.ts` | 登记 `dsh-provider`                                                                                                                                      |
| `public-docs/supported-providers.md` 与中文对页       | DeepSeek Harness 列为内置 coding agent：装好官方客户端或 DSH NEXT 后，在 Paseo 里选择用该安装构建，或直接使用正在运行的客户端。密钥留在该客户端的 home   |
| `public-docs/dsh.md` 与中文对页                       | 一篇使用说明，对标 `public-docs/muse-code.md`：官方客户端和 DSH NEXT 的差别、两种用法、登录链接、写锁、以及官方桌面为什么不能被外部直接附着              |
| `docs/plugins.md`                                     | 在内置 provider 那段加上 `dsh-provider`，指向使用说明。不把映射表再抄一遍                                                                                |
| 根 `CLAUDE.md` 的 Supported agents                    | 插件可用后加上 DeepSeek Harness                                                                                                                          |

不改：

- `packages/app/src/data/acp-provider-catalog.ts`
- `packages/server` 里的 ACP 客户端
- `packages/protocol`
- `$PASEO_HOME/config.json` 的示例不作为安装步骤

选择存在插件设置里，键是一条安装记录的 id 加上 `build` 或 `attach`。不保存 token、cookie 或带 token 的 URL。用户还没选时，第一次开会话先问，不擅自构建，也不擅自附着。

测试放在插件目录，用录下来的 Remote 帧和假的安装清单。断言覆盖：三种安装都能被认出来、官方桌面的直接使用保持不可用、构建使用该安装自己的入口而不是 PATH 上的另一个 `dsh`、直接使用不把对方进程记入回收、模型写回、审批、计划审阅、提问取消、命令、子会话、未知事件仍出现、`session/writer-held` 失败可见。不跑整库测试。实现后跑 `npm run typecheck`、`npm run lint -- plugins/dsh-provider`，以及该插件自己的 `npx vitest run`。

## 实施顺序

传输从第一步就是所选客户端自己的 Host。后面的步骤只增加映射，不换成 ACP 或 SDK 方法表。

1. 检索官方 CLI、官方桌面和 DSH NEXT。对选中的安装完成「构建」或「直接使用」，并完成 token 换 cookie。`status` 能区分没装、已装但未选择、没登录和已就绪。构建出来的一个 Host 上能创建两个会话。
2. 提示、跟随事件、工具快照、中断、关闭后再开并回放。未知事件以 `dsh-event` 出现。
3. 模型、reasoning、权限预设、工具审批、提问、plan 审阅、命令和技能。
4. steer、todo、goal、压缩、用量、子代理、fork、归档、Paseo MCP。Hub 仍失败关闭，直到精确预批准做完并有测试。
5. 补公开文档和 Supported agents 名单。

第 4 步里任何一项在所选客户端的 Remote 上没有方法，就记在下面的探测记录里，并让对应入口不出现。不改用一个更窄的协议把缺口藏掉。

## 验收

- 未装官方客户端、也未装 DSH NEXT 时，Paseo 显示两边的安装说明，daemon 不挂住。
- 两种都装了时，设置里各有一行，都能分别选择构建或直接使用。官方桌面那一行的直接使用不可用，并写明要改用构建。
- 用选中的客户端构建并登录后，能完成一次改文件的任务，在 Paseo 桌面看到工具和 diff。关掉 Paseo 后，用户原来开着的 DSH NEXT 或官方桌面仍在。
- 对一个已打开本地访问的 DSH NEXT，贴上它给出的登录链接后可以直接使用，期间不新起 Host。
- 同一会话在手机上看到同一条时间线，并能回答一张权限卡。
- `/plan` 能进入，计划卡能批准或退回；`/compact` 和至少一个用户技能能从 composer 调用。
- 工具提问可以作答，也可以取消，dsh 收到的是取消而不是代答。
- 子代理出现在父会话的 subagents 轨道，归 dsh 运行。
- 用户在该客户端 profile 里启用的一个 dsh 工具能在 Paseo 时间线里跑完。
- 用户自己开着的客户端正写着某个 Session 时，Paseo 恢复它会显示 `session/writer-held`。
- 关闭 Paseo 构建出来的 Host 后，不杀掉用户自己的桌面应用，也不杀掉用户自己的 `dsh web`。
- 日志、设置和配置里没有 launch token、登录链接和 API key。

## 附录：在 dsh 里打开本仓库

这不是产品接入。dsh 打开本仓库时已经会读规则：根 `AGENTS.md` 是指向 `CLAUDE.md` 的符号链接，24042 字节；`packages/server` 那份是 6995 字节。两份合计仍低于项目链 65536 字节的预算。`.agents/skills/` 里的 `release-beta` 和 `release-stable` 已在 dsh 的扫描路径上。

若要让维护技能齐，只做这三处：

| 文件                                        | 变化                                                         |
| ------------------------------------------- | ------------------------------------------------------------ |
| `.agents/skills/store-screenshots/SKILL.md` | 从 `.claude/skills/store-screenshots/SKILL.md` 移过来        |
| `.claude/skills/store-screenshots`          | 改成指向 `../../.agents/skills/store-screenshots` 的符号链接 |
| `.gitignore`                                | 增加 `AGENTS.local.md`。现有规则只忽略了 `CLAUDE.local.md`   |

仓库根 `skills/` 是装到用户机器上的 Paseo 产品技能，不放进 `.dsh/skills` 或 `.agents/skills`。dsh 开发本仓库时没有那些 MCP 工具；`paseo-plugin` 的 description 有 583 字符，也会被 dsh 的 500 字符目录上限截断。

## 探测记录

2026-11-08，只读了 `fcc0ad46` 的源码，没有在本机启动 Host。

已核对的调用：

| 调用                                                                                                   | 结果                                                                                                           |
| ------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| `POST /api/session/create`、`prompt`、`cancel`、`selectModel`、`modelCatalog`、`fork`、`list`、`state` | 有。`prompt` 的 `mode` 是 `queue` 或 `steer`                                                                   |
| `session/follow`                                                                                       | 有，走 WebSocket `/api/remote.mux`，打开帧是 `{ type: "open", endpoint: "session/follow", payload: { args } }` |
| `POST /api/skills/list`                                                                                | 有，参数 `{ sessionId }`                                                                                       |
| `POST /api/workspace/archiveSession` 和 `unarchiveSession`                                             | 有                                                                                                             |
| 工具审批                                                                                               | `approval/request` waterfall。回答经 `POST /api/$events/result`，允许值为 `allowed-once`                       |
| 用户提问和计划审阅                                                                                     | `user-questions/request` waterfall。取消是 `ASK_CANCELLED`。计划审阅的 intent 是 `plan-review`                 |
| 子代理                                                                                                 | 列表行带 `origin: "subagent"` 和 `parentSessionId`。`subagent/descriptor` 在子会话日志里，不含父 id            |
| HTTP MCP 注入                                                                                          | 在已读的桌面 Host 启动参数里没有这项参数。插件不注入，入口保持隐藏                                             |
| 官方桌面直接使用                                                                                       | 没有对外登录链接。`ready` 只走 Electron IPC                                                                    |
| DSH NEXT 直接使用                                                                                      | 只有用户打开本地访问后，设置页才给出登录链接                                                                   |

还缺一次真实 Host 上的成功帧和失败帧。上面的方法名不要用 ACP 的结果替换。
