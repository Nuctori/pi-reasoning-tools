# pi-code-intel-guide

Guide your pi agent to the dedicated code-intelligence toolchain instead of shell search.

- **Protocol injection**: each prompt prepends the retrieval order `symbol_search → ctx_compose → module_report/read_symbol → ctx_grep`; shell search demoted to last resort.
- **Interception**: recursive code-search in `ctx_shell` / `bash` / `pwsh` / `shell` (`rg`, `grep -r`, `find -name '*.cs'`, `Select-String -Recurse`) is blocked (bounded to 2 per session) with a redirect to dedicated tools. Non-recursive uses (`git grep`, `grep file.txt`, pipeline filtering, `grep -v`) pass through.

**Evidence** (from a 115-session corpus): 10,640 shell search-read calls burned 8.8M tokens while `ctx_compose` was used 4×, `module_report` 4×, `symbol_search` 0×. Reading is where the model reasons hardest (r/o ratio 0.91), so every wasted discovery round-trip multiplies reasoning cost.

## Install

```bash
pi install npm:pi-code-intel-guide      # once published
pi install git:github.com/<you>/pi-code-intel-guide   # or from git
```

Then `/reload` or start a new session. No callable tool — behavior only.

## Cross-platform

- Target tools are the pi/lean-ctx standard set, present on Linux/macOS/Windows
- English by default; Simplified-Chinese when `LANG`/`LC_ALL`/`LC_MESSAGES`/`LANGUAGE` contains `zh`

## Test

```bash
npm install && node test/smoke-test.cjs
```

## License

MIT
