# DSH Rewind 插件设计规格（代码回滚 + 对话恢复）

- 日期：2026-10-12
- 状态：已经用户批准的设计
- 目标平台：DeepSeek Harness（DSH）v44.0.0，Windows 优先，插件形态为本地 bundle（Host 半 + Client 半）

## 1. 背景与目标

用户在 DSH 中使用 agent 编码时，需要类似 Trae / Claude Code `/rewind` / Cline 的能力：

- agent 每轮修改代码前自动留档，任何时刻可以撤回；
- 撤回时**代码和对话一起回到上一轮**，从那一刻继续；
- 每轮用户消息（Turn 尾部）有一个撤回图标，点击即回退；
- 恢复必须精确：**不漏恢复、不多恢复**，并有测试保证。

非目标：不替代用户自己的 git 工作流；不保护工作区目录之外的文件；不截断 DSH 持久化会话日志。

## 2. 调研结论（外部参考）

| 参考对象 | 借鉴点 |
|---|---|
| Cline Checkpoints | 影子 git：工作区外独立仓库，全树快照，不碰用户 git |
| Claude Code `/rewind` | 代码 + 对话一起回退；回退前可选确认 |
| Trae | 每轮 agent 动作前自动 checkpoint；对话流内嵌回退入口 |
| stepback / ShadowGit | 明确的安全边界：不动 HEAD / 暂存区 / 分支 |
| Aider（反例） | 直接 auto-commit 污染用户历史，本设计不采用 |
| Hyperion-Delta | 恢复前 diff 清单、崩溃恢复意识 |

## 3. 平台能力依据（已用 Inspect 实测确认）

- `tools` Service：注册 Agent 工具（checkpoint_list / diff / restore / verify）。
- `commands` Service：注册 `/rewind`、`/checkpoints` 斜杠命令。
- `sessions` Service：`fork(source, boundary?, childSessionId?)` 原生会话分叉——对话回退的官方机制。
- 事件 `agent/pre-step`：每轮 Turn 开始前触发——turn 边界快照钩子。
- 事件 `tools/pre-execute`：写类工具执行前触发——写前快照钩子。
- `subprocess` Service：调用系统 git 操作影子仓库。
- `storage` / `storageDomain`：检查点索引持久化。
- `userQuestions` / `approval`：回退前二次确认。
- 客户端 Slot `conversation.chat.turnTail`（`replaceRisk: none`）：每轮完成 Turn 动作行前的扩展区，注入撤回图标，无需替换官方 UI。
- `workspaceChanges`（观察项，二期可用于增强 diff 展示）。

## 4. 已确认的关键决策

1. **回滚范围**：代码 + 对话一起回退（对齐 Trae / Claude Code `/rewind`）。
2. **快照时机**：全自动——每轮 Turn 边界 + agent 写类工具执行前（脏检查通过后才真正 commit）。
3. **存储后端**：影子 git 裸仓库（工作区外），全树快照；绝不触碰用户自己的 git。
4. **交互入口（v1）**：Agent 工具 + 斜杠命令 + 回退前二次确认 + Turn 尾部撤回图标（用户明确要求该图标）。
5. **回退机制**：方案一"分叉回退"——影子 git 恢复代码 + `sessions.fork(boundarySeq)` 恢复对话；否决原地截断（无官方接口，损坏数据风险）与逻辑回退（UI 不一致、语义模糊）。

## 5. 架构

插件名：`dsh-rewind`。两个半区：

```
Host 半（TypeScript）
  CheckpointService（核心编排，@Remote 暴露给 Client 与工具）
    ├─ snapshot(trigger)         幂等：树未变化则跳过 commit
    ├─ list(sessionId) / diff(id) / restore(id) / verify(id)
    ├─ ShadowGit                 影子裸仓库适配层（subprocess → git）
    ├─ CheckpointIndex           检查点元数据持久化（storage 域）
    └─ sessions.fork(...)        对话回退（官方 API）
  自动快照钩子
    ├─ agent/pre-step            → turn 边界快照
    └─ tools/pre-execute         → 写类工具写前快照（脏检查后）
  Agent 工具：checkpoint_list / checkpoint_diff /
             checkpoint_restore / checkpoint_verify
  斜杠命令：/rewind [turn]  /checkpoints
Client 半（Web UI）
  conversation.chat.turnTail slot → 每轮撤回图标
  点击 → Remote restore → 确认弹窗（受影响文件清单）
       → 成功后自动切换到分叉会话
```

影子仓库位置：`~/.dsh/storages/rewind/shadow/<workspace-hash>.git`（裸仓库），
以 `git --git-dir=<影子> --work-tree=<工作区>` 方式操作，等价 `add -A` 后 commit。
workspace-hash 为工作区绝对路径的稳定哈希，避免路径分隔符问题。

检查点记录：`{ id, sessionId, workspacePath, turn, boundarySeq, commitId, treeHash, trigger: 'turn'|'pre-write'|'manual'|'safety', fileStats, createdAt }`。

## 6. 数据流

### 6.1 快照（自动，用户无感）

1. Turn 开始（`agent/pre-step`）或写类工具即将执行（`tools/pre-execute`）；
2. 脏检查：自上次快照以来文件树无变化 → 跳过 commit（索引仍记录边界映射）；
3. `git add -A`（排除 `.git`、`node_modules`、`.dsh` 及配置 ignore 规则）→ commit（message 含 session 与 turn 标识）；
4. 计算 treeHash（`git write-tree`），写入检查点索引。

"写类工具"判定：v1 采用静态清单（`write`、`edit`、`bash`、terminal 写入类等具备文件变更副作用的工具），随 Config 暴露 `writeTools` 允许追加；后续可结合 `fs/observed` 事件自动学习。

### 6.2 回退（点击第 N 轮撤回图标 / `/rewind` / agent 调用工具）

1. **二次确认**：展示受影响文件清单（修改 / 新增 / 删除三类），用户确认；
2. **安全点**：当前状态先 commit 进影子仓库（trigger=`safety`），回退永远可反悔；
3. **代码回退**：按"当前树 → 检查点树"的 diff 精确应用：修改的还原、新增的删除、删除的恢复；
4. **校验**：重扫工作区，`git write-tree` 结果必须等于检查点 treeHash；不等则 checkout 回 safety 点并报错，**不进行对话分叉**；
5. **对话回退**：校验通过后才 `sessions.fork(原会话, boundarySeq[N])`；若 fork 失败，同样 checkout 回 safety 点回滚代码；
6. 原会话标注"已回退至第 N 轮"（保留、可切回），UI 跳转到分叉会话 `「原会话名 · ↩N」`。

> 顺序约束：代码先恢复、校验通过后才分叉对话，保证不存在"对话已回退而代码未回退"的中间态。

## 7. 正确性保证

- **不漏**：全树快照，不依赖"agent 动过哪些文件"的启发式。shell 间接改动（npm install 等）与用户手改一律进快照。
- **不多**：回退语义 = 工作区精确等于检查点树；恢复前后 treeHash 双向校验，不等即失败。
- **知情**：确认弹窗列明文件清单后才执行。
- **零丢失**：会话日志永不截断；回退前状态总有 safety commit。

已知限制（如实告知）：

- 保护范围限于会话工作区目录内；工作区外写入不在保护范围（业界同类一致）。
- 用户在该轮之后的手工修改会随回退一起消失（确认清单中可见）。
- Windows 下被占用的文件可能导致单文件恢复失败 → 整次 restore 自动回滚并报告该文件。

## 8. 错误处理

| 情况 | 处理 |
|---|---|
| 系统 git 不可用 | 降级"仅对话分叉"模式，UI 明确提示 |
| 影子仓库损坏 | 自动重建基线；旧检查点作废并提示 |
| restore 中途失败 | checkout 回 safety 点恢复原状；报错含失败文件 |
| 大仓库性能 | 默认 ignore（node_modules/.git/dist 等）+ 脏检查跳过空 commit；git 增量存储成本低，v1 不设上限、不做 gc |
| 并发回退（连点图标） | restore 原子化 + 会话级互斥；进行中时图标禁用 |

## 9. 测试策略（自主测试保证成功）

1. **单元测试**：ignore 规则、索引读写、treeHash 计算、workspace-hash 稳定性。
2. **集成测试**（真实 git + 临时工作区，vitest）：
   - 场景矩阵：write/edit 修改、bash 新建 / 删除、二进制文件、中文文件名、Windows 大小写变更、超长路径、空工作区首轮、连续多轮回退、回退后再反悔；
   - 断言：恢复后逐文件内容一致且整树 `git write-tree` hash 等于检查点 treeHash；
   - 对话层：以桩替换 fork，断言 boundarySeq 传递正确。
3. **运行时自检**：每次 restore 内置 verify 并把结果返回 UI 与 agent；`checkpoint_verify` 工具可随时手动校验。
4. **冒烟脚本**：改文件 → 撤回 → 校验 → 反悔再撤回，人工走查一遍。

## 10. 配置项（插件 Config）

| 键 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `enabled` | boolean | true | 总开关 |
| `autoSnapshot` | `'all' \| 'turn-only' \| 'off'` | `'all'` | turn 边界 / 写前 / 关闭 |
| `ignoreRules` | string[] | 内置默认 | 追加快照排除规则 |
| `writeTools` | string[] | 内置静态清单 | 触发写前快照的工具名，可追加 |
| `confirmBeforeRestore` | boolean | true | 回退前二次确认 |

## 11. 范围

**v1**：turn 边界 + 写前自动快照；影子 git；fork 回退；Turn 尾部撤回图标 + 确认弹窗 + 自动跳转；`/rewind`、`/checkpoints`；4 个 agent 工具；restore 校验；git 缺失降级。

**二期（明确不做进 v1）**：检查点 diff 浏览面板、时间线全景页、gc 清理、跨会话恢复、`workspaceChanges` 联动增强。

## 12. 开放问题

无。所有关键决策已确认。
