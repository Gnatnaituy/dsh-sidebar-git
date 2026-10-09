# dsh-sidebar-git 设计方案

> DSH（DeepSeek Harness）右侧栏 Git 管理页签 —— 跟随当前会话的仓库，看变更、读 diff、暂存提交、切分支、推拉远端；危险操作分级把守。
>
> 状态：**设计稿 · 待评审**
> 结论先行：它是一个 cordis 双半插件（host 半跑 git / client 半挂在右侧栏），复用 `dsh-sidebar-chat` / `dsh-sidebar-browser` 已验证的全部接入模式，不发明新框架。

---

## 1. 定位

**一句话**：把「改完代码 → stage → commit → push」这条最高频的 git 流程搬进 DSH 右侧栏，让用户**不切走会话页面**就能完成它。

**不是什么**：

- 不是完整 GUI git 客户端（不做 merge 工具、cherry-pick、rebase 交互式编辑、submodule 管理）；
- 不是 git 命令行替身（不做任意命令输入框，见 §7 安全边界）；
- 不重复 harness 已有能力：`@deepseek-ai/dsh-workspace-changes` 已经按「回合」汇总了 agent 的工作区改动（git 快照 diff），本插件按「仓库」视角工作——两者是互补关系，详见 RD-5。

**用户故事（v1 覆盖）**：

1. agent 改了一轮代码，我扫一眼 Files 面板里的变更清单，点开两个文件的 diff 确认，写一句 message，提交，推送 —— 全程右侧栏完成，会话继续在左侧跑。
2. 我自己在编辑器里改了东西，想在 DSH 里看看改了什么、临时切成另一个分支比较一下。
3. 会话跑偏了，我想把某几个未提交的文件丢回去（discard），然后让 agent 重来。

---

## 2. 平台事实（设计的地基）

以下全部在本机 DSH 26.x 环境核实过，设计直接建立在这些事实上：

| # | 事实 | 出处 |
|---|------|------|
| P1 | 插件是 cordis 双半结构：host 半是 cordis 插件（`export const name/inject/apply`），用 `ctx.webServer.register({kind:'prefix', path, handler})` 注册 HTTP 路由；client 半以 `window.__ModuleLoader__.load()` 的 CJS 形式被 serve 到 `/plugins/<name>/client.js`，免构建 | `dsh-sidebar-chat/lib/index.js`、`dsh-token-usage/lib/index.js` |
| P2 | 右侧栏页签注册三件套：`ctx.inject(['sidebarRightTabs'], …)` → `tabs.register({id, kind, priority:'extension', keepMounted, title, guide})` + slots `sidebar.right.pane.tab`（body，slot inject 传入 `sessionId`）+ `sidebar.right.pane.tab.title` | `dsh-sidebar-chat/lib/client.js:2924-2974` |
| P3 | 页签 UI 用外壳内置组件库 `@deepseek-ai/dsh-client-ui-primitives`（平台 seed word，直接 `require`，样式已在页面）；组件库缺失时回退到插件自带的原生元素实现；kit 的 props **没有默认值**，传漏词表会把整个页签打白（slot 运行时会退役抛错的条目） | chat README「原理」「已知边界」 |
| P4 | **外壳给每个会话渲染一份右侧栏**，非当前会话的用 `display:none` 藏着不卸载；`keepMounted` 页签会同时存在多份实例，需要处理（`isOnScreen()` 门卫浮动层） | chat README「原理」（多实例与浮动层一节） |
| P5 | `ctx.subprocess` 是运行子进程的正规通道：`resolveExecutable()` 解析可执行文件、`spawn({argv, cwd, stdio, graceMs, signal})` 显式 argv **无 shell 解释**、scrub 凭据与 `DSH_*` 环境变量、超时与输出字节上限 | `@deepseek-ai/dsh-subprocess` README |
| P6 | `ctx.sessions` 是会话内存 store；`ctx.sessions.get(sessionId).header.cwd` 取会话工作目录（绝对路径、校验过）；subagent/fork 会话没有自己的 cwd 语义 | `@deepseek-ai/dsh-session/lib/index.js:1621`、workspace-changes `eligible()` |
| P7 | harness 自带的 `dsh-workspace-changes` 插件演示了「git 通过 subprocess 执行」的完整范式：macOS 上 `/usr/bin/git` 可能是 Xcode stub（弹安装对话框），要用 `xcode-select -p` 探测；`GIT_CONFIG_COUNT=0`、`GIT_TERMINAL_PROMPT=0`、`GIT_OPTIONAL_LOCKS=0`；私有 `GIT_OBJECT_DIRECTORY` 快照不碰用户仓库 | `dsh-workspace-changes/lib/index.js:982-1010` |
| P8 | 路由不经过 `/api` 的 Host/Origin + 浏览器鉴权栅栏（与三个现存侧边栏插件一致）：同源页面之外读不到（无 CORS），但**本机任意进程可以调用** | chat README「安全与边界」 |
| P9 | 挂载方式：包根 `cordis.patch.yml` 声明 `- insert: {id, name}`，安装即写入 profile 的 `dsh.profile.bundles`；`tools/install-into-profile.mjs` 幂等完成软链 + link: 依赖 + 挂载，`--dry-run` / `--uninstall` 可用；host 半热重载走 profile `hmr` 行的 `root` 列表（**整体覆盖**，要连旧条目一起写） | `dsh-sidebar-chat/cordis.patch.yml`、`tools/install-into-profile.mjs`、README「开发」 |
| P10 | 本机是 Apple Git 2.54，Xcode CLT 已安装（stub 不构成问题，但代码里仍要按 P7 探测，别人的机器未必装了） | 本机 `git --version` |
| P11 | 数据落盘位置惯例：插件私有数据放 `$DSH_HOME/<plugin-name>/`（token-usage 的账本、chat 的会话转录都在这里） | `dsh-token-usage/lib/index.js:102-109` |

---

## 3. 总体架构

```text
┌─ 浏览器（右侧栏「Git」页签，keepMounted） ─────────────────────────────┐
│ lib/client.js（单文件、免构建 CJS，同 chat/browser 的形态）            │
│   tabs.register({kind:'sidebar-git'}) + 两个 slot body/title          │
│   顶栏 ─ 分支选择器 · 分支状态 chips · 刷新                            │
│   页内页签 ─ 变更 | 历史 | Stash                                       │
│   底部输入卡片 ─ 提交信息 + 提交/amend                                 │
│   轮询 /overview；操作后本地乐观更新 + 立即对账                        │
└──────────────────────────┬───────────────────────────────────────────┘
                           │ 同源 fetch（loopback，无 CORS）
┌──────────────────────────▼───────────────────────────────────────────┐
│ host 半 lib/index.js（cordis 插件，inject: webServer·subprocess·sessions）│
│   /dsh-sidebar-git/*   前缀路由（§5.2 路由表）                        │
│   模块分工：                                                           │
│     git.js      执行器：白名单 argv 装配 → ctx.subprocess → 结果归一  │
│     parse.js    解析器（纯函数）：status v2-z / numstat / log / diff   │
│     guard.js    守卫：参数校验、仓库根路径校验、操作分级、危险确认     │
│     queue.js    每仓库一把串行锁（写操作排队，避免 index.lock 竞争）   │
│     binding.js  会话↔仓库绑定缓存 + 手动改绑的持久化                  │
└──────────────────────────┬───────────────────────────────────────────┘
                           │ ctx.subprocess（GIT_TERMINAL_PROMPT=0，
                           │  有界超时/输出，scrub 凭据环境）
                           ▼
                    用户仓库（只经正规 git 命令触碰）
```

**两个关键贯通点**：

- **绑定**：页签 slot 拿到 `sessionId` → host 用 `ctx.sessions.get(id).header.cwd` 取工作目录 → `git rev-parse --show-toplevel` 定位仓库根。会话 cwd 在仓库子目录里也正确（相对路径展示带 `../`，与 workspace-changes 同一套 display 规则）。定位失败 → 页签出「不是 git 仓库」空态，允许手动输入绝对路径改绑（host 校验后持久化到 `$DSH_HOME/dsh-sidebar-git/bindings.json`）。
- **刷新**：client 在页签可见时每 2.5s 轮询 `GET /overview`（status + branch + ahead/behind 一次聚合）；任何写操作成功后立即再拉一次。host 侧不推送（无 SSE/WS），理由见 RD-3。

---

## 4. 核心设计决策

### RD-1 绑定模型：跟随会话，允许可控地改绑

**决策**：默认绑定「当前右侧栏所属会话」的仓库；提供手动改绑。

- 自动绑定覆盖 90% 场景：会话开在哪，就管哪个 repo。即使是 fork 出来的子会话，其 header 继承 cwd（`dsh-session/lib/types/index.js:1081`），也能定位。
- 手动改绑用于「我在这个会话里临时关心另一个 repo」。绑定按 `sessionId → repoPath` 存两处：client 存 localStorage（会话粒度记忆），host 存 `bindings.json`（重启后仍在，且给 smoke 测试用）。改绑必须通过 host 校验（rev-parse 成功 + 非裸仓库）才能生效。
- 页签不新增「多仓库 bookmark」列表 —— 那是工具箱里另一个产品的事，v1 不做。

### RD-2 执行通道：只走白名单 argv，拒绝任意命令

**决策**：host 半不提供「执行任意 git 命令」的路由。每一个操作对应一段**插件源代码里的固定 argv 装配函数**，路由只传结构化参数（路径、分支名、消息文本）。

- 理由：路由没有鉴权栅栏（P8），本机进程可直呼接口。白名单 argv 把暴露面压缩到「能不能构造出危险参数组合」，而这不是接口问题，是§7 的分级确认问题。
- 例外：`-c <key>=<value>` 只允许插件自己写死的一小撮（`core.quotepath=false`、`core.pager=cat`），不接受调用方注入；`git -z` 优先，天然绕开 quotepath 转义。
- 就算未来加「高级」能力，也走「预设模板 + 用户填空」而不是直通 shell（本期不做，写进 §7 不做清单）。

### RD-3 刷新模型：轮询 + 写后对账，不上推送通道

**决策**：client 可见时轮询；host 不维护 SSE。

- 对比 chat 插件需要 SSE 是因为「流式 token 必须及时」；git 状态是低频变化（agent 改一轮文件才变一次轮询可见的量），2.5s 轮询体感上就是「实时」。
- 聚合接口让轮询只打一个请求：`/overview` 一次返回 branch 状态、文件三分组、counts、stash 数与 `rev`（刷新令牌）。后续 diff/log 按需拉。
- host 侧短 TTL 缓存（status 800ms）吸收页签多实例（P4：同一页签每会话一份）与快速切换页签造成的请求风暴；缓存只在「本插件自己的写操作」与「轮询到达」两种路径上失效，不做 fs.watch（git 自身的文件锁多、watch 误报多，成本收益不划算，v2 再看）。

### RD-4 安全分级：T0 读 · T1 保存型写 · T2 破坏型写（双确认）

**决策**：所有路由打上风险等级，写操作按级走 UI 确认链路；`reset --hard` / `clean` 在 v1 **不存在**。

| 级 | 含义 | 操作（v1） | UI 守卫 |
|----|------|-----------|---------|
| T0 | 只读 | overview / status / diff / log / branch 列表 / stash 列表 / repo 信息 | 无 |
| T1 | 保存型 / 可逆 | stage / unstage / `branch create` / `checkout <branch>`（见注）/ `stash push` / commit / `commit --amend` / push（普通 fast-forward）/ pull（固定 `--ff-only`） | 单次点击 + 结果反馈 |
| T2 | 破坏型 / 会丢东西 | discard 指定文件的未暂存改动 / stash pop 或 drop / 删分支（默认 `branch -d`；若 git 因「未合并」拒绝、需要 `-D` 时升级）/ `checkout` 若携带会冲突的本地修改 / `push --force-with-lease` | **两步确认 + 操作预览**（如 discard 必须先看到将被丢弃的 diff） |

注：`checkout <branch>` 在工作树干净时是 T1；`status` 检测到「切换会撞上本地修改」时升级为 T2（预览冲突面）。
`push --force`（不带 lease）与 `push <non-branch refspec>`、`reset --hard`、`clean`：**v1 路由不存在**，要这些请回终端 —— 这是有意的边界（agent 可能正在同一工作区工作，误触破坏型命令的代价是被 agent 的中间产物连带销毁）。

- 双确认的实现：T2 操作先 `POST /ops/prepare`（返回将要执行的 argv 与影响摘要），client 渲染预览（diff / 波及文件列表），用户确认后带一次性 token `POST /ops/confirm`（token 30 秒过期、单次有效）。守卫做在接口层，绕不过：`/ops/confirm` 只接受 prepare 签发过的 token。
- commit message 长度上限（例如 4KB，经 stdin 传入）；分支名先过 `git check-ref-format --branch` 校验；路径参数一律要求是 host 自己吐出去过的相对路径或用户手选的未跟踪文件名（杜绝 `--upload-pack` 之类的参数注入面 —— 参数位置固定，不做用户拼接）。

### RD-5 与 harness 内建能力的关系：分工、不重叠、可联动

- `dsh-workspace-changes`（回合级）：按 turn 汇总「agent 这一轮改了什么」，生命周期随会话（「重启后就没有了」），只读、不写。
- dsh-sidebar-git（仓库级）：按 repo 视角工作，长期状态（分支、远端、历史），有写操作。
- **联动候选（v2）**：Changes 页签顶部加一粒「本回合 (agent)」过滤芯片 —— host 直接调内建 `ctx.workspaceChanges.summary(sessionId, 最近 seq)`，把 turn 改动映射到 status 行并高亮。打一个内建接口就能让 agent 工作 ↔ git 面板贯通起来，是本工具相对通用 git GUI 的最大差异化点，所以列入 v2 而不是砍掉。

### RD-6 范围取舍：hunk 级操作延后

**决策**：v1 stage/unstage/discard 粒度到**文件**；hunk 级（逐块暂存、逐块丢弃、行内编辑）延后到 v2。

- 理由：hunk 交互的 UI 成本高（可选中区域、跨 hunk 消息边界、二进制/换行边界情况）而收益边际递减 —— 大多数「提交一部分」在文件粒度就能完成。文件级先打通全链路（含测试与确认机制），hunk 级复用同一机制再补 UI。

---

## 5. Host 半详细设计

### 5.1 插件身份与服务依赖

```js
export const name = 'dsh-sidebar-git'          // = 包名 = Loader 行名 = client 模块 id
export const inject = ['webServer', 'subprocess', 'sessions']
const ROUTE = '/dsh-sidebar-git'
// 数据目录：$DSH_HOME/dsh-sidebar-git/{bindings.json, cache/}
// git 可执行：ctx.subprocess.resolveExecutable('git') 一次解析 + Xcode stub 探测（P7）
```

缺失依赖的降级：`sessions` 不在（理论不可能）→ 只能手改绑；git 不在 → 页签空态给「本机没有 git」指引；Xcode stub → 同 workspace-changes 用 `xcode-select -p` 判定。

### 5.2 路由表

| 方法+路径 | 参数 | 返回 | 级 |
|-----------|------|------|----|
| GET `/repo` | `sessionId?` | `{repo: {root, display, isSubmodule?}, binding: 'session' \| 'manual', git: {version, available}, branch: {name, upstream, ahead, behind, detached?}, counts} 或 {repo: null, reason}` | T0 |
| GET `/overview` | `sessionId?` | `/repo` 内容 + `files: [{path, display, xy, staged:{adds,dels,binary?}, worktree:{...}, renamedFrom?, conflict?}...]` 三分组 + `stashes: n` + `rev`（该仓库刷新令牌） | T0 |
| GET `/diff` | `path, area: staged\|worktree, commit?: hash` | `{path, binary?, oversized?, hunks: [{oldStart, oldLines, newStart, newLines, header, lines: [{t, s}]}]}`（`t` 为行类型：`+` 增 / `-` 删 / 空格 上下文 / `\` 说明行；`s` 为行文本） | T0 |
| GET `/log` | `limit=50&offset=0&path?` | `{commits: [{hash, short, subject, body?, author, dateISO, refs: [...], filesCount?}], done}`（`path` 给文件历史） | T0 |
| GET `/branches` | – | `{current, branches: [{name, isLocal, upstream, ahead, behind, tip: {short, subject, dateISO, unpushed?}}]}` | T0 |
| POST `/stage` `{paths: [...]}` / POST `/unstage` `{paths}` | paths 为接口吐过的相对路径 | per-path 结果 | T1 |
| POST `/discard` `prepare/confirm` 两步 | `{paths: [...]}`（未暂存改动） | 丢弃预览 → 执行结果 | T2 |
| POST `/commit` `{message, amend?}` | 消息文本 | `{hash, short, branch, subject}` | T1 |
| POST `/branch` `{action: create\|checkout\|delete, name, force?: never}` | name | 结果 / 删除走 prepare-confirm | T1/T2 |
| POST `/push` `{remote?, branch?, setUpstream?}` | 默认 upstream | `{ok, updates}`，失败带分类错误 | T1 |
| POST `/pull` `{remote?, branch?: --ff-only 固定}` | – | 同上；建议默认 `--ff-only`，非 ff 直接失败并提示「需要 merge/rebase，请到终端」，v1 不自动 merge | T1 |
| POST `/stash` `{action: push\|pop\|apply\|drop\|list}` | index/消息 | push 走 T1，pop/apply/drop 走 prepare-confirm | T1/T2 |
| POST `/binding` `{repoPath}`（手动改绑） | 绝对路径 | 校验后持久化 | T1 |

约定：所有响应包一层 `{ok, ...}`；错误 `{ok:false, error:{code, message, hint?}}`。写路由统一要求 body `< 256KB`，JSON only。

### 5.3 git 命令映射（argv 白名单的源码形态）

| 操作 | argv（关键部分） |
|------|-----------------|
| 定位仓库 | `rev-parse --show-toplevel --is-inside-work-tree --absolute-git-dir` |
| 状态 | `status --porcelain=v2 -z --branch --untracked-files=normal` |
| 暂存量 | `diff --numstat -z --cached` 与 `diff --numstat -z` |
| diff | `diff {--cached,} --no-color -U3 -- <path>`（大文件/二进制按字节上限判定 oversized，同 workspace-changes 的 `maxFileBytes` 思路；rename 展示列为 v2） |
| 历史 | `log --no-color --date=iso-strict --format=<NUL 分隔字段>`（以 `%x00` 作字段分隔；`--max-count` + `--skip` 分页） |
| 提交 | `commit -F -`（message 经 stdin，绕开 argv 转义与注入；不带 `--only`，暂存区即全部内容） |
| amend | `commit --amend -F - --no-edit`（不改 message 时） 或同上带消息 |
| push | `push --verbose [upstream]`（无 force 通道） |
| pull | `pull --ff-only` |
| stash | `stash list --format=…` / `stash push [-m] [-- <paths>]` / `stash pop` / `stash drop` |
| 分支 | `branch --format=… -vv --sort=-committerdate`（列表）；`checkout <name>`（切换前先 status 探冲突）；`branch <name>`（创建）；`branch -d <name>`（删除，只允许 `-d`，大写 `-D` 走 prepare-confirm 单独模板） |
| 校验分支名 | `check-ref-format --branch <name>` |

统一注入的稳定性环境（写死在执行器，逐条对应 P7 的经验）：`GIT_TERMINAL_PROMPT=0`（远端要凭据交互时立即失败并被分类为 `AUTH_FAILED`）、`GIT_OPTIONAL_LOCKS=0`、`GIT_PAGER=cat`、`GIT_EDITOR=:`、`LC_ALL=C.UTF-8`、`GIT_CONFIG_COUNT=0`（隔离 ambient indexed config）；凭据完全交给用户自己的 git 配置 + credential helper，插件不碰。

### 5.4 解析层（parse.js，全部纯函数、可单测）

- `status`：porcelain v2 `-z` → 文件条目（XY 码）、分支行（head/ahead/behind）、未合并子状态；`X/Y` 直接映射 UI 徽标；`??`、`!!`（被忽略，默认不列）单独组。
- `numstat`：`-z` → `{adds, dels, binary}`；rename 场景按 `orig=>new` 拆两半。
- `log`：`--format` 以 `%x00` 分隔字段（hash、short、parents、subject、body、author name、author email、committer date、refs），无歧义拆行。
- `diff`：unified 输出 → hunk 结构（见路由表）；`binary files differ` 与超字节上限的侧标 oversized。diff 不做 rename 复杂展示（`--no-renames`），v2 再评。

### 5.5 并发与资源约束

- 每仓库串行队列（queue.js）：写操作排队；读操作可并发但共享同一个 status 缓存。
- 每条命令超时 15s（diff/log 30s）、输出上限 8MB（对齐 workspace-changes 量级）；`done` 超时 → 杀进程树，返回 `GIT_TIMEOUT`。
- `index.lock` 冲突：git 自报错误码 `LockFileError`，接口如实返回 hint（「另一个 git 进程正在写，稍后再试」）—— 不做自动删锁，那是诊断手段而不是本工具该做的事。

### 5.6 错误分类表（error code → UI 表现）

| code | 触发 | hint 方向 |
|------|------|----------|
| `GIT_MISSING` / `GIT_XCODE_STUB` | 无 git / stub | 引导装 CLT |
| `NO_REPO` | cwd 无仓库、裸仓库、worktree 关联异常 | 空态 + 手动改绑 |
| `GIT_TIMEOUT` | 超时杀掉 | 「仓库过大/网络慢，稍后重试」 |
| `LOCKED` | index.lock | 等待重试 |
| `NOT_FAST_FORWARD` | pull 非 ff | 提示去终端 merge/rebase |
| `AUTH_FAILED` | push/pull 凭据失败（`GIT_TERMINAL_PROMPT=0` 下凭据助手无法弹交互） | 「到终端确认该 remote 的凭据助手」 |
| `BRANCH_EXISTS` / `BRANCH_INVALID` | 分支操作 | 修正名称 |
| `DIRTY_WORKTREE_CONFLICT` | checkout 会撞本地改 | 升级 T2 预览 |
| `UNMERGED` | 有冲突时 commit/checkout | 列出冲突文件 + 建议流程 |
| `NOTHING_TO_COMMIT` | commit 空 | 提示 stage |
| `PUSH_REJECTED` | 远端领先（stale） | 提示先 pull --ff-only |
| `PATH_INVALID` | 路径逃逸/不存在 | 不显示（只可能来自异常调用方） |
| `CONFIRM_REQUIRED` / `CONFIRM_INVALID` | 守卫拒绝 | UI 引导 |

---

## 6. Client 半详细设计

### 6.1 注册面（对齐 chat 的三件套，P2/P4 全按它的经验走）

```js
window.__ModuleLoader__.load({ id: 'dsh-sidebar-git', factory: (require) => { … } })
TYPE_ID = 'dsh-sidebar-git/panel'; KIND = 'sidebar-git'; ROUTE = '/dsh-sidebar-git'
tabs.register({ id: TYPE_ID, kind: KIND, priority: 'extension',
                keepMounted: true, title: () => 'Git',
                guide: [{id:'git', order: 44, title: () => 'Git',
                         description: () => '跟随当前会话仓库的变更、提交与分支',
                         icon: (p) => renderIcon(ui.icons.list, …)}] })
slots.inject('sidebar.right.pane.tab',      () => slots.register({name, key: TYPE_ID, inject: (sessionId)=>({sessionId})}, GitBody))
slots.inject('sidebar.right.pane.tab.title',() => slots.register({name, key: TYPE_ID}, GitTitle))
```

- `keepMounted: true`：status 轮询的内存状态（展开的 diff、滚动位置）不该因切走页签而丢。
- 多实例（P4）：轮询与操作结果按 `sessionId` 收敛到全局 store（每仓库一份 `RepoState`）；浮动菜单照 chat 用 `isOnScreen()` 门卫（隐藏实例不画浮层）。
- 组件库缺失 → `fallbackUi` 等价原生实现（chat 的成熟套路原样搬）。
- 图标策略：组件 kit 的图标词表是固定的小集合（chat 列过：`chat/plus/list/close/refresh/warning/check/copy/…`），**git 领域图标（分支、提交、stash）不在其中** —— 插件按 chat 自带鲸鱼 logo 的同一做法，把领域 glyph 的几何 path 自带一份作兜底，kit 有近似图标时用 kit。

### 6.2 页签布局（宽约 480px，随侧栏可窄）

```text
┌──────────────────────────────────────────────┐
│ 🌿 main  ↑1 ↓2   [ ⌄ ]               ⟳     │ 顶栏：分支+状态 chips+分支菜单+刷新
├──────────────────────────────────────────────┤
│   [ 变更 ]  [ 历史 ]  [ Stash 2 ]            │ 页内页签（下划线选中态，token 色）
├──────────────────────────────────────────────┤
│ 已暂存 (2)                                    │ 分组标题（次级灰小字）
│  M lib/git.js        +12 −3        [−]  ▸   │ 行：徽标/路径/numstat/取消暂存/展开
│  A lib/queue.js       +40           [−]  ▸   │
│ 未暂存 (3)                                    │
│  M lib/index.js       +5 −2     [+] ✕ ▸     │ stage / discard(确认) / 展开diff
│  D old/lib.js          −18        [+] ▸     │
│  ?? notes.md          未跟踪     [+]         │
│ （点击任一行 → 该文件 diff 就地展开，可折叠） │
├──────────────────────────────────────────────┤
│ ┌──────────────────────────────────────┐    │
│ │ 提交信息（2 项已暂存）                 │    │ 底部输入卡片（24px 圆角，同聊天卡片）
│ └──────────────────────────────────────┘    │
│  [ ] amend 上一次提交        [ 提交 → ]     │ 品牌蓝实体键；未暂存项时禁用+原因
└──────────────────────────────────────────────┘
```

- **行内 diff 展开区**：等宽小字，`+-` 行底色用 token（若无则插件轻量兜底色）；二进制/超大显示为占位说明与提示语。展开的 diff 若轮询发现 `rev` 变了，行头顶部加暗淡的「内容已变化，点击刷新」条（不自动改写正在被人看的 diff）。
- **冲突态整页 banner**：`UNMERGED` 时页签顶部出现顾问条（列出冲突文件 + 「建议：到终端解决，或让 agent 处理」），提交按钮禁用并说明原因。v1 不做合并 UI。
- **detached HEAD / 空仓库**：分支 chip 显示 `detached@c0ffee` / `（空仓库，无提交）`，动作为只读 + 提示。
- **History 页签**：时间倒序列表（hash 色块短 id、subject、相对时间、behind/upstream 徽标）；点击行展开 commit 详情（改了哪些文件 + numstat + 每文件 diff，走 `GET /diff?commit=`）；行内动作：复制 hash（T0）、切换到此分支（T1，dirty 冲突升级 T2）。「reset 到此提交」「revert」「checkout 单个文件的历史版本」属破坏型且 v1 路由不收录，见 §7。
- **Stash 页签**：列表 + `pop/apply/drop`（pop/apply/drop 全部 T2 两步确认，预览受影响文件名即可）。
- **键盘**：`↑/↓` 选行、`Enter` 展开/收起 diff、`Esc` 收起展开区或关闭确认弹层；不做命令面板（保持轻量）。
- **空态**：
  - 非 git 目录：图标 + 「当前会话目录不在 git 仓库里」+ 手动改绑入口（路径输入 + 校验反馈）；
  - 无 git：装 CLT 提示；
  - 干净仓库：一行「工作区干净」，总好过空白。

### 6.3 状态与数据流（client 侧）

```text
GitStore (per sessionId)
  ├ repo / branch / files / stashes / rev     ← 2.5s 轮询 /overview（页签可见才轮询）
  ├ pendingOps (Map opId → 状态)              ← 乐观行级更新，成功即清，失败回滚+红点
  ├ confirmations (T2 状态机)                 ← prepare → 预览 → confirm（30s token）
  └ diffs (path+area → 缓存)                  ← 展开/收起不重新请求，rev 变更置脏
```

- 轮询对多实例只发一份：store 以 `repoRoot` 为键，隐藏实例不再各拉一遍（P4 多实例共享）。
- 乐观更新只在 T1（stage/unstage/commit）上做：本地把行搬组，200ms 内对账，不一致以服务器为准 —— 给「秒回的即视感」又不藏真相。

### 6.4 样式策略

- 优先向 shell 要 token（P3 同款做法）；插件自己的 `--dsh-sg-*` 变量只在 token 缺席时兜底字面值；深色/字号跟着应用走。所有浮动层 portal 到 body + `isOnScreen()`（照抄 chat 的成熟方案）。样式单挂 `id='dsh-sidebar-git-style'`，reload 替换不叠加。

---

## 7. 安全与边界

**接入面**（如实陈述，与现存三个插件同界）：

- 路由无鉴权栅栏（P8）：本机进程可调。缓解靠白名单 argv（RD-2）—— 即使直呼接口，也**做不了插件源码之外的事**；T2 高危操作即使攻击者也必须先 prepare→confirm，token 30 秒且一次性。
- 凭据隔离：插件不读、不存、不传任何凭据 —— 推拉借用用户 git 自己的 credential helper；`AUTH_FAILED` 提示回终端处理。
- 工作区协作：agent 与本工具的并发冲突无法完全消除（这正是 git 的常态），设计上的处理是「一切以实时 status 为准 + 写操作串行 + 冲突显式呈现」，不假装原子性。

**v1 明确不做**（这个清单本身就是产品边界）：

- 任意 git 命令输入框、shell 拼接、参数模板注入；
- `reset --hard`、`clean`、`push --force`（非 lease）、`cherry-pick`、`rebase`、merge 冲突解决 UI；
- submodule 内容操作（gitlink 行如实展示为子仓库指针）；
- 大仓库的自动全量 `fetch` / 定时后台任务（只在用户显式 push/pull 时动网络）；
- 凭据/SSH 的任何配置管理。

---

## 8. 测试策略（对齐 chat 的两层 + smoke）

| 层 | 覆盖 |
|----|------|
| `node --test test/core.test.mjs` | host 纯逻辑：argv 装配的正确性与**白名单完备性**（枚举冲突参数组合如 `--force` 不可达）、porcelain v2/numstat/log/diff 解析（含二进制、rename、中文路径/-z）、路径逃逸拒绝、T2 prepare/confirm token 生命周期、错误分类、绑定校验 |
| `test/client.test.mjs` | `node:vm` + 桩 React（可注入 fetch，照 chat 的成熟做法）：注册三件套、空态/带文件/冲突/detached 四种渲染、T1/T2 交互链路（含「confirm token 过期」）、轮询门卫（隐藏实例不轮询）、kit 与 fallback 双路径、样式关键值锁（徽标用 token、输入卡片 24px 圆角） |
| `tools/smoke.mjs` | 对运行中的 harness 打真接口：自建临时 fixture repo（`/tmp`，内嵌一个 `file://` 裸仓库当 remote，**全程无网络**）→ 初始化/添加/提交/分支/checkout/push 到 file remote/pull/stash/discard，最后自删；顺带断言白名单路由拒绝畸形路径 |

验收门：三层全绿 + 每个写路由至少一条「越权参数被拒」的边界断言。

## 9. 里程碑（可独立交付，每步都能在真环境用）

| 里程碑 | 内容 | 验收 |
|--------|------|------|
| **M0 骨架**（0.5 天） | 包结构 + cordis.patch.yml + install 脚本（改自 chat 模板）+ 页签注册（空 UI）+ `GET /repo` 绑定链路 + profile 挂载 | 页签出现在右侧栏「＋」，能显示当前会话绑定到的仓库路径 |
| **M1 只读核心**（1.5 天） | status/diff/log/branches 全量路由 + 解析层 + 变更/历史两个页签 + 行内 diff + 轮询 | 能完整看仓库状态与历史，agent 改文件后几秒内可见 |
| **M2 写操作**（1.5 天） | stage/unstage/commit(+amend)/discard + T2 prepare-confirm 机制 + 冲突/detached/空仓库三态 | UI 里可完成一次完整提交（含 discard），核心测试与 chrome 兼容 |
| **M3 分支与远端**（1.5 天） | 分支菜单（创建/切换/删除）、push/pull、stash、手动改绑、auth/ff 失败分类提示 | UI 里分支操作与 file-remote push/pull 畅通 |
| **M4 打磨发布**（1 天） | 错误码全覆盖、README（含安全与边界章节）、资源构建的静态预览图、install/uninstall 复跑 | 三套测试全绿，README 按 chat 的信息密度成文 |

> 工期按 chat 插件同类工作的实际节奏估（一人连续投入）。

- **开发环境便利**（照抄 chat 的既有做法）：先把本包加入 profile `hmr` 的 `root` 列表（**整体覆盖**，连 browser/chat 条目一起写），host 半改完秒级重挂；client 半由模块系统按 revision 重取，刷新页面即可。

---

## 10. 风险与待拍板的问题

| # | 问题 | 我的默认建议 | 影响 |
|---|------|-------------|------|
| Q1 | `pull` 默认策略：`--ff-only`（失败即提示去终端，不自动 merge）够不够？ | 够 —— 自动 merge/rebase 会把冲突处理塞进一个没有合并 UI 的侧栏里 | 低 |
| Q2 | amend 是否放开？ | 放开，但 `upstream 有此提交` 时给黄条警告（服务端 fetch upstream 判断失败时降级为提示） | 低 |
| Q3 | 「本回合 agent 改动」联动芯片（RD-5）要不要进 v1？ | 进 v2：先把内建接口调用探明（`ctx.workspaceChanges.summary` 服务名与 seq 语义），避免被内建演进卡进度 | 中 |
| Q4 | discard 要不要「清掉所有未暂存改动」的兜底全清按钮？ | 不做按钮，只做按文件 discard（想全清的人一定有终端） | 低 |
| Q5 | 侧栏宽度下 diff 的行宽策略（横向滚动 vs 自动换行）？ | 默认自动换行（等宽小字），提供关闭开关；关闭后允许横向滚动而不是静默裁切 | 低 |
| Q6 | 历史/入口要不要在会话切换时清残留视图？ | 按 sessionId 缓存隔离，切回来还能看见当时的 diff，但顶部提示「仓库状态可能已过时，点击刷新」 | 中 |

主要技术风险两条：

1. **P4 多实例 + 全局 store 的正确性**（chat 里踩过浮动层的坑）：收敛规则已在 6.3 写死，客户端测试里有专案断言；
2. **agent 与用户的 index 竞争**：git 的锁机制是安全网，本插件排队 + 如实呈现 LOCKED，不发明跨进程协调。
