# dsh-sidebar-git

DSH（DeepSeek Harness）动态插件：**右侧栏里的一个 Git 页签**。跟随当前会话的仓库，看变更与 diff、暂存提交、切分支、推拉远端——整个「改完代码 → stage → commit → push」流程不离开会话页面。

<img src="assets/screenshot-1.png" width="330" alt="Git 页签：顶部分支 chip 与 ahead/behind 徽标，变更页签里三组文件行与底部提交卡片"> <img src="assets/screenshot-2.png" width="330" alt="点击行展开的 diff 视图：hunk 头、增删行着色"> <img src="assets/screenshot-3.png" width="330" alt="手动绑定空态：当会话不在仓库时的路径绑定表单">

它与 harness 内建的 `workspace-changes`（按回合汇总 agent 工作区改动的只读快照）分工互补：那是「这一轮 agent 改了什么」，这里是「仓库整体的长期状态分支、远端、历史」，并且带写操作。

## 特性

| 特性 | 说明 |
|---|---|
| 原生右侧栏页签 | 注册为右侧栏自己的页签类型「Git」，kind `sidebar-git`，与文件 / 终端 / 聊天 / 浏览器并列，无第三方依赖 |
| 跟随会话绑定 | 默认绑定「当前页签所属会话」的工作目录（`sessions.get(id).header.cwd` → `git rev-parse`）；会话 cwd 在仓库子目录里也正确显示（文件展示路径相对工作区，带 `../`）；bind 失败出空态 + 手动改绑 |
| 变更页签 | 分组的文件行（已暂存 / 未暂存 / 未跟踪 / 冲突），状态徽标 + numstat，行内展开 diff（±行着色、自动换行开关、二进制/超大占位说明）；「全部 ±」组操作 |
| 提交 | 底部提交卡片（24px 圆角，与聊天同款）；`amend 上一次提交`（勾选时自动预填 HEAD 的 subject + body）；提交后 composer 清空 |
| 历史页签 | 时间倒序列表（短 hash、refs 徽标、作者、相对时间），展开 commit 看文件列表 + 逐文件 diff；复制完整 hash |
| 分支页签 | 顶部分支 chip：切换分支（列表按提交时间倒序）、新建并切换（`check-ref-format --branch` 双重校验）、删除（`branch -d` 拒合并不了时升级 `-D` 走确认）、推送到远端 / 拉取（--ff-only） |
| Stash 页签 | 存入（可留备注）/ 弹出 / 应用 / 删除；pop 等破坏型动作走两步确认 |
| 推拉远端 | 无 force 通道；pull 硬绑 `--ff-only`，非 ff 给出「到终端处理」的明确提示；凭据完全交给用户自己的 git credential helper（`GIT_TERMINAL_PROMPT=0` 使凭据交互不可能发生，失败归类为 `AUTH_FAILED` 提示回终端） |
| 危险操作分级 | T0 只读 / T1 保存型写（一次点击）/ T2 破坏型写（**prepare → 预览 → confirm**，一次性 token 30 秒过期）；`reset --hard` / `clean` / `push --force` 在路由层面不存在 |
| 状态实时感 | 页签可见时 2.5s 轮询聚合的 `/overview`（分支状态 + 文件三分组 + stash 数）；打出来的 diff 若仓库 `rev` 变化显示「内容已变化，点击刷新」，不自动改写正在读的 diff |
| 与桌面端同款外观 | 用 DSH 内置组件库（`@deepseek-ai/dsh-client-ui-primitives`）与 design token 渲染：同款按钮 / Pill / Tooltip / 菜单，图标缺失时自带 16px stroke 路径兜底；组件库缺失退化为纯原生元素 + 本插件样式表 |
| 失败可见 | 错误按稳定 code 分类（`LOCKED` / `AUTH_FAILED` / `NOT_FAST_FORWARD` / `PUSH_REJECTED` / `UNMERGED` / `BRANCH_INVALID`…）给出可操作提示；index.lock 冲突不移除锁文件，只如实说明 |
| 深浅主题跟随 | shell token 优先，缺席时才用兜底字面值；`body[data-ds-dark-theme]` |

## 安装

已装在 DeepSeek Harness 的 `desktop` profile（`~/.dsh/profiles/desktop`）。重装或换机器：

```sh
node tools/install-into-profile.mjs --dry-run   # 先看要改什么
node tools/install-into-profile.mjs             # 幂等：软链 + link: 依赖 + bundles 挂载
node tools/install-into-profile.mjs --uninstall # 卸载
```

脚本做三件事，不走 `dsh plugin add`（那会联网重解析整个 profile）：

1. 把包软链（或 `--copy` 复制）进 profile 的 `node_modules`；
2. 在 profile 的 `package.json` 里记一条 `link:` 依赖，并把包加进 `dsh.profile.bundles`（紧跟 `dsh-sidebar-chat` 之后，四个 UI 插件聚在一起）；
3. 清扫旧版脚本可能留在 profile `cordis.patch.yml` 里的手写 `sidebar-git` 行。

挂载行由包自己的 `cordis.patch.yml` 声明（`package.json` 的 `dsh.bundle.patch` 指向它）。profile 的 `bundles` 列表与 `cordis.patch.yml` 都被热重载，**存盘几秒后刷新页面即可，不用重启**。想临时停用而不卸载，在 profile 的 `cordis.patch.yml` 里加一条：

```yaml
- id: sidebar-git
  name: dsh-sidebar-git
  disabled: true
```

## 数据放在哪

| 内容 | 位置 | 生命周期 |
|---|---|---|
| 手动改绑记录 | `$DSH_HOME/dsh-sidebar-git/bindings.json` | 持久化，重启保留；目标路径失效时自动回落到会话目录解析 |
| 其余全部 | 不落盘 —— 仓库自身的 `.git` 之外，插件不留任何缓存或索引 | – |

想确认实际路径：`curl -s http://127.0.0.1:19387/dsh-sidebar-git/info`。

## 原理

```
┌─ 浏览器（右侧栏「Git」页签，keepMounted） ────────────────────────────┐
│ lib/client.js（单文件、免构建 CJS，与 chat/browser 同形态）           │
│   sidebarRightTabs.register(kind: 'sidebar-git') + 两个 slot seat    │
│   轮询 /overview（页签可见才轮询，同仓库多会话共享一份新数据）        │
│   变更（行内 diff）· 历史（commit 详情）· Stash · 提交卡片            │
└──────────────────────────┬──────────────────────────────────────────┘
                           │ 同源 fetch（loopback）
┌──────────────────────────▼──────────────────────────────────────────┐
│ host 半 lib/index.js（cordis 插件，inject webServer·subprocess·sessions）│
│   routes:  /repo /overview /diff /log /branches /stashes            │
│            /stage /unstage /commit /branch /push /pull /stash /binding│
│            /ops/prepare → /ops/confirm（T2 门，一次性 token）        │
│   模块分工：                                                        │
│     git.js      执行器：白名单 argv → ctx.subprocess，稳定环境       │
│     parse.js    解析器（纯函数）：porcelain v2-z / numstat / log / diff│
│     guard.js    参数校验 · T2 门（prepare/confirm token）            │
│     queue.js    每仓库串行队列（写操作排队，避免 index.lock 竞争）   │
│     binding.js  会话↔仓库解析链 + bindings.json 持久化               │
└──────────────────────────┬──────────────────────────────────────────┘
                           │ ctx.subprocess（GIT_TERMINAL_PROMPT=0，
                           │  GIT_OPTIONAL_LOCKS=0，超时与输出上限）
                           ▼
                    用户仓库（只经正规 git 命令触碰）
```

几个关键平台事实决定了上面的样子：

* **模型**：`git` 经 `ctx.subprocess` 跑——显式 argv、无 shell 解释、scrub 凭据环境、有界输出。稳定性环境写死在执行器：`GIT_TERMINAL_PROMPT=0`（远端要凭据交互时立即失败，被归类为 `AUTH_FAILED`）、`GIT_OPTIONAL_LOCKS=0`、`GIT_PAGER=cat`、`GIT_EDITOR=:`、`GIT_CONFIG_COUNT=0`、`LC_ALL=C.UTF-8`。macOS 的 Xcode stub（`/usr/bin/git` 未装 CLT）用 `xcode-select -p` 探测，与 harness 自带 `workspace-changes` 同一套姿势。
* **解析**：`status --porcelain=v2 -z`（NUL 条目 + 原始路径 + unborn/detached 标记）、`diff --numstat -z`（rename 条目是「空路径字段 + 两个 NUL 半段」）、`log --format=<%x00 字段，%x01 记录>`（body 放最后一个字段，任意外字节不作）、`diff` 用统一的 hunk 解析。三套格式逐字节对照 Apple Git 2.54 验证（见 `test/core.test.mjs` 的 canned 字节）。
* **注意一个坑**：`git branch --format=` 与 `git log --format=` 是两个格式引擎——前者（for-each-ref）**不展开 `%x00`**，所以分支列表用真实 TAB 字段分隔；后者支持 NUL。`git stash list --format=` 用的是 log 引擎。这类「同名不同义」是测试里锁着的。
* **mount**：外壳给每个会话渲染一份右侧栏（隐藏的用 `display:none` 保留），本页签 `keepMounted`——同一页签可能同时存在多份实例；共享 store 按 `sessionId` 收敛，轮询按仓库去重（1.8s 内同仓库只 fetch 一份），浮动菜单用 `isOnScreen()`（`checkVisibility` + 包围盒）在不可见实例上不画。组件 kit 的 props 没有默认值、slot 抛错会被退役成白板——那些坑 chat 插件踩过，本包同样做了 `MarkdownBoundary` 式的克制（无 markdown 渲染面 + fallback kit 全量等价实现）。
* **刷新语义**：/overview 返回一个 `rev` 状态 hash（分支 tip + ahead/behind + 每文件 XY + stash 数），客户端比对它判断「打开着的 diff 是否过时」。agent 或终端对仓库的任何改动都会体现——不需要文件监听。

## 状态与操作对应表

| 请求 | 危险级 | 做什么 |
|---|---|---|
| GET /info /repo /overview /diff /log /branches /stashes | T0 | 只读 |
| POST /stage /unstage /commit /branch(create/checkout/delete -d) /stash(push) /push /pull /binding | T1 | 保存型写：单次点击完成，响应内联最新 /overview |
| POST /ops/prepare {op: discard · stash-pop · stash-apply · stash-drop · branch-force-delete} → POST /ops/confirm {token} | T2 | 破坏型写：prepare 冻结参数 + 给出 argv/影响摘要，confirm 消耗一次性 token（30 秒）执行 |
| POST /binding {remove: true} | T1 | malware-free 的清理通道（smoke 用），等价丢一条绑定 |

## 安全与边界

* 插件的路由挂在 harness web 服务器上，**不经过 `/api` 的 Host/Origin + 浏览器鉴权栅栏**（与现存三个侧边栏插件一致）。同源页面之外的网页读不到响应（无 CORS），但**本机进程可以访问**——缓解靠：所有 git 参数由插件源码里的固定 argv 模板装配（无 shell、无参数拼接、路径/分支名/消息走校验，分支名要过 `check-ref-format --branch`），T2 操作必须 prepare→confirm。本机进程的直呼界面请与 chat / 浏览器插件同等的边界认识对待——这是三个现存插件的共同事实（介意的话 `--uninstall`）。
* 凭据隔离：插件不读、不存、不传任何凭据 —— 推拉借用用户 git 自己的 credential helper；`GIT_TERMINAL_PROMPT=0` 使凭据交互不可能发生（失败归类 `AUTH_FAILED` 而不是挂起）。
* 与 agent 的并发：agent 与本插件都能改工作区，设计上「一切以实时 status 为准 + 写操作每仓库串行 + 冲突显式呈现」，不假装原子性；index.lock 冲突如实报告 `LOCKED` 并建议稍后重试，绝不自动删锁。
* **v1 明确不做**：任意 git 命令输入框、shell 拼接、参数模板注入；`reset --hard`、`clean`、`push --force`（非 lease）、`cherry-pick`、`rebase`、merge 冲突解决 UI（冲突以 banner 呈现并引导到终端或 agent）、submodule 内容操作（gitlink 如实展示）、自动后台 fetch（只在用户显式 push/pull 时动网络）。

## 已知边界

* hunk 级操作（逐块暂存/丢弃）延后到 v2：v1 只能文件粒度。
* 「自动换行」开关只影响 diff 显示；横向没有滚动条（等宽小字 + 换行）。
* 冲突合并、detached HEAD、空仓库都以只读提示呈现；不存在私自恢复动作。
* 会话 cwd 不在仓库内的空态必须手动 bind —— 没有全局 repo 收藏夹（那属于另一类工具）。
* `pull` 固定 `--ff-only`；需要 merge/rebase 的场景给出去终端的明确指引。v2 候选才做自动 merge。
* 页签标题在 ready 前显示「Git」，ready 后显示「分支 · Git」。

## 开发

```sh
node --test test/          # 82 个用例：解析器（逐字节 canned 格式）、守卫、队列、绑定、路由集成（真 git fixture）、client vm 渲染
node tools/smoke.mjs       # 对着正在运行的 harness 跑真实链路
```

smoke 自建三个 fixture 仓库（正常 / 干净 / 空仓库）+ 一个本地 `file://` 裸远端，经 `/binding` 接入后全链路验证，最后自删并清除绑定 —— 全程无网络，仓库在系统临时目录。

改 host 半想免重启，把本包 lib 加进 profile 的 hmr 监听根（`cordis.patch.yml` 的 `hmr` 行；那一行的 `config` 是**整体覆盖**，要连既有 browser/chat 条目一起写）。存盘秒级重挂 —— 本包开发流程已验证。client 半由模块系统按 revision 重取，刷新页面即可。

这次测试先行的几个用例锁住了真实 git 的惊喜：

* 干净树上 `git stash push` **exit 0**、提示在 stdout —— 路由按「诚实判断留存」而不是「exit 0 即成功」处理（`NOTHING_TO_COMMIT`）。
* 「You have not concluded your merge」（合并中间态提交被拒）归类 `UNMERGED`。
* `branch --format` 里 `%(upstream:track,nobracket)` 的值含逗号空格，BRANCH_FORMAT 用 TAB 分隔、subject 放最后，让 subject 里的意外 TAB 也能 join 回来。

## License

MIT
