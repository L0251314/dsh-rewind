# dsh-rewind 实现计划

- 日期：2026-10-12
- 关联规格：[2026-10-12-dsh-rewind-plugin-design.md](../specs/2026-10-12-dsh-rewind-plugin-design.md)
- 状态：🔄 进行中

## 1. 需求摘要（源自规格）

- 影子 git 全树自动快照（turn 边界 + 写类工具后）→ 检查点索引
- 回退 = 代码恢复（treeHash 校验）→ `sessions.fork(boundarySeq)` 对话分叉
- Turn 尾部撤回图标（`conversation.chat.turnTail`）+ 确认弹窗 + 跳转分叉会话
- `/rewind`、`/checkpoints` 命令；4 个 agent 工具
- 恢复精确性测试矩阵（中文/二进制/大小写/删除/新增）

## 2. 已实证的平台 API（asar 源码核实）

| API | 用法 |
|---|---|
| `ctx.tools.register(def)` | `{name, description, parameters(schema DSL), output:{schema,render}, execute(args, exec)}` |
| `ctx.commands.register(def)` | `{name, description, input:{hint}, handler({agent, rawInput}) → {kind:'success',text}}` |
| `ctx.sessions.fork(source, boundary)` | source=Session 对象或 id；boundary=**inclusive** seq；子会话从 boundary+1 续 |
| `ctx.sessionTitle.rename(session, title)` | 分叉会话命名（防御式调用） |
| Client `ctx.slots.inject(key, () => ctx.slots.register(decl, Comp))` | decl=`{id, order, label}`；Comp props=`{turn, seq, openFile, sessionId, useSessions, t}` |
| Client `ctx.sessions.fork({sessionId, atSeq, increaseTitle}) → ctx.uiWorkspace.openSession(id)` | 官方 branch 按钮同款（ui-chat client.js L12455） |
| 插件 HTTP 路由 + `webserver/index-inject` | whale-widget 同款 Client→Host 通道（v1 主通道） |

**快照时机实现修正**（相对规格 §6.1）：`agent/pre-step` / `tools/pre-execute` 是 waterfall 事件，误用有破坏链路风险；v1 改为在 **`session/event`（emit 模式，whale-widget 已验证安全）** 上观测 `turn/start`（记录边界=该事件 seq-1）与写类工具完成事件（记录边界=当前 seq），快照语义不变：turn N 的检查点 = turn N 开始前的全树状态。

## 3. 阶段与任务

### 阶段 A：工程骨架
- [x] A1 package.json（`dsh.bundle.patch` + `dsh.client{platform:'web'}` + `./client` 导出）
- [x] A2 cordis.patch.yml（insert 条目）
- [x] A3 目录：lib/ test/ tools/

### 阶段 B：核心引擎（纯 Node，可独立测试）
- [x] B1 lib/shadow-git.js：ensure / addCommit(脏检查) / writeTree / diffFiles / restoreTree(含失败清单) / readFileFromTree
- [x] B2 lib/checkpoints.js：索引持久化（原子写）/ snapshot 去重 / list / plan / restore（safety→apply→verify→fork）/ verify / 回滚
- [x] B3 test/shadow-git.test.mjs：中文文件名、二进制、嵌套目录、删除/新增/修改、restore 精确性（整树 hash 断言）、失败回滚
- [x] B4 test/checkpoints.test.mjs：索引、去重、restore 流程（fake fork）、verify 失败回滚

### 阶段 C：Host 半接入
- [x] C1 lib/index.js：apply(root) → inject([webServer,tools,commands,sessions,sessionTitle])
- [x] C2 session/event 观测 → 快照钩子（turn/start、写类工具、safety）
- [x] C3 /dsh-rewind/api/* 路由（checkpoints/plan/restore/verify）+ 回环/同源信任栅栏
- [x] C4 lib/tools.js 4 个 agent 工具 + lib/commands.js 2 个命令

### 阶段 D：Client 半
- [x] D1 lib/client.js：turnTail 撤回图标（React.createElement，无 JSX）、内联确认清单（plan 接口）、restore + openSession 跳转、styles.insert 样式、全部防御式降级

### 阶段 E：收尾
- [x] E1 README + 打包 tar.gz + 本地安装验证说明
- [x] E2 全量测试通过 + git 提交

## 4. 风险与缓解

| 风险 | 缓解 |
|---|---|
| 插件安装后 slot 未注册（dsh.client 声明格式差异） | Client 半全部防御式；HTTP 路由与命令先行可用；安装验证步骤定位 |
| event.seq 字段名不确定 | readSeq() 多字段探测 + 诊断日志 |
| agent cwd 解析 | 多字段探测（exec.cwd/agent.cwd/meta.cwd）+ 路由参数显式传 workspacePath 兜底 |
| Windows 文件锁 | restore 逐文件容错收集失败清单 → 整体回滚 safety 点 |

## 5. 成功标准

1. `node --test` 全绿（含中文/二进制/精确性矩阵）。
2. 真实会话：改文件 → turnTail 出现撤回图标 → 点击 → 确认清单 → 工作区 treeHash==检查点 → 自动跳入「· ↩N」分叉会话。
3. 原 git 仓库零污染（status 无插件痕迹）。
