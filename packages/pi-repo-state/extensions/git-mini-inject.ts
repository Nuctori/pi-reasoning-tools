/**
 * git-mini-inject — minimal one-line git state injection at turn 0.
 *
 * Why (evidence-driven): an audit of 122 sessions found 26% of user prompts
 * were followed by a shell call, 14% of which were git polling — the model
 * habitually re-confirms repository state at the start of every request.
 * pi-git-context solved this by injecting a FULL snapshot on EVERY prompt:
 * 46% of all ctx_shell calls became git polling, each snapshot change broke
 * the prompt-cache prefix, and its captured-ctx footer crashed on session
 * replacement.
 *
 * This is the minimal design:
 *   - ONE line (~60-90 tokens): branch (sha) · dirty counts · upstream state
 *   - Injected ONLY at turn 0 (first LLM call of a user request), appended at
 *     the END of the message array — a change only invalidates a tiny suffix
 *   - Turn > 0: injection stripped (model uses the on-demand `repo_state`
 *     tool for fresh detail mid-turn)
 *   - No TUI, no module-captured ctx, no persisted session pollution
 *   - Opt out: PI_REPO_STATE_INJECT=off
 */
interface ExecResult { stdout: string; stderr: string; code: number; killed?: boolean; }

interface MinimalPi {
  on(event: string, handler: (...args: any[]) => any): void;
  exec(command: string, args?: string[], options?: { timeout?: number }): Promise<ExecResult>;
}

interface Ctx { cwd: string; }

const CUSTOM_TYPE = "repo-state-mini";
const GIT_TIMEOUT = 3000;

interface MiniState {
  branch: string | null;
  sha: string | null;
  upstream: string | null;
  ahead: number | null;
  behind: number | null;
  dirty: { modified: number; staged: number; untracked: number; deleted: number; conflicts: number } | null;
}

export default function gitMiniInject(pi: MinimalPi) {
  let currentTurnIndex = -1;
  let cached: { at: number; cwd: string; state: MiniState } | null = null;

  async function git(ctx: Ctx, args: string[]): Promise<{ ok: boolean; out: string; err: string }> {
    try {
      const r = await pi.exec("git", ["-C", ctx.cwd, ...args], { timeout: GIT_TIMEOUT });
      return { ok: r.code === 0 && !r.killed, out: r.stdout || "", err: r.stderr || "" };
    } catch (e) {
      return { ok: false, out: "", err: String((e as Error)?.message || e) };
    }
  }

  async function probe(ctx: Ctx): Promise<MiniState | null> {
    if (cached && cached.cwd === ctx.cwd && Date.now() - cached.at < 3000) {
      return cached.state;
    }
    const [workTree, branch, sha, status, upstream, ab] = await Promise.all([
      git(ctx, ["rev-parse", "--is-inside-work-tree"]),
      git(ctx, ["rev-parse", "--abbrev-ref", "HEAD"]),
      git(ctx, ["rev-parse", "--short", "HEAD"]),
      git(ctx, ["status", "--porcelain=v1"]),
      git(ctx, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]),
      git(ctx, ["rev-list", "--left-right", "--count", "HEAD...@{upstream}"]),
    ]);
    if (!(workTree.ok && workTree.out.trim() === "true")) {
      cached = { at: Date.now(), cwd: ctx.cwd, state: null };
      return null;
    }

    let modified = 0, staged = 0, untracked = 0, deleted = 0, conflicts = 0;
    for (const line of status.out.split("\n")) {
      if (!line.trim()) continue;
      const x = line[0], y = line[1];
      const xy = x + y;
      if (xy === "??") { untracked++; continue; }
      if (x === "U" || y === "U" || (x === y && (x === "A" || x === "D"))) { conflicts++; continue; }
      if (x !== " " && x !== "?") {
        if (x === "D") deleted++;
        else if ("MARC".includes(x)) staged++;
      }
      if (y !== " " && y !== "?") {
        if (y === "D") deleted++;
        else if ("MARC".includes(y)) modified++;
      }
    }

    let ahead: number | null = null, behind: number | null = null;
    const upstreamName = upstream.ok ? upstream.out.trim() : null;
    if (upstreamName && ab.ok) {
      const [l, r] = ab.out.trim().split(/\s+/);
      ahead = parseInt(l || "0", 10);
      behind = parseInt(r || "0", 10);
    }

    const state: MiniState = {
      branch: branch.ok ? branch.out.trim() : null,
      sha: sha.ok ? sha.out.trim() : null,
      upstream: upstreamName,
      ahead, behind,
      dirty: status.ok
        ? { modified, staged, untracked, deleted, conflicts }
        : null, // status failed/timeout — never claim "clean" on unknown
    };
    cached = { at: Date.now(), cwd: ctx.cwd, state };
    return state;
  }

  function render(s: MiniState): string {
    const dirtyPart = s.dirty
      ? `${s.dirty.modified}m/${s.dirty.staged}s/${s.dirty.untracked}u/${s.dirty.deleted}d${s.dirty.conflicts ? `/${s.dirty.conflicts}c` : ""}`
      : "dirty ?/?/?/?";
    const branchPart = `${s.branch ?? "?"}${s.sha ? ` (${s.sha})` : ""}`;
    const upstreamPart = s.upstream
      ? `ahead ${s.ahead ?? "?"}/behind ${s.behind ?? "?"} (${s.upstream})`
      : "no upstream";
    return `[git] ${branchPart} · dirty ${dirtyPart} · ${upstreamPart}`;
  }

  pi.on("turn_start", (event: { turnIndex: number }) => {
    currentTurnIndex = event.turnIndex;
  });

  pi.on("agent_end", () => {
    currentTurnIndex = -1;
  });

  pi.on("session_start", () => {
    currentTurnIndex = -1;
    cached = null;
  });

  pi.on("context", async (event: { messages: any[] }, ctx: Ctx) => {
    // strip all previously injected mini snapshots
    const filtered = event.messages.filter((m) => {
      if (m.role !== "custom") return true;
      return m.customType !== CUSTOM_TYPE;
    });

    // only inject on turn 0 (first LLM call of a user request)
    if (currentTurnIndex !== 0) return { messages: filtered };
    if (process.env.PI_REPO_STATE_INJECT === "off") return { messages: filtered };

    const s = await probe(ctx);
    if (!s) return { messages: filtered };

    filtered.push({
      role: "custom",
      customType: CUSTOM_TYPE,
      content: render(s),
      display: false,
      details: {},
      timestamp: Date.now(),
    });
    return { messages: filtered };
  });
}
