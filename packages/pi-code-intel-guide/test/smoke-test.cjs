/**
 * Smoke test for pi-code-intel-guide.
 * Usage: node test/smoke-test.cjs  (from package root)
 */
const path = require("node:path");
const { createJiti } = require("jiti");
const jiti = createJiti(__filename, { interopDefault: true, moduleCache: false, fs: { cache: false } });

const ROOT = path.resolve(__dirname, "..");

function makeStubPi() {
  const state = { tools: new Map(), handlers: new Map() };
  return {
    pi: {
      registerTool(def) { state.tools.set(def.name, def); },
      on(ev, h) { state.handlers.set(ev, h); },
    },
    state,
  };
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
    const mod = jiti(path.join(ROOT, "extensions", "code-intel-guide.ts"));
    await mod.default(pi);
    check("loads without error", true);
  } catch (e) {
    check("loads without error", false, String((e && e.message) || e).slice(0, 300));
    console.error(e);
  }

  if (state) {
    check("registers before_agent_start", state.handlers.has("before_agent_start"));
    check("registers tool_call", state.handlers.has("tool_call"));

    const bh = state.handlers.get("before_agent_start");
    const r = await bh({ systemPrompt: "BASE\n", prompt: "x", systemPromptOptions: {} }, {});
    check("injects protocol (en)", r && /\[Information retrieval protocol\]/.test(r.systemPrompt));
    const r2 = await bh({ systemPrompt: r.systemPrompt, prompt: "x", systemPromptOptions: {} }, {});
    check("does not double-inject", !r2 || r2.systemPrompt.split("\[Information retrieval protocol\]").length === 2);

    const tc = state.handlers.get("tool_call");
    const call = (toolName, command) => tc({ toolName, toolCallId: "x", input: { command } }, {});
    const blocked = (toolName, command) => {
      state.handlers.get("session_start")?.({}, {});
      const res = call(toolName, command);
      return res && res.block === true;
    };
    check("blocks bare rg", blocked("ctx_shell", 'rg "class Foo" .'));
    check("blocks grep -rn", blocked("pwsh", 'grep -rn "Foo" .'));
    check("blocks grep --recursive", blocked("ctx_shell", "grep --recursive Foo ."));
    check("blocks find -name code ext", blocked("ctx_shell", "find . -name '*.cs'"));
    check("blocks Select-String -Recurse pipeline", blocked("pwsh", "Get-ChildItem -Recurse | Select-String -Pattern 'Foo'"));
    check("allows git grep", !blocked("ctx_shell", 'git grep "pattern"'));
    check("allows pipe grep", !blocked("ctx_shell", "git status | grep modified"));
    check("allows plain grep single file", !blocked("bash", "grep pattern file.txt"));
    check("allows grep -v", !blocked("bash", "grep -v pattern file.txt"));
    check("allows echo rg", !blocked("ctx_shell", "echo rg foo"));
    check("allows python", !blocked("ctx_shell", "python script.py"));

    state.handlers.get("session_start")?.({}, {});
    call("ctx_shell", "rg foo .");
    const b2 = call("ctx_shell", "rg bar .");
    const b3 = call("ctx_shell", "rg baz .");
    check("limits to 2 blocks per session", b2 && b2.block === true && (!b3 || b3.block !== true));
  }

  console.log(`\n=== ${failures === 0 ? "ALL PASS" : failures + " FAILURES"} ===`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error("FATAL", e); process.exit(2); });
