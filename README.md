# dsh-rewind —— 代码回滚 + 对话恢复插件（DeepSeek Harness）

Trae / Claude Code `/rewind` / Cline 风格的时间旅行能力：

- **自动快照**：每轮对话边界 + agent 写类工具执行后，把整个工作区提交进工作区之外的影子 git 仓库（不碰你的 `.git` / HEAD / 暂存区）
- **一键回退**：每轮对话尾部的 **↩ 回退本轮** 图标 → 确认受影响文件清单 → 代码精确恢复（tree hash 校验）+ 对话从该轮之前分叉继续
- **精确性保证**：全树快照不漏（shell 间接改动也进快照）、恢复后整树校验不多、回退前自动落"安全点"可反悔
- **Agent 能力**：`checkpoint_list` / `checkpoint_diff` / `checkpoint_restore` / `checkpoint_verify` 四个工具
- **命令**：`/rewind [轮号]`、`/checkpoints`

## 安装（本地开发）

```powershell
# 在 DSH 中以本地链接方式安装（桌面端 desktop profile）
dsh plugin --profile desktop add link:C:\Users\lenovo\Desktop\代码回滚
```

或在 Web GUI「设置 → 插件」中从本地目录安装。安装后重启 DSH 生效。

- 系统需要可用 `git`（影子仓库引擎）；缺失时插件进入降级模式（UI 会提示）。

## 数据布局

| 内容 | 位置 |
|---|---|
| 影子裸仓库 | `~/.dsh/storages/rewind/shadow/<workspace-hash>.git` |
| 检查点索引 | `~/.dsh/storages/rewind/index/<workspace-hash>.json` |
| 插件配置 | `~/.dsh/storages/rewind/config.json` |

配置项（可写入 `config.json`）：

```json
{
  "autoSnapshot": "all",            // 'all' | 'turn-only' | 'off'
  "confirmBeforeRestore": true,     // agent 工具回退前询问用户
  "excludes": [],                   // 追加快照排除（目录名，任意层级）
  "writeTools": ["write", "edit", "bash"] // 触发写后快照的工具
}
```

## 回退语义（重要）

- 回退 = 工作区**精确等于**该轮开始前的状态（恢复后重扫整树校验 hash）
- 该轮之后的一切文件变更都会被回退（确认弹窗中逐文件可见：还原 / 移除 / 恢复）
- 会话日志**永不截断**：回退 = 从该轮之前 `sessions.fork(boundarySeq)` 分叉新会话，原会话完整保留
- 回退前当前状态先落"安全点" commit，随时可再反悔
- 保护范围 = 会话工作区目录内（写入工作区外的文件不在保护范围）

## 开发

```powershell
node --test          # 17 个测试：快照精确性 / 中文与二进制 / 整树校验 / 失败回滚 / 目录占位
```

结构与设计文档：

- 规格：`docs/superpowers/specs/2026-10-12-dsh-rewind-plugin-design.md`
- 实现计划：`docs/superpowers/plans/2026-10-12-dsh-rewind-implementation.md`
- `lib/index.js` Host 半（快照钩子 / 工具 / 命令 / Web API）
- `lib/client.js` Client 半（turnTail 撤回图标 + 确认弹层 + 跳转分叉会话）
- `lib/shadow-git.js` 影子仓库引擎；`lib/checkpoints.js` 检查点编排
