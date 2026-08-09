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
      check("line mentions branch", /\[git\]/.test(line) && /branch|dirty|ahead/.test(line), line.slice(0, 80));
      check("line is one line", !line.includes("\n"));
      check("line is compact (<160 chars)", line.length < 160, "len=" + line.length);
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
  }

  console.log(`\n=== ${failures === 0 ? "ALL PASS" : failures + " FAILURES"} ===`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error("FATAL", e); process.exit(2); });
