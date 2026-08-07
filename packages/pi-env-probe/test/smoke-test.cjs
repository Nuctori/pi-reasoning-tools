/**
 * Smoke test for pi-env-probe.
 * Usage: node test/smoke-test.cjs  (from package root)
 */
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");
const { createJiti } = require("jiti");
const jiti = createJiti(__filename, { interopDefault: true, moduleCache: false, fs: { cache: false } });

function runBash(script) {
  try {
    const out = execFileSync("bash", ["-lc", script], { encoding: "utf-8", timeout: 8000, stdio: ["ignore", "pipe", "pipe"] });
    return { stdout: out, stderr: "", code: 0 };
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
      if (cmd === "bash") return runBash((args || []).join(" ").replace(/^-lc\s*/, ""));
      return runBash(`${cmd} ${(args || []).join(" ")}`);
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
  // ---- default (en) ----
  let state;
  try {
    const { pi, state: s } = makeStubPi();
    state = s;
    const mod = jiti(path.join(ROOT, "extensions", "env-probe.ts"));
    await mod.default(pi);
    check("loads without error", true);
  } catch (e) {
    check("loads without error", false, String((e && e.message) || e).slice(0, 300));
    console.error(e);
  }

  if (state) {
    check("registers env_probe tool", state.tools.has("env_probe"));
    check("registers session_start", state.handlers.has("session_start"));
    check("registers before_agent_start", state.handlers.has("before_agent_start"));
    const tool = state.tools.get("env_probe");
    if (tool) {
      const res = await tool.execute("t", { force: true }, undefined, undefined, {});
      const text = (res.content || []).map((c) => c.text || "").join("\n");
      check("probe returns matrix", /capability matrix/.test(text));
      check("probe includes git", /git/.test(text));
      check("probe includes rg-or-missing marker", /\[ok\]|\[missing\]/.test(text));
    }
    const bh = state.handlers.get("before_agent_start");
    const r = await bh({ systemPrompt: "BASE", prompt: "x", systemPromptOptions: {} }, {});
    check("injects compact matrix once (en)", r && /\[env-probe\]/.test(r.systemPrompt));
  }

  // ---- zh locale ----
  const saved = process.env.LANG;
  process.env.LANG = "zh_CN.UTF-8";
  try {
    const { pi, state: s } = makeStubPi();
    const mod = jiti(path.join(ROOT, "extensions", "env-probe.ts"));
    await mod.default(pi);
    const tool = s.tools.get("env_probe");
    const res = await tool.execute("t", { force: true }, undefined, undefined, {});
    const text = (res.content || []).map((c) => c.text || "").join("\n");
    check("zh matrix header", /环境能力矩阵/.test(text));
    check("zh pitfalls", /已知坑/.test(text));
  } catch (e) {
    check("zh loads", false, String((e && e.message) || e).slice(0, 200));
  }
  if (saved === undefined) delete process.env.LANG; else process.env.LANG = saved;

  console.log(`\n=== ${failures === 0 ? "ALL PASS" : failures + " FAILURES"} ===`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error("FATAL", e); process.exit(2); });
