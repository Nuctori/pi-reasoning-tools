# 缩短推理路径：工具设计方案（TG3-TG6）

> 状态：方案已定，未实现。基于 115 会话 / 31K assistant 消息 / 15.8M 推理 token 的归因分析。
> 已实现：`extensions/env-probe.ts`（TG1）、`extensions/code-intel-guide.ts`（TG2）——均为**可发布 pi 包**（本包 `pi-reasoning-tools`，npm/git/本地路径安装）。
> 本文档是下一批工具（T1-T4）的完整设计，按**社区发布标准**（跨平台、i18n、可配置、零本机硬编码）修订。

## 0. 推理路径模型（证据）

```
推理路径长度 = Σ(工具循环次数) × Σ(每步规划成本)
```

- **top-10% 的 turn 占全部推理的 63%**（最长单 turn：推理 10 万 token、187 次工具调用、思考 33.6 万字符）
- **thinking 内容分类**（抽样 1200 条）：规划下一步 **65.6%**、猜测未知 13.5%、验证检查 10.6%、其余 <5%
- **最贵工具链**（bigram，按推理 token）：

| 链 | 次数 | 推理 token | 每步 |
|---|---|---|---|
| ctx_shell→ctx_shell | 1,238 | 572,888 | 463/turn |
| subagent→todo / todo→subagent | 1,342 | 470,142 | 266–1,032/turn |
| ctx_read→ctx_shell / ctx_shell→ctx_read | 447 | 296,590 | 592–768/turn |
| ctx_read→ctx_read | 189 | 140,440 | 743/turn |
| pwsh→pwsh | 336 | 136,200 | 405/turn |
| subagent_wait→subagent | 540 | 106,727 | 198/turn |

## 通用性设计准则（社区发布标准，所有工具必须满足）

1. **零本机硬编码**：无 `~/.pi/...`、无特定仓库路径、无特定用户名；路径一律经环境变量 + 标准位置推导，找不到就跳过/降级
2. **平台无关**：优先直接 spawn 目标命令（`git`、`dotnet`、`cargo`），不依赖 bash 包裹；仅当需要 POSIX 脚本时用 `bash → sh` 两级通道（Linux/macOS/Windows git-bash），纯 Windows 无 shell 时降级
3. **i18n**：与现有扩展一致——英文默认，`LANG`/`LC_ALL`/`LC_MESSAGES`/`LANGUAGE` 含 `zh` 时自动中文；字符串表集中定义
4. **可配置优先于特判**：仓库特有约定（如 .NET Framework 项目的 `build.ps1`）不进代码，走配置（项目 `.pi/` 下的扩展配置或包 manifest），默认用通用探测
5. **依赖走 peerDependencies**：`typebox`、`@earendil-works/pi-coding-agent` 由 pi 捆绑提供，不打包；第三方依赖进 `dependencies` 自动安装
6. **失败三态** pass / fail / error，不静默；`onUpdate` 流式进度；幂等 + 缓存
7. **结论先行**：verdict/状态在输出首行，原始输出进 `details` 折叠
8. **promptGuidelines 写清"何时用"**（TG2 的教训：ctx_compose 只有 4 次调用）

发布形态（与现有包一致）：

```
pi-reasoning-tools/
├── package.json          # pi.extensions + peerDependencies(typebox, pi-coding-agent)
├── extensions/           # env-probe.ts, code-intel-guide.ts, (未来 T1-T4)
├── README.md
└── test/smoke-test.cjs
```

---

## T1 `repo_state` — 仓库状态快照（砍探索链）

**目标**：替代 `ctx_shell→ctx_shell` 探索链（57 万推理 token 中 git status/ls/diff 部分；git-inspect 类 shell 调用 1,714 次 / 4.3M token）。

### 接口

```typescript
parameters: {
  depth?: "quick" | "full"     // 默认 quick
}
```

### 输出（quick）

```
{
  verdict: "ok",                                  // 结论先行
  branch: "main", ahead: 0, behind: 2,
  dirty: { files: 12, added: 3, modified: 8, deleted: 1, untracked: 4 },
  diff: { insertions: 214, deletions: 87, topFiles: ["GameMap.xaml.cs (+120/-40)", ...] },  // 文件级统计，不给全文
  conflicts: [],
  recent: [{ sha: "abc1234", subject: "fix: hot path alloc", author: "N", minutesAgo: 42 }],  // depth=full
  buildStale: null | "12m ago"                    // 构建产物 mtime，depth=full
}
```

### 行为细节

- **直接 spawn `git` 命令**（`git status --porcelain=v1`、`git diff --numstat`、`git log --oneline -5`）——**零 shell 依赖，全平台**（git 本身跨平台）；不用 bash 解析
- diff 只给文件级 ± 统计，不给全文——模型要"改了什么"的概览；需全文时再 diff 单文件
- 非 git 目录：降级为目录结构摘要 + 最近 mtime 文件（top 10），verdict 标注 `not-a-git-repo`
- 大仓库/超大 diff：topFiles 截断到 15 并标注 `truncated: true`
- 缓存 10s

### 预期收益

- git-inspect 类 shell 链（4.3M token）压缩为单次调用；top-10% turn 探索链缩短
- **实现成本：低**（~150 行 TS，git porcelain 输出解析，无 shell 依赖）

---

## T2 `verify_change` — 改动后最小验证（砍验证循环）

**目标**：把"改→构建→看日志→解读→再改"循环压缩为一次调用。验证推理 10.6% + pwsh→pwsh 链（13.6 万 token）+ 91 次构建失败重跑。

### 接口

```typescript
parameters: {
  scope?: "auto" | "files" | "project",   // 默认 auto：按 git diff 检测
  files?: string[],                       // scope=files 时显式列表
  runTests?: boolean,                     // 默认 true
  runBuild?: boolean,                     // 默认 true
  lint?: boolean,                         // 默认 false（慢）
  focus?: "affected" | "all",             // 默认 affected
  maxSec?: number,                        // 默认 120；超时返回部分结果
}
```

### 行为

1. **项目探测（跨平台，直接 spawn 各工具链二进制）**：

| 信号 | 工具链 | 验证命令 |
|---|---|---|
| `*.sln` / SDK-style `*.csproj` | dotnet | `dotnet build` + `dotnet test --filter` |
| `Cargo.toml` | cargo | `cargo check` + `cargo test` |
| `go.mod` | go | `go build ./...` + `go test ./...` |
| `package.json` | npm/pnpm | `npm run build`（存在时）+ `npm test` |
| 其他/未知 | — | 只类型检查（如 `tsc --noEmit`），verdict 标注 `partial` |

2. **可配置覆盖（通用性关键）**：项目 `.pi/` 下可选 `verify-change.json`（或包 manifest）声明自定义验证命令：
   ```json
   { "build": "powershell -File .\\build.ps1", "tests": "powershell -File .\\scripts\\vscode\\test-koishi-tests.ps1" }
   ```
   覆盖默认探测——legacy .NET Framework WPF 项目（KoishiNavigation.csproj 等）无需改代码。
3. **受影响范围**：`git diff --name-only` + 文件→测试映射（测试类名含被测类名；有索引时用符号引用图）
4. **验证链**：build（增量）→ 类型检查 → 受影响测试，多阶段并行
5. **返回结构化判定**：

```
{
  verdict: "fail",                                   // pass | fail | error | skipped | partial
  stages: [
    { name: "build", status: "pass", sec: 12.3 },
    { name: "tests", status: "fail", sec: 45.1,
      failed: [{ test: "CookingTests.AutoCost", file: "Tests/CookingTests.cs", line: 120,
                 reason: "expected 5, got 4" }] }
  ],
  changedFiles: [...],
  affectedTests: [...],                              // 选了哪些测试 + 为什么
  raw: "..."                                         // 折叠原始输出（details）
}
```

### 边界

- 无 git 且 scope=auto → error（要求 scope=files）
- 工具链缺失（dotnet/cargo/go 未装）→ skipped + 说明（env_probe 已可预知）
- 长任务：后台 + `onUpdate` 进度；maxSec 超时返回已完成阶段 + `timedOut: true`
- 测试选择保守：拿不准多选不遗漏
- 失败判定三态：编译错=fail；工具自身异常=error；缺依赖=skipped

### 预期收益

- pwsh→pwsh 链（13.6 万推理）大部分被单次 verify_change 替代；"解读构建日志"的推理消除
- **实现成本：中**（项目探测 + 测试选择 + 结构化解析，~300 行 TS）

---

## T3 `decide` — 结构化决策（外化规划）

**目标**：65% 的 thinking 是"规划下一步"。把分支权衡外化为结构化决策。

### 接口

```typescript
parameters: {
  question: string,                       // 要决策的问题
  options?: string[],                     // 候选方案
  context?: string,                       // 关键事实（可选）
  resolveWith?: "tools" | "user"          // 默认 tools
}
```

### 输出

```
{
  options: [
    { id: "A", summary: "...", pros: [...], cons: [...], cost: "low", risk: "high", evidence: ["file:line"] },
    ...
  ],
  recommendation: "A",
  reason: "...",
  openQuestions: ["..."]                  // 信息不足时列出，不猜测
}
```

### 行为与边界

- 纯结构化，**平台无关**；证据绑定 `file:line` 可审计；`resolveWith:"user"` 走用户确认
- 协议引导：仅真实分支时调用，每 turn 限 1-2 次
- openQuestions 对应 13.5% 的 guess-unknown——先补信息再决策
- 与 user_decision_add 联动：确认后落为持久决策

### 预期收益

- thinking 中"权衡分支"缩短；决策可审计；与记忆层联动避免重复权衡
- **实现成本：低**（~100 行 TS）；收益依赖模型自律，**风险最高**

---

## T4 `read_many` — 批量语义读取（压缩 read×N）

**目标**：top-10% turn 的特征是 `read×10-15`，每次 read 后规划成本 743/turn（r/o 0.91）。

### 设计：两个层面

1. **协议强化**（TG2 已注入）：大 turn 探索首选用 `ctx_compose`
2. **补充工具 `read_many`**：

```typescript
parameters: {
  paths: string[],                       // 2-20 个文件
  symbols?: string[],                    // 可选：只取这些符号
  maxLinesPerFile?: number,              // 默认 120
  outlineOnly?: boolean,                 // 默认 true
}
```

### 输出

```
{
  files: [
    { path: "GameMap.xaml.cs", lines: 1240, symbols: [
        { kind: "class", name: "GameMap", line: 5, signature: "partial class GameMap : UserControl" },
        { kind: "method", name: "MovePlayer", line: 120, signature: "void MovePlayer(Vector2 dir)" },
      ] },
    ...
  ]
}
```

### 行为

- 摘要给"结构"不给"全文"（token 省 60-80%）；按需下钻单符号
- **跨平台**：语言无关树解析（复用 lean-ctx 索引 / tree-sitter），不依赖 shell
- 与 module_report 的关系：单文件大纲 → read_many 是跨文件批量大纲
- 若 lean-ctx 已有等价能力（ctx_read map 模式批量版），则退化为协议引导

### 预期收益

- 大 turn 探索从 read×15 → read_many×1 + 精准下钻；读后分析成本下降
- **实现成本：中**（~200 行 TS，依赖树解析可用性）

---

## 实施顺序与依赖

| 顺序 | 工具 | 杠杆 | 成本 | 平台依赖 |
|---|---|---|---|---|
| 1 | T2 verify_change | 最高 | 中 | 无（spawn 各工具链） |
| 2 | T1 repo_state | 高 | 低 | 无（spawn git） |
| 3 | T4 read_many | 高 | 中 | lean-ctx 索引能力 |
| 4 | T3 decide | 中 | 低 | 无 |

T1/T2/T4 可独立并行；T3 建议最后。发布节奏：每个工具独立版本号（0.x），README/DESIGN 同步。

## 度量验证（实现后如何确认推理缩短）

重跑 `~/.pi/agent/sessions/_analysis/analyze2.py` + `analyze6.py`（注意：这些脚本是**本机分析工具**，不属于发布的包；发布包带 `test/smoke-test.cjs` 回归测试即可）：

1. bigram 推理成本：`ctx_shell→ctx_shell`、`pwsh→pwsh`、`ctx_read→ctx_read` 是否下降
2. 工具错误率：pwsh exit-code、edit anchor-miss 是否下降
3. 每 turn 推理 p50/p90 是否下移
4. 新工具采纳率：verify_change/repo_state 调用次数、替代了多少次 pwsh/ctx_shell
5. thinking 分类：plan-forward 占比是否下降

观察窗口：实现后 2-4 周（协议需模型适应期）。
