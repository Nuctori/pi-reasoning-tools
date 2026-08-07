# pi-repo-state

Lightweight, on-demand git repository snapshot for pi agents — **without** the costs of the community alternative.

## Why this exists

We audited `pi-git-context` (the community git-state package) over a 122-session window and found three problems:

1. **Crash**: it uses a module-captured `ctx` in `updateFooter` — on session replacement/reload the `ctx.ui` getter throws `stale ExtensionContext`, which killed 3/3 parallel subagents in our run (reported upstream: [h14h/pi-packages#3](https://github.com/h14h/pi-packages/issues/3)).
2. **46% shell polling**: per-prompt snapshot injection turned 46% of all `ctx_shell` calls into git polling (a single `git log` command repeated 1,285× in one window).
3. **Cache-prefix breakage**: every snapshot change invalidates the prompt-cache prefix, forcing re-processing of the changed tail on each prompt.

`pi-repo-state` is the opposite design: **on-demand, no injection, no TUI, no captured ctx.**

## Install

```bash
pi install npm:pi-repo-state      # once published
pi install /path/to/packages/pi-repo-state   # local dev
```

Then `/reload` or start a new session.

## Tool: `repo_state`

| | |
|---|---|
| Parameters | `{ force?: boolean, depth?: "quick" \| "full" }` — 3s cache |
| Returns | verdict-first snapshot: `repo:` / `branch: <name> — ahead N / behind M (upstream X)` / `dirty: N modified, N staged, N untracked, N deleted[, N CONFLICTS]` / `diff: +N/-N across N files (top files)` / `recent: <sha> <subject>` / `remote:` / `worktrees:` |
| Non-repo | clear verdict `not a git repository` (no guessing) |
| Implementation | directly spawns `git -C <cwd>` — cross-platform, no shell wrapping; all fields parallel; failures degrade per-field |

```
repo: D:/cs/KoishiNavigationRebuildMain
branch: main — ahead 2 / behind 0 (upstream origin/main)
dirty: 6 modified, 3 staged, 31 untracked, 1 deleted
diff: +214/-87 across 12 files
  top: GameMap.xaml.cs (+120/-40), SettingWindow.xaml (+30/-5), ...
recent: abc1234 fix: hot path alloc | def5678 feat: settings window
remote: cnb.cool/.../koishiNavigationEvo
```

## Design decisions (vs pi-git-context)

| | pi-git-context | pi-repo-state |
|---|---|---|
| Trigger | inject every prompt | on demand (model calls it) |
| Ongoing cost | 46% of shell calls were git polling | zero until called |
| Cache prefix | broken on each snapshot change | never touches the prompt |
| TUI / ctx capture | footer via captured ctx (crash) | none |
| Shell | uses shell wrapping | direct `git` spawn |

## Test

```bash
npm install && node test/smoke-test.cjs
```

## License

MIT
