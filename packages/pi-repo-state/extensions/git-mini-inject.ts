/**
 * git-mini-inject — high-density project version/iteration snapshot at turn 0.
 *
 * Why (evidence-driven): an audit of 122 sessions found 26% of user prompts
 * were followed by a shell call, 14% of which were git polling — the model
 * habitually re-confirms repository state at the start of every request.
 * pi-git-context solved this by injecting a FULL snapshot on EVERY prompt:
 * 46% of all ctx_shell calls became git polling, each snapshot change broke
 * the prompt-cache prefix, and its captured-ctx footer crashed on session
 * replacement.
 *
 * This is the minimal mechanism with HIGH information density:
 *   - One compact block (~180-220 chars): remote · default branch (ahead/behind
 *     vs origin) · current branch (+N commits from default = iteration distance)
 *     · version · dirty counts · worktree topology (linked? primary? total)
 *   - Injected ONLY at turn 0 (first LLM call of a user request), appended at
 *     the END of the message array — a change only invalidates a tiny suffix
 *   - Turn > 0: injection stripped (model uses the on-demand `repo_state`
 *     tool for fresh detail mid-turn)
 *   - No TUI, no module-captured ctx, no persisted session pollution
 *   - Opt out: PI_REPO_STATE_INJECT=off
 *   - If `git status` times out (>3s), dirty shows ?/?/?/? — never claims clean
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
  remote: string | null;
  defaultBranch: string | null;
  defaultSha: string | null;
  defaultAhead: number | null;
  defaultBehind: number | null;
  branch: string | null;
  sha: string | null;
  commitsFromDefault: number | null;
  version: string | null;
  upstream: string | null;
  ahead: number | null;
  behind: number | null;
  currentIsLinked: boolean;
  worktreeCount: number;
  primaryWorktree: string | null;
  dirty: { modified: number; staged: number; untracked: number; deleted: number; conflicts: number } | null;
}

export default function gitMiniInject(pi: MinimalPi) {
  let currentTurnIndex = -1;
  let cached: { at: number; cwd: string; state: MiniState | null } | null = null;

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
    const [workTree, branch, sha, status, upstream, remote, defHead, wtList] = await Promise.all([
      git(ctx, ["rev-parse", "--is-inside-work-tree"]),
      git(ctx, ["rev-parse", "--abbrev-ref", "HEAD"]),
      git(ctx, ["rev-parse", "--short", "HEAD"]),
      git(ctx, ["status", "--porcelain=v1"]),
      git(ctx, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]),
      git(ctx, ["remote", "get-url", "origin"]),
      git(ctx, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]),
      git(ctx, ["worktree", "list", "--porcelain"]),
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
    if (upstreamName) {
      const ab = await git(ctx, ["rev-list", "--left-right", "--count", "HEAD...@{upstream}"]);
      if (ab.ok) {
        const [l, r] = ab.out.trim().split(/\s+/);
        ahead = parseInt(l || "0", 10);
        behind = parseInt(r || "0", 10);
      }
    }

    // default branch (origin/HEAD) + its ahead/behind vs origin/<default>
    const defaultBranchRaw = defHead.ok && defHead.out.trim() ? defHead.out.trim() : null;
    // symbolic-ref refs/remotes/origin/HEAD yields "origin/master" — strip the origin/ prefix
    const defaultBranch = defaultBranchRaw ? defaultBranchRaw.replace(/^origin\//, "") : null;
    let defaultAhead: number | null = null, defaultBehind: number | null = null, defaultSha: string | null = null;
    let commitsFromDefault: number | null = null;
    if (defaultBranch) {
      const [dSha, dAb, dCount] = await Promise.all([
        git(ctx, ["rev-parse", "--short", `refs/remotes/origin/${defaultBranch}`]),
        git(ctx, ["rev-list", "--left-right", "--count", `${defaultBranch}...refs/remotes/origin/${defaultBranch}`]),
        git(ctx, ["rev-list", "--count", `refs/remotes/origin/${defaultBranch}..HEAD`]),
      ]);
      if (dSha.ok) defaultSha = dSha.out.trim();
      if (dAb.ok) {
        const [l, r] = dAb.out.trim().split(/\s+/);
        defaultAhead = parseInt(l || "0", 10);
        defaultBehind = parseInt(r || "0", 10);
      }
      if (dCount.ok) commitsFromDefault = parseInt(dCount.out.trim(), 10) || 0;
    }

    // version: package.json (project root) then git describe fallback
    let version: string | null = null;
    const pkg = await git(ctx, ["show", "HEAD:package.json"]);
    if (pkg.ok) {
      const m = pkg.out.match(/"version"\s*:\s*"([^"]+)"/);
      if (m) version = `v${m[1]}`;
    }
    if (!version) {
      const desc = await git(ctx, ["describe", "--tags", "--always", "--abbrev=0"]);
      if (desc.ok && !/^[0-9a-f]{7,40}$/.test(desc.out.trim())) version = desc.out.trim();
    }

    // worktree topology
    let currentIsLinked = false;
    let worktreeCount = 1;
    let primaryWorktree: string | null = null;
    if (wtList.ok && wtList.out.trim()) {
      const worktrees = wtList.out.trim().split(/\n\n+/).filter(Boolean);
      worktreeCount = worktrees.length;
      const normal = worktrees.filter((w) => !w.includes("bare"));
      primaryWorktree = normal[0]?.match(/^worktree (.+)$/m)?.[1] ?? null;
      // current cwd is linked if it is NOT the primary worktree path
      const cwdNorm = ctx.cwd.replace(/\\/g, "/").replace(/\/+$/, "");
      currentIsLinked = primaryWorktree !== null && cwdNorm !== primaryWorktree.replace(/\\/g, "/").replace(/\/+$/, "");
    }

    const state: MiniState = {
      remote: remote.ok ? remote.out.trim().split("\n")[0] : null,
      defaultBranch, defaultSha, defaultAhead, defaultBehind,
      branch: branch.ok ? branch.out.trim() : null,
      sha: sha.ok ? sha.out.trim() : null,
      commitsFromDefault, version,
      upstream: upstreamName, ahead, behind,
      currentIsLinked, worktreeCount, primaryWorktree,
      dirty: status.ok
        ? { modified, staged, untracked, deleted, conflicts }
        : null,
    };
    cached = { at: Date.now(), cwd: ctx.cwd, state };
    return state;
  }

  function render(s: MiniState): string {
    const parts: string[] = [];
    if (s.remote) {
      const r = s.remote.replace(/^https?:\/\/(www\.)?/, "").replace(/\.git$/, "");
      parts.push(`remote ${r}`);
    }
    if (s.defaultBranch) {
      parts.push(`default ${s.defaultBranch}${s.defaultSha ? ` (${s.defaultSha})` : ""}${s.defaultAhead != null ? ` ahead${s.defaultAhead}/b${s.defaultBehind ?? 0}` : ""}`);
    }
    const branchPart = `${s.branch ?? "?"}${s.sha ? ` (${s.sha})` : ""}`;
    const iterPart = s.commitsFromDefault != null && s.defaultBranch
      ? ` +${s.commitsFromDefault} from ${s.defaultBranch}`
      : "";
    const upstreamPart = s.upstream ? ` · ahead${s.ahead ?? "?"}/b${s.behind ?? "?"}` : "";
    parts.push(`branch ${branchPart}${iterPart}${upstreamPart}`);
    if (s.version) parts.push(`ver ${s.version}`);
    if (s.dirty) {
      const d = s.dirty;
      parts.push(`dirty ${d.modified}m/${d.staged}s/${d.untracked}u/${d.deleted}d${d.conflicts ? `/${d.conflicts}c` : ""}`);
    } else {
      parts.push("dirty ?/?/?/?");
    }
    if (s.worktreeCount > 1) {
      parts.push(`wt ${s.currentIsLinked ? "linked" : "primary"} (${s.worktreeCount} total${s.primaryWorktree ? `, primary ${s.primaryWorktree}` : ""})`);
    }
    return `[iter] ${parts.join(" | ")}`;
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
    const filtered = event.messages.filter((m) => {
      if (m.role !== "custom") return true;
      return m.customType !== CUSTOM_TYPE;
    });

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
