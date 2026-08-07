# pi-env-probe

Stop your pi agent from blind-probing the environment. One tool call returns the machine capability matrix; a compact summary is injected at session start so the model never wastes turns discovering what's installed.

**Evidence** (from a 115-session corpus): 352/389 `ctx_grep` calls failed with "rg: command not found" (PATH drift); 148 `ctx_shell` calls were blocked by the shell allowlist; "Author identity unknown" git failures recurred.

## Install

```bash
pi install npm:pi-env-probe      # once published
pi install git:github.com/<you>/pi-env-probe   # or from git
```

Then `/reload` or start a new session.

## Tool: `env_probe`

| | |
|---|---|
| Parameters | `{ force?: boolean }` — default reuses a 5-minute cache |
| Returns | availability + versions of `rg python dotnet git node npm pnpm cargo go lua java`; git identity (`user.name`/`user.email`); lean-ctx shell allowlist state; known pitfalls with fixes |
| Auto | first user prompt of each session gets a one-line capability summary injected into the system prompt |

```
=== Environment capability matrix (env_probe) ===
  [ok] rg ripgrep 15.2.0 (rev e89fff89ac)   @/c/Users/.../rg
  [ok] python Python 3.10.11   @/c/Users/.../python
  [missing] lua
  git identity: ? <?>
  ...
=== Known pitfalls ===
  - git identity not configured: run `git config --global user.name "..."` / ...
  - Python heredoc / inline (-c) is blocked by shell security rules: write a script file first.
  - When a command is blocked by the shell allowlist, add it with `lean-ctx allow <cmd>`.
```

## Cross-platform

- POSIX probing with `bash → sh` fallback (Linux / macOS / Windows with git-bash); explicit error if no POSIX shell exists
- No hard-coded paths; lean-ctx config via `LEAN_CTX_CONFIG` → `~/.config/lean-ctx/config.toml` → `~/.lean-ctx/config.toml`
- English by default; Simplified-Chinese when `LANG`/`LC_ALL`/`LC_MESSAGES`/`LANGUAGE` contains `zh`
- `typebox` / `@earendil-works/pi-coding-agent` are peer dependencies provided by pi itself

## Test

```bash
npm install && node test/smoke-test.cjs
```

## License

MIT
