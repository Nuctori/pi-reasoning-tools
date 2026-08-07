/**
 * env-probe (TG1): environment capability matrix.
 *
 * Problem (from a 115-session corpus analysis):
 *   - 352/389 ctx_grep calls failed with "rg: command not found" (PATH drift)
 *   - 148 ctx_shell calls blocked by shell allowlist (python heredoc, cmp, ...)
 *   - "Author identity unknown" git failures, build toolchain discovery loops
 *   - The model re-discovers the environment in every session (trial-and-error)
 *
 * Fix:
 *   - `env_probe` tool: one call returns the full capability matrix + known
 *     pitfalls, instead of the model probing blindly with shell commands.
 *   - `before_agent_start`: inject a compact capability summary on the first
 *     user prompt of each session, so the model never blind-probes.
 *
 * Cross-platform: POSIX shell (bash -> sh) for probing, English output by
 * default with automatic Simplified-Chinese when the locale indicates zh.
 */
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";

/* ----------------------------- i18n ------------------------------------- */

type Lang = "en" | "zh";
const STR = {
  en: {
    matrixHeader: "=== Environment capability matrix (env_probe) ===",
    available: "[ok]",
    missing: "[missing]",
    gitIdentity: "git identity",
    leanCtx: "lean-ctx config",
    shellSecurity: "shell security",
    allowlistCount: "allowlist extra commands",
    pitfallsHeader: "=== Known pitfalls ===",
    missingBins: (names: string) =>
      `- Missing binaries: ${names}. Do not blind-probe with shell; install or fix PATH if the task needs them.`,
    gitIdentityMissing:
      '- git identity not configured: run `git config --global user.name "..."` / `git config --global user.email "..."` before committing.',
    heredocBlocked:
      "- Python heredoc / inline (-c) is blocked by shell security rules: write a script file first, then run `python file.py`.",
    allowlistHint:
      '- When a command is blocked by the shell allowlist, add it with `lean-ctx allow <cmd>` instead of switching tools blindly.',
    compactPrefix: "[env-probe]",
    compactOk: "env:", 
    compactMissing: "missing:",
    compactNoIdentity: "git identity not set (user.name/email)",
    compactDetailHint: "(full matrix: call env_probe; use force=true after environment changes)",
    probeFailed: "Environment probe failed (no usable POSIX shell: tried bash, sh).",
  },
  zh: {
    matrixHeader: "=== 环境能力矩阵 (env_probe) ===",
    available: "[可用]",
    missing: "[缺失]",
    gitIdentity: "git 身份",
    leanCtx: "lean-ctx 配置",
    shellSecurity: "shell 安全",
    allowlistCount: "allowlist extra 命令数",
    pitfallsHeader: "=== 已知坑 ===",
    missingBins: (names: string) =>
      `- 缺失二进制: ${names}。勿用 shell 盲试; 项目需要时先安装或确认 PATH。`,
    gitIdentityMissing:
      '- git 身份未配置: 提交前先 `git config --global user.name "..."` / `git config --global user.email "..."`。',
    heredocBlocked:
      "- python heredoc/内联(-c) 会被 shell 安全规则拦截: 先 write 脚本文件再 `python file.py`。",
    allowlistHint:
      "- 需要新 shell 命令时用 `lean-ctx allow <cmd>` 加入 allowlist, 而非换工具盲试。",
    compactPrefix: "[env-probe]",
    compactOk: "环境能力:",
    compactMissing: "缺失:",
    compactNoIdentity: "git 身份未配置(user.name/email)",
    compactDetailHint: "(详细矩阵可随时调用 env_probe; 环境变化后带 force=true 重新探测)",
    probeFailed: "环境探测失败(未找到可用的 POSIX shell: 已尝试 bash、sh)。",
  },
} as const;

function detectLang(): Lang {
  const probe = [process.env.LANG, process.env.LC_ALL, process.env.LC_MESSAGES, process.env.LANGUAGE]
    .filter(Boolean)
    .join(" ");
  return /zh/i.test(probe) ? "zh" : "en";
}

/* --------------------------- probing ------------------------------------ */

const PROBE_SCRIPT = String.raw`
set +e
probe() {
  local name="$1"
  local bin
  bin=$(command -v "$name" 2>/dev/null)
  if [ -n "$bin" ]; then
    local ver
    ver=$("$name" --version 2>/dev/null | head -1 | tr '\n' ' ' | cut -c1-64)
    if [ -z "$ver" ]; then
      ver=$("$name" version 2>/dev/null | head -1 | tr '\n' ' ' | cut -c1-64)
    fi
    printf '{"name":"%s","bin":"%s","ver":"%s"}\n' "$name" "$bin" "$ver"
  else
    printf '{"name":"%s","bin":null,"ver":""}\n' "$name"
  fi
}
for n in rg python dotnet git node npm pnpm cargo go lua java; do probe "$n"; done
`;

interface ProbeEntry { name: string; bin: string | null; ver: string; }
interface ProbeResult {
  at: number;
  entries: ProbeEntry[];
  gitName: string | null;
  gitEmail: string | null;
  allowlist: string[];
  shellSecurity: string | null;
  leanCtxConfig: string | null;
}

interface ExecResult { stdout: string; stderr: string; code: number; }

interface MinimalPi {
  on(event: string, handler: (...args: any[]) => any): void;
  registerTool(def: any): void;
  exec(command: string, args?: string[], options?: { timeout?: number }): Promise<ExecResult>;
}

/** Try POSIX shells in order: bash -> sh. Returns null if none works. */
async function runPosix(pi: MinimalPi, script: string, timeoutMs: number): Promise<ExecResult | null> {
  for (const shell of ["bash", "sh"]) {
    try {
      const r = await pi.exec(shell, ["-lc", script], { timeout: timeoutMs });
      // shell missing -> stderr contains "not found" / "No such file"
      if (r.stderr && /not found|No such file|not recognized/i.test(r.stderr) && !r.stdout) {
        continue;
      }
      return r;
    } catch {
      continue;
    }
  }
  return null;
}

function parseProbeOutput(stdout: string): ProbeEntry[] {
  const entries: ProbeEntry[] = [];
  for (const line of stdout.split("\n")) {
    const t = line.trim().replace(/\r/g, "");
    if (!t.startsWith("{")) continue;
    try {
      const o = JSON.parse(t);
      entries.push({ name: o.name, bin: o.bin, ver: o.ver || "" });
    } catch {
      /* skip malformed lines */
    }
  }
  return entries;
}

function readLeanCtxConfig(): { path: string | null; allowlist: string[]; security: string | null } {
  const candidates = [
    process.env.LEAN_CTX_CONFIG,
    join(homedir(), ".config", "lean-ctx", "config.toml"),
    join(homedir(), ".lean-ctx", "config.toml"),
  ].filter(Boolean) as string[];
  for (const p of candidates) {
    if (!existsSync(p)) continue;
    try {
      const text = readFileSync(p, "utf-8");
      const allowlist: string[] = [];
      const m = text.match(/shell_allowlist(?:_extra)?\s*=\s*\[([^\]]*)\]/g) || [];
      for (const block of m) {
        const inner = block.match(/\[([^\]]*)\]/)?.[1] || "";
        for (const q of inner.match(/"([^"]+)"/g) || []) {
          allowlist.push(q.slice(1, -1).trim());
        }
      }
      const sec = text.match(/shell_security\s*=\s*"(\w+)"/)?.[1] ?? null;
      return { path: p, allowlist, security: sec };
    } catch {
      /* ignore unreadable config */
    }
  }
  return { path: null, allowlist: [], security: null };
}

export default function envProbeExtension(pi: MinimalPi) {
  const lang: Lang = detectLang();
  const S = STR[lang];
  let probePromise: Promise<ProbeResult | null> | null = null;
  let cached: ProbeResult | null = null;
  let injectedThisSession = false;

  async function runProbe(): Promise<ProbeResult | null> {
    const [probeOut, gitNameOut, gitEmailOut] = await Promise.all([
      runPosix(pi, PROBE_SCRIPT, 8000),
      runPosix(pi, 'git config --get user.name 2>/dev/null', 4000),
      runPosix(pi, 'git config --get user.email 2>/dev/null', 4000),
    ]);
    if (!probeOut) return null;
    const cfg = readLeanCtxConfig();
    return {
      at: Date.now(),
      entries: parseProbeOutput(probeOut.stdout || ""),
      gitName: (gitNameOut?.stdout || "").trim() || null,
      gitEmail: (gitEmailOut?.stdout || "").trim() || null,
      allowlist: cfg.allowlist,
      shellSecurity: cfg.security,
      leanCtxConfig: cfg.path,
    };
  }

  function ensureProbe(): Promise<ProbeResult | null> {
    if (cached && Date.now() - cached.at < 5 * 60_000) return Promise.resolve(cached);
    if (!probePromise) {
      probePromise = runProbe().then((r) => {
        cached = r;
        probePromise = null;
        return r;
      });
    }
    return probePromise;
  }

  function formatMatrix(r: ProbeResult, compact: boolean): string {
    if (compact) {
      const ok = r.entries.filter((e) => e.bin).map((e) => `${e.name}${e.ver ? "@" + e.ver.slice(0, 12) : ""}`);
      const missing = r.entries.filter((e) => !e.bin).map((e) => e.name);
      const parts = [`${S.compactOk} ${ok.length ? ok.join(", ") : "-"}`];
      if (missing.length) parts.push(`${S.compactMissing} ${missing.join(", ")}`);
      if (!r.gitName || !r.gitEmail) parts.push(S.compactNoIdentity);
      return `${S.compactPrefix} ${parts.join("; ")}. ${S.compactDetailHint}`;
    }
    const lines: string[] = [S.matrixHeader];
    for (const e of r.entries) {
      lines.push(`  ${e.bin ? S.available : S.missing} ${e.name}${e.ver ? " " + e.ver : ""}${e.bin ? "  @" + e.bin : ""}`);
    }
    lines.push(`  ${S.gitIdentity}: ${r.gitName || "?"} <${r.gitEmail || "?"}>`);
    lines.push(`  ${S.leanCtx}: ${r.leanCtxConfig || "(not found)"}`);
    lines.push(`  ${S.shellSecurity}: ${r.shellSecurity ?? "default"}; ${S.allowlistCount}: ${r.allowlist.length}`);
    lines.push("");
    lines.push(S.pitfallsHeader);
    const missingNames = r.entries.filter((e) => !e.bin).map((e) => e.name);
    if (missingNames.length) lines.push(S.missingBins(missingNames.join(", ")));
    if (!r.gitName || !r.gitEmail) lines.push(S.gitIdentityMissing);
    lines.push(S.heredocBlocked);
    lines.push(S.allowlistHint);
    return lines.join("\n");
  }

  pi.on("session_start", () => {
    injectedThisSession = false;
    void ensureProbe();
  });

  pi.on("before_agent_start", async (event) => {
    if (injectedThisSession) return;
    const result = await Promise.race([
      ensureProbe(),
      new Promise<null>((res) => setTimeout(() => res(null), 2500)),
    ]);
    if (result) {
      injectedThisSession = true;
      return { systemPrompt: event.systemPrompt + "\n\n" + formatMatrix(result, true) };
    }
    return undefined;
  });

  pi.registerTool({
    name: "env_probe",
    label: "Env Probe",
    description:
      "Probe the machine capability matrix: core binaries (rg/python/dotnet/git/node/go/lua etc.) availability + versions, git identity, shell allowlist state, known pitfalls and fixes. Do not blind-probe the environment with shell commands; call this first or after a 'command not found' failure. Use force=true to re-probe after environment changes.",
    promptSnippet: "Return the machine capability matrix (binaries, git identity, shell allowlist) with known pitfalls",
    promptGuidelines: [
      "Use env_probe at the start of a task or whenever a command fails with 'command not found' / 'not recognized' — do not blind-probe the environment with shell commands.",
    ],
    parameters: Type.Object({
      force: Type.Optional(Type.Boolean({ description: "Force re-probe (default: reuse cache from last 5 minutes)" })),
    }),
    async execute(_toolCallId, params) {
      if (params.force) {
        cached = null;
        probePromise = null;
      }
      const r = await ensureProbe();
      if (!r) {
        return {
          content: [{ type: "text", text: S.probeFailed }],
          isError: true,
        };
      }
      return {
        content: [{ type: "text", text: formatMatrix(r, false) }],
        details: {
          entries: r.entries,
          gitName: r.gitName,
          gitEmail: r.gitEmail,
          shellSecurity: r.shellSecurity,
          allowlistCount: r.allowlist.length,
        },
      };
    },
  });
}
