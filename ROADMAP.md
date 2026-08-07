# pi-agent-tools — 工具组全景与路线图

> Monorepo：**一个工具一个包**。每个包独立版本、独立测试、独立发布、独立维护——用户按需安装单个包，工具之间零运行时依赖。
> 详细设计（接口/输出/边界）：见 `DESIGN.md`（T1-T4）与各包 README。

## 0. 交叉审计（痛点 × 创新度，2026-08，v2 修正）

> v2 修正：初次审计（4 个宽泛查询）漏查严重，补查后确认——**纯工具层面无独特空档**。以下为修正后结论。

社区对照：pi.dev 包目录（5,540 包）、Claude Code 插件生态、agent 记忆/上下文工具生态。

**明确痛点（实测证据 + 社区共鸣）**：环境盲试（352 次失败）、shell 搜索滥用（10,640 次）、edit 锚点失败（158 次）、验证循环（13.6 万 token）、大 turn read×N（top-10% 占 63% 推理）、thinking 规划/猜测（79.1%）、上下文膨胀（26/108 会话）。

**撞车清单（我们的设计 vs 社区已有）**：
- read-many → `pi-read-many`（同名）、`pi-read-map`、`pi-ast-read`、pi-readseek
- verify-change → `pi-verify`、`pi-green-loop`、`pi-verify-all`、`pi-dev-loop`
- repo-state → `pi-git-context`、`pi-git-status-line`、`pi-state-sync`
- decide → `pi-captains-log`、`pi-live-decision-board`
- env-probe → `pi-env-probe`（同名）、cc-inspect、注入模式被 pi-git-context 使用
- 拦截机制 → `pi-reflag`（grep→rg 重写）、`pi-prefer-rg`
- 记忆/上下文/编排 → 红海（6+4+6 个包）

**剩余差异化（未被复制）**：
1. **数据驱动方法论**——115 会话归因 → 工具设计 → 度量基线；社区工具全凭经验，无量化证据
2. **会话分析流水线**（analyze1-6）——归因/bigram 推理成本/thinking 分类/错误族谱；无人提供"分析你的会话→定位最贵模式→推荐选型"服务
3. 拦截组合层（协议注入+全栈引导+限频）——窄于 pi-reflag 单点重写但存在差异

**战略**：不做第 N 个 verify/read-many（撞车）。转向方案 A：`pi-session-doctor`（诊断+选型服务，独特资产产品化）或 B：`pi-intel-guard`（拦截组合层）。

## 1. 归因结论（一切设计的依据）

115 个真实 pi 会话 / 31K assistant 消息 / 15.8M 推理 token：

| 信号 | 数值 | 意味着 |
|---|---|---|
| 工具失败率 | 4.7%（1,824 次失败，319 次同工具重试） | 环境/协议在逼模型试错 |
| `ctx_grep` 失败 | 352/389（rg PATH 漂移） | 系统性环境失配 |
| edit 失败 | 158（锚点漂移/未读即改） | 编辑协议缺失 |
| shell 搜索调用 | 10,640 次 / 8.8M token（ctx_compose 仅 4 次） | 好工具栈闲置 |
| 推理占比 | 生成量 29.1%；top-10% turn 占 63% | 推理高度集中 |
| thinking 内容 | 65.6% 是"规划下一步" | 循环 × 每步规划 = 推理路径 |

**模型**：`推理路径 = Σ(循环次数) × Σ(每步规划成本)`。所有工具压这两个因子之一。

## 2. 工具组（按成本链排列）

| # | 工具（包名） | 压哪个因子 | 证据 | 状态 |
|---|---|---|---|---|
| TG1 | **pi-env-probe** `env_probe` | 循环数 | ctx_grep 352 失败、148 拦截 | ✅ 已发布 v0.1.0 |
| TG2 | **pi-code-intel-guide**（协议+拦截） | 循环数 | 10,640 shell 搜索 vs compose 4 次 | ✅ 已发布 v0.1.0 |
| TG3 | ~~pi-edit-guard~~ → **选型** `pi-read-before-write` | 循环数 | edit 158 失败 | 🔴 红海，不自做 |
| TG4 | **pi-verify-change**（验证闭环） | 每步成本 | pwsh→pwsh 链 13.6 万 token | 🟡 差异化，📐 已设计（T2） |
| TG5 | **pi-repo-state**（仓库快照） | 循环数 | git-inspect 4.3M token | 🟡 差异化，📐 已设计（T1） |
| TG6 | **pi-read-many**（批量大纲） | 循环数 | 大 turn read×15，r/o 0.91 | 🟡 差异化，📐 已设计（T4） |
| TG7 | **pi-decide**（结构化决策） | 每步成本 | thinking 65.6% 规划 | 🟡 差异化，📐 已设计（T3） |
| TG8 | ~~pi-orchestration-flat~~ → **选型** `pi-subagents`/`pi-crew` | 循环数 | subagent 6,554 + 卡住 169 | 🔴 红海，不自做 |
| TG9 | ~~pi-context-budget~~ → **选型** `pi-hypa`/`context-mode` | 每步成本 | 26/108 会话膨胀 2-3.5 倍 | 🔴 红海，不自做 |
| TG10 | ~~pi-memory-layer~~ → **选型** `pi-hermes-memory`/`pi-memory` | 每步成本 | 跨会话重复探索 | 🔴 红海，不自做 |

## 3. 每个工具的生命周期规范（发布纪律）

```
设计（DESIGN.md 一节的完整规格：目标/接口/输出/边界/预期收益/度量）
  → 实现（单包 packages/pi-<name>/，自包含，零跨包 import）
  → 测试（test/smoke-test.cjs ≥ 15 断言，覆盖 en+zh、平台 fallback、边界）
  → 发布（独立版本号 0.x；npm 或 git 标签；README 含安装/工具表/证据/许可证）
  → 维护（独立演进：可单独废弃/迭代，不拖累其他包）
```

每个包固定四件套：`package.json`（peerDeps: typebox, pi-coding-agent）+ `extensions/` + `README.md` + `test/smoke-test.cjs`。共享代码（约 15 行 i18n 检测）**复制**而非引用——独立发布的代价是少量重复，收益是零耦合。

## 4. 当前状态

- ✅ `packages/pi-env-probe` v0.1.0 — 已本地安装，26 项断言通过
- ✅ `packages/pi-code-intel-guide` v0.1.0 — 已本地安装，14 项断言通过
- ✅ **已装社区包（2026-08 审计后）**：`pi-verify`（验证闭环）、`pi-git-context`（git 状态注入）、`pi-read-many`（批量读取）
- ✅ **`session-doctor` skill**（`~/.agents/skills/session-doctor/`）——分析流水线产品化：随时诊断会话成本、推荐选型；效果对比用后续会话数据重跑分析
- 📐 `DESIGN.md` — T1-T4 详细设计（已确认与社区撞车，保留作参考）
- 🔴 未装（审计后判定）：`pi-read-before-write`（作者自嘲 slop）、`pi-env-probe` 社区版（撞名）、`pi-hypa`（重写风险）、`pi-green-loop`（与 pi-verify 重叠）

## 5. 下一步（建议顺序）

1. **pi-verify-change**（🟡 创新+痛点双高；验证循环 + 10.6% 验证推理；设计已完整）
2. **pi-repo-state**（🟡 简单，直接 spawn git，零 shell 依赖）
3. **pi-read-many**（🟡 需先确认 lean-ctx 索引能力）
4. **pi-decide**（🟡 依赖模型自律，最后）
5. 红海区（编辑/记忆/上下文/编排）→ **不写新包**，按审计结果选型集成，README 引用社区包
6. 发布前准备：GitHub 仓库 + 每包独立 CI（npm test）+ pi.dev 图廊元数据

度量基线（实现后重跑 `~/.pi/agent/sessions/_analysis/`）：bigram 推理成本、工具错误率、每 turn 推理分位数、新工具采纳率。
