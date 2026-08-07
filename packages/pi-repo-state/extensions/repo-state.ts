/**
 * repo_state — lightweight, on-demand git repository snapshot for pi agents.
 *
 * Why this exists (lessons from auditing pi-git-context):
 *   - pi-git-context injects a snapshot on EVERY prompt: a 122-session audit
 *     found 46% of all ctx_shell calls were git polling (one command repeated
 *     1,285x) and each snapshot change breaks the prompt-cache prefix.
 *   - It also crashes on session replacement (stale ExtensionContext in
 *     updateFooter) — killed 3/3 parallel subagents.
 *
 * This tool is the opposite design:
 *   - On-demand: the model calls it when it needs repository state — zero
 *     ongoing cost, no cache-prefix invalidation, no prompt inflation.
 *   - Directly spawns `git` (cross-platform, no shell wrapping).
 *   - Verdict-first output: structured conclusions, raw git output avoided.
 *   - No TUI footer, no module-captured ctx — nothing to go stale.
 *   - Short TTL cache (3s) so repeated calls in a turn are cheap.
 */
import { Type } from "typebox";

interface ExecResult { stdout: string; stderr: string; code: number; killed?: boolean; }

interface MinimalPi {
  registerTool(def: any): void;
  exec(command: string, args?: string[], options?: { timeout?: number }): Promise<ExecResult>;
}

interface Ctx { cwd: string; signal?: AbortSignal; }

const GIT_TIMEOUT = 4000;

interface RepoState {
  at: number;
  isRepo: boolean;
  gitMissing: boolean;
  cwd: string;
  branch: string | null;
  detached: boolean;
  upstream: string | null;
  ahead: number | null;
  behind: number | null;
  aheadUnknown: boolean;
  dirty: { modified: number; staged: number; untracked: number; deleted: number; conflicts: number };
  diff: { insertions: number; deletions: number; files: number; topFiles: string[] };
  recent: { sha: string; subject: string }[];
  remote: string | null;
  worktrees: { count: number; primary: string | null };
}

export default function repoStateExtension(pi: MinimalPi) {
  let cached: RepoState | null = null;

  async function git(ctx: Ctx, args: string[]): Promise<{ ok: boolean; out: string; err: string; killed?: boolean }> {
    try {
      const r = await pi.exec("git", ["-C", ctx.cwd, ...args], { timeout: GIT_TIMEOUT });
      // pi.exec can return {code:0, killed:true} on timeout — treat killed as failure to avoid silent empty snapshots
      return { ok: r.code === 0 && !r.killed, out: r.stdout || "", err: r.stderr || "", killed: r.killed };
    } catch (e) {
      return { ok: false, out: "", err: String((e as Error)?.message || e) };
    }
  }

  async function collect(ctx: Ctx): Promise<RepoState> {
    const [workTree, branch, status, upstream, numstat, log, remote, wtList] = await Promise.all([
      git(ctx, ["rev-parse", "--is-inside-work-tree"]),
      git(ctx, ["rev-parse", "--abbrev-ref", "HEAD"]),
      git(ctx, ["status", "--porcelain=v1"]),
      git(ctx, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]),
      git(ctx, ["-c", "core.quotePath=false", "diff", "--numstat"]),
      git(ctx, ["log", "--oneline", "-3"]),
      git(ctx, ["remote", "get-url", "origin"]),
      git(ctx, ["worktree", "list", "--porcelain"]),
    ]);

    const isRepo = workTree.ok && workTree.out.trim() === "true";
    if (!isRepo) {
      // distinguish "not a repo" from "git unavailable / other failure"
      const gitMissing = !workTree.ok && /ENOENT|not recognized|No such file/i.test(workTree.err);
      return {
        at: Date.now(), isRepo: false, gitMissing, cwd: ctx.cwd,
        branch: null, detached: false, upstream: null, ahead: null, behind: null, aheadUnknown: false,
        dirty: { modified: 0, staged: 0, untracked: 0, deleted: 0, conflicts: 0 },
        diff: { insertions: 0, deletions: 0, files: 0, topFiles: [] },
        recent: [], remote: null, worktrees: { count: 0, primary: null },
      };
    }

    // ahead/behind vs upstream
    let ahead: number | null = null, behind: number | null = null, aheadUnknown = false;
    const upstreamName = upstream.ok ? upstream.out.trim() : null;
    if (upstreamName) {
      const ab = await git(ctx, ["rev-list", "--left-right", "--count", "HEAD...@{upstream}"]);
      if (ab.ok) {
        const [l, r] = ab.out.trim().split(/\s+/);
        ahead = parseInt(l || "0", 10);
        behind = parseInt(r || "0", 10);
      } else {
        aheadUnknown = true;
      }
    }

    // dirty counts from porcelain v1 (XY status: X=index/staged, Y=worktree/unstaged)
    let modified = 0, staged = 0, untracked = 0, deleted = 0, conflicts = 0;
    for (const line of status.out.split("\n")) {
      if (!line.trim()) continue;
      const x = line[0], y = line[1];
      const xy = x + y;
      if (xy === "??") { untracked++; continue; }
      // unmerged: X or Y is U, or both-sides same conflict letters (AA/DD)
      if (x === "U" || y === "U" || (x === y && (x === "A" || x === "D"))) { conflicts++; continue; }
      // staged (index) changes
      if (x !== " " && x !== "?") {
        if (x === "D") deleted++;
        else if ("MARC".includes(x)) staged++;
      }
      // unstaged (worktree) changes
      if (y !== " " && y !== "?") {
        if (y === "D") deleted++;
        else if ("MARC".includes(y)) modified++;
      }
    }

    // diff stats (uncommitted): numstat lines "ins\tdel\tpath"
    let insertions = 0, deletions = 0;
    const fileStats: { path: string; ins: number; del: number }[] = [];
    for (const line of numstat.out.split("\n")) {
      const m = line.match(/^(\d+|-)\s+(\d+|-)\s+(.+)$/);
      if (!m) continue;
      const ins = m[1] === "-" ? 0 : parseInt(m[1], 10);
      const del = m[2] === "-" ? 0 : parseInt(m[2], 10);
      insertions += ins; deletions += del;
      fileStats.push({ path: m[3], ins, del });
    }
    fileStats.sort((a, b) => (b.ins + b.del) - (a.ins + a.del));
    const topFiles = fileStats.slice(0, 8).map((f) => `${f.path} (+${f.ins}/-${f.del})`);

    const recent = log.out.split("\n").filter(Boolean).slice(0, 3).map((line) => {
      const sp = line.indexOf(" ");
      return { sha: sp > 0 ? line.slice(0, sp) : line, subject: sp > 0 ? line.slice(sp + 1) : "" };
    });

    const remoteName = remote.ok ? remote.out.trim().split("\n")[0] : null;

    // worktrees
    let wtCount = 1, wtPrimary: string | null = null;
    if (wtList.ok && wtList.out.trim()) {
      const worktrees = wtList.out.trim().split(/\n\n+/).filter(Boolean);
      wtCount = worktrees.length;
      const normal = worktrees.filter((w) => !w.includes("bare"));
      wtPrimary = normal[0]?.match(/^worktree (.+)$/m)?.[1] ?? null;
    }

    // branch: unborn HEAD fallback to symbolic-ref; detached HEAD annotation
    const branchRaw = branch.ok ? branch.out.trim() : null;
    let branchName: string | null = branchRaw && branchRaw !== "HEAD" ? branchRaw : null;
    let detached = false;
    if (!branchName) {
      const sr = await git(ctx, ["symbolic-ref", "--short", "HEAD"]);
      if (sr.ok) branchName = sr.out.trim();
      else if (branchRaw === "HEAD") { branchName = "HEAD (detached)"; detached = true; }
      else if (branchRaw) branchName = branchRaw;
    }

    return {
      at: Date.now(), isRepo: true, gitMissing: false, cwd: ctx.cwd,
      branch: branchName, detached, upstream: upstreamName, ahead, behind, aheadUnknown,
      dirty: { modified, staged, untracked, deleted, conflicts },
      diff: { insertions, deletions, files: fileStats.length, topFiles },
      recent, remote: remoteName, worktrees: { count: wtCount, primary: wtPrimary },
    };
  }

  function format(s: RepoState, depth: "quick" | "full"): string {
    if (!s.isRepo) {
      if (s.gitMissing) {
        return `repo_state: git is not available in PATH (cwd: ${s.cwd}). Install git or check PATH before using repo_state.`;
      }
      return `repo_state: not a git repository (cwd: ${s.cwd}). Use scope=files-based workflows or plain file tools.`;
    }
    const lines: string[] = [];
    const branchPart = s.upstream
      ? `ahead ${s.aheadUnknown ? "?" : (s.ahead ?? 0)} / behind ${s.aheadUnknown ? "?" : (s.behind ?? 0)} (upstream ${s.upstream})`
      : "no upstream";
    lines.push(`repo: ${s.cwd}`);
    lines.push(`branch: ${s.branch ?? "?"}${s.detached ? " [detached]" : ""} — ${branchPart}`);
    const d = s.dirty;
    lines.push(
      `dirty: ${d.modified} modified, ${d.staged} staged, ${d.untracked} untracked, ${d.deleted} deleted${d.conflicts ? `, ${d.conflicts} CONFLICTS` : ""}`
    );
    if (s.diff.files > 0) {
      lines.push(`diff: +${s.diff.insertions}/-${s.diff.deletions} across ${s.diff.files} files`);
      if (depth === "full") {
        for (const t of s.diff.topFiles) lines.push(`  ${t}`);
      } else {
        lines.push(`  top: ${s.diff.topFiles.slice(0, 3).join(", ")}`);
      }
    } else {
      lines.push("diff: clean (no unstaged changes)");
    }
    if (s.recent.length) {
      lines.push(`recent: ${s.recent.map((r) => `${r.sha} ${r.subject.slice(0, 50)}`).join(" | ")}`);
    }
    if (s.remote) lines.push(`remote: ${s.remote}`);
    if (s.worktrees.count > 1) {
      lines.push(`worktrees: ${s.worktrees.count} total${s.worktrees.primary ? ` (primary: ${s.worktrees.primary})` : ""}`);
    }
    if (d.conflicts) {
      lines.push(`⚠️ ${d.conflicts} merge conflicts — resolve before committing`);
    }
    return lines.join("\n");
  }

  pi.registerTool({
    name: "repo_state",
    label: "Repo State",
    description:
      "One-call snapshot of the current git repository: branch, ahead/behind, dirty file counts (modified/staged/untracked/deleted/conflicts), diff +/- statistics (file-level, not full text), recent commits, remote, worktree info. Directly spawns git — no shell wrapping. Use when you need repository state before planning, editing, or verifying; prefer this over a chain of git status/diff/log shell commands. Verdict-first: 'not a git repository' / 'git not available' when applicable. Cached ~3s; force=true to bypass.",
    promptSnippet: "Return a one-call git repository snapshot (branch, dirty counts, diff stats, conflicts)",
    promptGuidelines: [
      "Use repo_state when you need repository state (branch/dirty/conflicts/diff overview) instead of running git status/diff/log via shell — one call replaces a whole command chain.",
    ],
    parameters: Type.Object({
      force: Type.Optional(Type.Boolean({ description: "Bypass the 3s cache" })),
      depth: Type.Optional(Type.Union([Type.Literal("quick"), Type.Literal("full")], { description: "quick=summary; full=top diff files + more detail (default quick)" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const cctx = ctx as unknown as Ctx;
      if (!params.force && cached && cached.cwd === cctx.cwd && Date.now() - cached.at < 3000) {
        return { content: [{ type: "text", text: format(cached, params.depth ?? "quick") }], details: { cached: true } };
      }
      const s = await collect(cctx);
      cached = s;
      return {
        content: [{ type: "text", text: format(s, params.depth ?? "quick") }],
        details: { isRepo: s.isRepo, branch: s.branch, dirty: s.dirty, diff: s.diff },
      };
    },
  });
}
