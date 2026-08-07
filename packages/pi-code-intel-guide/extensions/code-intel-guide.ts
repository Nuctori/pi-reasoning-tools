/**
 * code-intel-guide (TG2): collapse discovery → read → analyze into guided tool use.
 *
 * Problem (from a 115-session corpus analysis):
 *   - 10,640 shell calls were pure search-read (grep -r / find / Select-String /
 *     rg) burning 8.8M tokens, while the dedicated toolchain sat unused:
 *     ctx_compose used 4x, module_report 4x, symbol_search 0x, lsp_navigation 0x.
 *   - Reading is where the model reasons hardest (ctx_read r/o ratio 0.91), so
 *     every wasted discovery round-trip multiplies reasoning cost.
 *
 * Fix:
 *   - Inject a compact "information retrieval protocol" into the system prompt:
 *     symbol_search → ctx_compose → module_report/read_symbol → ctx_grep, with
 *     shell grep/find demoted to last resort.
 *   - Intercept shell recursive code-search commands in tool_call and redirect
 *     (bounded to 2 blocks per session as a safety net; no infinite blocking).
 *
 * Cross-platform: tool names are the pi/lean-ctx standard set, which exist on
 * Linux/macOS/Windows. English by default, Simplified-Chinese on zh locale.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type Lang = "en" | "zh";

const TEXT = {
  en: {
    protocol: `[Information retrieval protocol] For code search, use dedicated tools in this order; do NOT use shell for recursive code search:
1. Locate symbols/definitions/references: symbol_search → lsp_navigation
2. Understand a feature/area of code: ctx_compose (returns ranked files with inline source in one call — first choice)
3. Read files: module_report (outline) → read_symbol (single symbol body) → ctx_read (full file)
4. Text/regex/semantic search: ctx_grep, ctx_search(action=regex|semantic|symbol)
Shell rg / grep -r / find / Select-String -Recurse are only for non-code text, git commands, or pipeline filtering.`,
    blockReason: `Recursive code search — use dedicated tools instead: ctx_compose (understand code) → ctx_search(action=symbol|regex|semantic)/ctx_grep (search) → symbol_search/lsp_navigation (symbols). Shell rg / grep -r / find / Select-String -Recurse are only for non-code text, git commands, or pipeline filtering.`,
  },
  zh: {
    protocol: `[信息获取协议] 检索代码按此顺序, 禁止用 shell 做递归代码搜索:
1. 定位符号定义/引用: symbol_search → lsp_navigation
2. 理解一片代码/功能: ctx_compose (一次返回相关文件+内联源码, 首选)
3. 读文件: module_report(大纲) → read_symbol(单符号体) → ctx_read(全文)
4. 文本/正则/语义搜索: ctx_grep, ctx_search(action=regex|semantic|symbol)
shell 的 rg / grep -r / find / Select-String -Recurse 仅用于非代码文本、git 命令、管道过滤。`,
    blockReason: `递归代码搜索请改用专用工具: ctx_compose(理解代码/功能) → ctx_search(action=symbol|regex|semantic)/ctx_grep(搜索) → symbol_search/lsp_navigation(符号). shell 的 rg/grep -r/find/Select-String -Recurse 仅用于非代码文本、git 命令或管道过滤.`,
  },
} as const;

function detectLang(): Lang {
  const probe = [process.env.LANG, process.env.LC_ALL, process.env.LC_MESSAGES, process.env.LANGUAGE]
    .filter(Boolean)
    .join(" ");
  return /zh/i.test(probe) ? "zh" : "en";
}

const SHELL_TOOLS = new Set(["ctx_shell", "bash", "pwsh", "shell"]);

function isRecursiveCodeSearch(cmd: string): boolean {
  if (!cmd) return false;
  // bare `rg <pattern> [path]` — rg is recursive by default; exclude `git rg` / `echo rg`
  if (/(^|[\s;&|])(?<!git\s)(?<!echo\s)rg(\.exe)?\s/.test(cmd)) return true;
  // grep -r / -R / --recursive — flags may be combined (-rn) or preceded by other options (-i -rn)
  if (/\bgrep(\.exe)?\s+((-[A-Za-z]+\s+)*-r[A-Za-z]*(\s|$|["'])|--recursive\b)/.test(cmd)) return true;
  // find ... -name '*.code-ext'
  if (/\bfind\s[^|;]*-name\s[^|;]*\.(cs|ts|tsx|js|jsx|go|rs|py|lua|java|kt|kts|xaml|json|ya?ml|csproj|sln|proto|sql)\b/.test(cmd)) return true;
  // Select-String with -Recurse anywhere in the pipeline (Get-ChildItem -Recurse | Select-String ...)
  if (/\bSelect-String\b/.test(cmd) && /\b-Recurse\b|\bRecurse\b/.test(cmd)) return true;
  return false;
}

export default function codeIntelGuideExtension(pi: ExtensionAPI) {
  const lang: Lang = detectLang();
  const T = TEXT[lang];
  let blocksThisSession = 0;

  pi.on("session_start", () => {
    blocksThisSession = 0;
  });

  pi.on("before_agent_start", async (event) => {
    if (event.systemPrompt.includes("[Information retrieval protocol]") || event.systemPrompt.includes("[信息获取协议]")) return;
    return { systemPrompt: event.systemPrompt + "\n\n" + T.protocol };
  });

  pi.on("tool_call", (event) => {
    if (!SHELL_TOOLS.has(event.toolName)) return;
    if (blocksThisSession >= 2) return;
    const input = event.input as { command?: string; Command?: string };
    const cmd = input?.command ?? input?.Command ?? "";
    if (isRecursiveCodeSearch(cmd)) {
      blocksThisSession += 1;
      return { block: true, reason: T.blockReason };
    }
    return undefined;
  });
}
