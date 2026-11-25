# pi-scheduled-tasks

为 [pi](https://github.com/earendil-works/pi) 和 [Pi Web](https://github.com/agegr/pi-web)
提供定时任务：cron 表达式、固定间隔、一次性提醒，都在会话里用对话框管理。

每次执行都是任务目录下一个普通的 `pi` 会话，所以在 Pi Web 侧栏里能看到它自己的
对话、工具调用和花费；同一套任务在终端里也一样能用。

```
/tasks
```

```
Scheduled tasks · 2 active · 2 total
  a1b2  ●  Morning inbox — cron 0 9 * * * · next in 3h
  c3d4  ●  Deploy check  — every 30m        · next in 12m
  ＋ New task
  Close
```

## 为什么是扩展，而不是 Pi Web 新页面

Pi Web 刻意保持轻量。它的贡献指南把「定时调度」和「定时消息」明确列为不合并的
范围，并指出这类需求应当用 pi 扩展解决：

- [CONTRIBUTING.md — 不合并的范围](https://github.com/agegr/pi-web/blob/main/CONTRIBUTING.md#out-of-scope)
- [Issue #666](https://github.com/agegr/pi-web/issues/666) — 维护者用 `/schedule`
  扩展作为答复关闭
- [PR #1409](https://github.com/agegr/pi-web/pull/1409) — 把调度器做进核心的 PR
  被拒绝：「a scheduler is outside what pi-web is meant to be […] A pi extension
  gives the same thing to the CLI as well.」

所以这是一个 pi 包，不修改 Pi Web。它只使用公开的扩展 API，以及 Pi Web 文档里的
[会话存活登记](https://github.com/agegr/pi-web/blob/main/docs/integrations.md#extension-session-liveness)，
在 CLI 和 Pi Web 中行为一致。

## 安装

```bash
pi install git:github.com/zhoubiao188/pi-scheduled-tasks
```

不安装、先试用：

```bash
pi -e git:github.com/zhoubiao188/pi-scheduled-tasks
```

安装后重启 Pi Web，或在会话里执行 `/reload`。在 Pi Web 输入框里输入 `/` 就能补全
`/tasks`。

要求 pi 0.84 及以上；状态栏按钮和 liveness 登记需要 Pi Web 0.9.0 及以上。更早的
Pi Web 也能用，但空闲会话可能被回收，要等重新打开会话才会继续调度。没有运行时依赖。

## 使用

`/tasks` 打开管理器。选中任务后可以立即运行、编辑、暂停/恢复、查看历史、删除。

| 命令 | 作用 |
| --- | --- |
| `/tasks` | 打开管理器 |
| `/tasks add` | 新建任务（名称、提示词、计划、目录） |
| `/tasks list` | 打印所有任务和下次运行时间 |
| `/tasks run <id>` | 立即运行一次，不影响原计划 |
| `/tasks edit <id>` | 修改名称、提示词、计划或目录 |
| `/tasks pause <id>` / `resume <id>` | 暂停或恢复 |
| `/tasks runs <id>` | 最近运行记录，选中可直接打开对应会话 |
| `/tasks rm <id>` | 删除任务及其历史 |
| `/tasks show <id>` | 打印单个任务详情 |
| `/at 09:00 <提示词>` | 在当前目录快速建一个一次性任务 |

创建/编辑时的对话框就是 Pi Web 自带的输入框、多行编辑器和选择框，手机上也能用。
Pi Web 顶部状态栏会出现 `⏰ 2 active · next in 12m` 按钮，点开就是 `/tasks`；输入框
上方的小组件会列出最近的运行时间。

### 计划格式

| 形式 | 例子 | 含义 |
| --- | --- | --- |
| cron | `0 9 * * *` | 每天 09:00（本机时区） |
| cron | `*/15 * * * *` | 每 15 分钟 |
| cron | `0 9 * * mon-fri` | 工作日 09:00 |
| cron | `@daily`、`@hourly`、`@weekly`、`@monthly` | 宏 |
| 固定间隔 | `every 30m`、`1h30m`、`every 2d` | 最短 1 分钟 |
| 一次性 | `at 09:00`、`at 2026-11-26T09:00` | 运行一次后自动暂停 |

cron 支持列表、区间、步长、月份和星期名称；当「日」和「星期」都有限制时，按
标准 cron 的「满足其一即可」处理。

### 一次执行做了什么

在任务目录下启动一个无界面的 pi：

```
pi --mode json -p --name "⏰ Morning inbox" "<提示词>"
```

会话正常落盘，所以在 Pi Web 对应项目下能看到这次运行，**Runs** 里选中记录会直接
打开它。历史里保留退出状态、耗时、结果摘要和会话文件路径（最多 20 条）。

## 错过运行怎么办

计时器依附在 pi 会话上。Pi Web 运行期间，负责调度的那个会话只要有启用中的任务，
就不会被空闲回收（使用官方文档中的 liveness 登记），即使没有浏览器标签页打开。

Pi Web 重启后，直到重新打开某个会话才会继续调度。每个任务按自己的「补跑」设置处理：

- **跳过**（默认）：这次记为 `missed`，绝不迟到发送，计划继续往后走。
- **补跑一次**：打开会话时补跑一次，然后回到正常计划，不会补跑多次。

同一时间只有一个会话真正执行任务（锁文件），所以多个会话或多个 Pi Web 标签页不会
重复触发；每个时间点的执行还有原子认领标记，跨进程重复也算空操作。

## 安全与资源限制

- **不经过 shell**：提示词作为单个 argv 元素传入，`shell: false`，任务内容不会被
  任何 shell 解释。
- **不提权**：一次运行就是普通的 pi 会话，认证、扩展、工具权限、项目信任规则与手动
  运行一致。
- **有上限**：最多 50 个任务，提示词 20,000 字符，名称 120 字符，历史 20 条，同时只跑
  一个，单次超时 30 分钟（先 SIGTERM，再 SIGKILL）。
- **状态文件私有**：`~/.pi/agent/scheduled-tasks.json` 以 `0600` 原子写入，目录
  `0700`。文件损坏时改名保留，绝不删除。
- **不递归**：任务启动的 pi 进程带有 `PI_SCHEDULED_TASK_CHILD=1`，扩展在其中自行
  禁用。
- **离线**：扩展本身不发起任何网络请求，不上报遥测。
- **不隐藏写入**：只写自己的状态、锁和认领文件，以及 pi 为每次运行写下的会话文件。

任务以明文保存，方便阅读和备份。不要把密钥写进提示词，使用 pi 已有的 provider 配置。

## 配置

| 变量 | 默认值 | 用途 |
| --- | --- | --- |
| `PI_SCHEDULED_TASKS_PI_BIN` | 与当前 Node 同目录的 `pi` | 执行任务用的可执行文件 |
| `PI_SCHEDULED_TASKS_TIMEOUT_MS` | `1800000` | 单次运行超时 |
| `PI_SCHEDULED_TASKS_DIR` | `~/.pi/agent` | 状态文件位置（测试或隔离环境） |

找不到 `pi` 可执行文件时，`/tasks run` 仍然可用：提示词会投递到当前会话，而不是
单独开一次运行。

## 已知限制

- 时间按运行 pi 的机器本地时区计算；cron 使用 JavaScript `Date` 规则，夏令时切换
  当天 02:30 这类时间可能被跳过或重复。
- 每次执行都是全新会话，不延续上一次的上下文。需要上下文就写进提示词，或把状态放在
  任务目录的文件里。
- 没有任何 pi 进程加载会话时不会触发。介意的话打开「补跑」，或保持一个小会话常开。

## 开发

```bash
npm install
npm test          # 35 个测试：计划计算、状态存储、执行器、扩展接线
npm run typecheck
```

`test/extension.test.mjs` 用假的 pi API 和假对话框直接驱动真实命令处理函数；
`test/runner.test.mjs` 用一个会讲 JSON 事件协议的假 `pi` 验证执行路径。

## 许可

MIT。与 pi、Pi Web 维护者无隶属关系。
