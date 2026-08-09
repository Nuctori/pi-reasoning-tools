/**
 * Smoke test for git-mini-inject.
 * Usage: node test/smoke-inject.cjs  (from package root)
 */
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { createJiti } = require("jiti");
const jiti = createJiti(__filename, { interopDefault: true, moduleCache: false, fs: { cache: false } });

const ROOT = path.resolve(__dirname, "..");
const REPO = path.resolve(ROOT, "..", "..");

function runGit(args) {
  try {
    const stdout = execFileSync("git", ["-C", REPO, ...args], { encoding: "utf-8", timeout: 8000 });
    return { stdout, stderr: "", code: 0 };
  } catch (e) {
    return { stdout: e.stdout || "", stderr: e.stderr || "", code: e.status ?? -1 };
  }
}

function makeStubPi() {
  const state = { handlers: new Map() };
  const pi = {
    registerTool() {},
    on(ev, h) { state.handlers.set(ev, h); },
    async exec(cmd, args, opts) {
      if (cmd === "git") return runGit(args);
      throw new Error("unexpected " + cmd);
    },
  };
  return { pi, state };
}

let failures = 0;
function check(label, cond, detail = "") {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${detail ? "  (" + detail + ")" : ""}`);
  if (!cond) failures += 1;
}

async function main() {
  let state;
  try {
    const { pi, state: s } = makeStubPi();
    state = s;
    const mod = jiti(path.join(ROOT, "extensions", "git-mini-inject.ts"));
    await mod.default(pi);
    check("loads without error", true);
  } catch (e) {
    check("loads without error", false, String((e && e.message) || e).slice(0, 300));
    console.error(e);
  }

  if (state) {
    const ctxHandler = state.handlers.get("context");
    const turnStart = state.handlers.get("turn_start");
    const sessionStart = state.handlers.get("session_start");

    const baseMsgs = [
      { role: "system", content: "sys" },
      { role: "user", content: "hi" },
      { role: "custom", customType: "repo-state-mini", content: "[git] stale (old)" },
    ];

    // turn 0: should strip old + inject fresh one-liner
    sessionStart?.({}, {});
    turnStart?.({ turnIndex: 0 }, {});
    const r0 = await ctxHandler({ messages: baseMsgs }, { cwd: REPO });
    const after0 = r0.messages;
    const injected = after0.filter((m) => m.role === "custom" && m.customType === "repo-state-mini");
    check("turn 0 strips old injection", after0.filter((m) => m.role === "custom").length === injected.length, `customs=${after0.filter((m) => m.role === "custom").length}`);
    check("turn 0 injects one line", injected.length === 1, "count=" + injected.length);
    if (injected.length === 1) {
      const line = injected[0].content || "";
      console.log("  injected:", line);
      check("line mentions iter prefix", /\[iter\]/.test(line), line.slice(0, 40));
      // no-remote repo: graceful degradation — branch/ver/dirty still present; full fields covered by the temp-repo case below
      check("degraded: branch|ver|dirty present", /branch/.test(line) && /dirty/.test(line), line.slice(0, 90));
      check("line is one line", !line.includes("\n"));
      check("density bound (<300 chars)", line.length < 300, "len=" + line.length);
    }

    // turn > 0: should NOT inject (only strip)
    turnStart?.({ turnIndex: 1 }, {});
    const r1 = await ctxHandler({ messages: baseMsgs }, { cwd: REPO });
    check("turn>0 strips but does not inject", r1.messages.filter((m) => m.role === "custom").length === 0, "customs=" + r1.messages.filter((m) => m.role === "custom").length);

    // off switch
    sessionStart?.({}, {});
    turnStart?.({ turnIndex: 0 }, {});
    const saved = process.env.PI_REPO_STATE_INJECT;
    process.env.PI_REPO_STATE_INJECT = "off";
    const rOff = await ctxHandler({ messages: baseMsgs }, { cwd: REPO });
    check("off switch disables injection", rOff.messages.filter((m) => m.role === "custom").length === 0);
    if (saved === undefined) delete process.env.PI_REPO_STATE_INJECT; else process.env.PI_REPO_STATE_INJECT = saved;

    // full high-density fields require a repo with remote + origin/HEAD: build one in temp
    const os = require("node:os");
    const fs = require("node:fs");
    function gitIn(cwd, ...args) {
      try {
        const stdout = execFileSync("git", ["-C", cwd, ...args], { encoding: "utf-8", timeout: 8000, stdio: ["ignore", "pipe", "pipe"] });
        return { ok: true, stdout };
      } catch (e) {
        return { ok: false, stdout: e.stdout || "" };
      }
    }
    const tdir = fs.mkdtempSync(path.join(os.tmpdir(), "rs-inject-full-"));
    gitIn(tdir, "init", "-q");
    gitIn(tdir, "config", "user.name", "t"); gitIn(tdir, "config", "user.email", "t@t");
    fs.writeFileSync(path.join(tdir, "a.txt"), "base\n");
    gitIn(tdir, "add", "a.txt"); gitIn(tdir, "commit", "-qm", "base");
    const baseSha = (gitIn(tdir, "rev-parse", "HEAD").stdout || "").trim();
    gitIn(tdir, "remote", "add", "origin", "https://github.com/example/repo.git");
    gitIn(tdir, "update-ref", "refs/remotes/origin/master", baseSha);
    gitIn(tdir, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/master");
    gitIn(tdir, "checkout", "-qb", "feature");
    fs.writeFileSync(path.join(tdir, "b.txt"), "1\n"); gitIn(tdir, "add", "b.txt"); gitIn(tdir, "commit", "-qm", "one");
    fs.writeFileSync(path.join(tdir, "c.txt"), "2\n"); gitIn(tdir, "add", "c.txt"); gitIn(tdir, "commit", "-qm", "two");

    sessionStart?.({}, {});
    turnStart?.({ turnIndex: 0 }, {});
    const rFull = await ctxHandler({ messages: [{ role: "system", content: "s" }] }, { cwd: tdir });
    const fullLine = (rFull.messages.find((m) => m.role === "custom" && m.customType === "repo-state-mini") || {}).content || "";
    console.log("  full-inject:", fullLine);
    check("full: remote present", /remote github\.com\/example\/repo/.test(fullLine), fullLine.slice(0, 80));
    check("full: default branch + ahead/b", /default master \([0-9a-f]{7}\) ahead\d+\/b\d+/.test(fullLine));
    check("full: +N from default", /\+2 from master/.test(fullLine), "+2 from master");
    check("full: single line high density", !fullLine.includes("\n") && fullLine.length < 300, "len=" + fullLine.length);
    fs.rmSync(tdir, { recursive: true, force: true });

    // primary worktree state (multi-worktree repo)
    const wdir = fs.mkdtempSync(path.join(os.tmpdir(), "rs-inject-wt-"));
    gitIn(wdir, "init", "-q");
    gitIn(wdir, "config", "user.name", "t"); gitIn(wdir, "config", "user.email", "t@t");
    fs.writeFileSync(path.join(wdir, "a.txt"), "base\n");
    gitIn(wdir, "add", "a.txt"); gitIn(wdir, "commit", "-qm", "base");
    const wt2 = path.join(os.tmpdir(), "rs-inject-wt2-" + Date.now());
    gitIn(wdir, "worktree", "add", "-q", wt2, "-b", "feature");
    // make primary dirty so its state is observable
    fs.writeFileSync(path.join(wdir, "a.txt"), "base\nprimary-dirty\n");

    sessionStart?.({}, {});
    turnStart?.({ turnIndex: 0 }, {});
    const rWt = await ctxHandler({ messages: [{ role: "system", content: "s" }] }, { cwd: wt2 });
    const wtLine = (rWt.messages.find((m) => m.role === "custom" && m.customType === "repo-state-mini") || {}).content || "";
    console.log("  wt-inject:", wtLine);
    check("wt: current linked", /wt linked/.test(wtLine), wtLine.slice(0, 80));
    check("wt: primary state present", /primary .+ dirty \d+m\//.test(wtLine), "primary dirty");
    check("wt: 2 total", /\(2 total\)/.test(wtLine));
    fs.rmSync(wt2, { recursive: true, force: true });
    fs.rmSync(wdir, { recursive: true, force: true });
  }

  console.log(`\n=== ${failures === 0 ? "ALL PASS" : failures + " FAILURES"} ===`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error("FATAL", e); process.exit(2); });
