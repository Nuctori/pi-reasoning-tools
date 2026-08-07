/**
 * Smoke test for pi-repo-state.
 * Usage: node test/smoke-test.cjs  (from package root)
 */
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { createJiti } = require("jiti");
const jiti = createJiti(__filename, { interopDefault: true, moduleCache: false, fs: { cache: false } });

const ROOT = path.resolve(__dirname, "..");
// use a real git repo for the test (this package's monorepo root)
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
  const state = { tools: new Map(), handlers: new Map() };
  const pi = {
    registerTool(def) { state.tools.set(def.name, def); },
    on(ev, h) { state.handlers.set(ev, h); },
    async exec(cmd, args, opts) {
      if (cmd === "git") return runGit(args);
      throw new Error(`unexpected exec: ${cmd}`);
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
  console.log("test repo:", REPO);
  let state;
  try {
    const { pi, state: s } = makeStubPi();
    state = s;
    const mod = jiti(path.join(ROOT, "extensions", "repo-state.ts"));
    await mod.default(pi);
    check("loads without error", true);
  } catch (e) {
    check("loads without error", false, String((e && e.message) || e).slice(0, 300));
    console.error(e);
  }

  if (state) {
    check("registers repo_state tool", state.tools.has("repo_state"));
    const tool = state.tools.get("repo_state");
    const res = await tool.execute("t", { depth: "full" }, undefined, undefined, { cwd: REPO });
    const text = (res.content || []).map((c) => c.text || "").join("\n");
    console.log("--- output ---");
    console.log(text);
    check("output mentions repo path", /repo:/.test(text));
    check("output has branch line", /branch:/.test(text));
    check("output has dirty line", /dirty:/.test(text));
    check("output has diff line", /diff:/.test(text));
    check("output has recent commits", /recent:/.test(text));
    // XY-correctness: dirty line must parse and staged/untracked counts must be internally consistent
    const dm = text.match(/dirty: (\d+) modified, (\d+) staged, (\d+) untracked, (\d+) deleted/);
    if (dm) {
      const [, modified, staged, untracked, deleted] = dm.map(Number);
      // sanity: counts must not exceed total status lines; no negative
      check("dirty counts parse & non-negative", [modified, staged, untracked, deleted].every((n) => Number.isFinite(n) && n >= 0), `${modified}M/${staged}S/${untracked}U/${deleted}D`);
      // if any untracked exist, dirty line must not claim zero untracked
      const st = runGit(["status", "--porcelain=v1"]);
      const realUntracked = (st.stdout || "").split("\n").filter((l) => l.startsWith("??")).length;
      check("untracked count matches git", untracked === realUntracked, `tool=${untracked} git=${realUntracked}`);
    } else {
      check("dirty line parses", false, text.slice(0, 80));
    }

    // cache: second call within 3s (same cwd) returns cached flag — check BEFORE the non-repo call which overwrites the cache
    const res3 = await tool.execute("t", {}, undefined, undefined, { cwd: REPO });
    const det3 = res3.details || {};
    check("cached second call", det3.cached === true, "cached=" + det3.cached);

    // non-repo dir
    const res2 = await tool.execute("t", {}, undefined, undefined, { cwd: path.parse(ROOT).root });
    const text2 = (res2.content || []).map((c) => c.text || "").join("\n");
    check("non-repo returns clear verdict", /not a git repository/.test(text2), text2.slice(0, 60));
  }

  console.log(`\n=== ${failures === 0 ? "ALL PASS" : failures + " FAILURES"} ===`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error("FATAL", e); process.exit(2); });
