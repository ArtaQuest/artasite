/**
 * Tiny dependency-free syntax highlighting for the Lab's cell editor (python + %%js cells).
 * One combined regex per language; emits escaped HTML with tk-* spans (styles in Lab.tsx's
 * editor CSS). No grammar ambitions — comments, strings, keywords, builtins, numbers.
 */

export const escHtml = (s: string) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const TOK_CLASS = ["", "tk-c", "tk-s", "tk-d", "tk-k", "tk-b", "tk-n"];

const PY_TOK = new RegExp(
  [
    "(#[^\\n]*)", // 1 comment
    "([rbufRBUF]{0,2}(?:'''[\\s\\S]*?(?:'''|$)|\"\"\"[\\s\\S]*?(?:\"\"\"|$)|'(?:\\\\.|[^'\\\\\\n])*'|\"(?:\\\\.|[^\"\\\\\\n])*\"))", // 2 string
    "(@[A-Za-z_][\\w.]*)", // 3 decorator
    "\\b(False|None|True|and|as|assert|async|await|break|class|continue|def|del|elif|else|except|finally|for|from|global|if|import|in|is|lambda|nonlocal|not|or|pass|raise|return|try|while|with|yield)\\b", // 4 keyword
    "\\b(self|cls|print|len|range|enumerate|zip|map|filter|sum|min|max|abs|round|sorted|reversed|list|dict|set|tuple|str|int|float|bool|bytes|type|isinstance|hasattr|getattr|setattr|open|super|object|display|Exception|ValueError|TypeError|KeyError|IndexError|RuntimeError)\\b", // 5 builtin
    "\\b(\\d[\\d_]*\\.?[\\d_]*(?:[eE][+-]?\\d+)?[jJ]?|0[xXoObB][\\da-fA-F_]+)\\b", // 6 number
  ].join("|"),
  "g",
);

const JS_TOK = new RegExp(
  [
    "(\\/\\/[^\\n]*|\\/\\*[\\s\\S]*?(?:\\*\\/|$))", // 1 comment
    "(`(?:\\\\.|[^`\\\\])*(?:`|$)|'(?:\\\\.|[^'\\\\\\n])*'|\"(?:\\\\.|[^\"\\\\\\n])*\")", // 2 string
    "(@\\w+)", // 3
    "\\b(var|let|const|function|return|if|else|for|while|do|new|class|extends|async|await|import|export|from|typeof|instanceof|this|super|try|catch|finally|throw|switch|case|break|continue|default|delete|in|of|void|yield|static|get|set|null|undefined|true|false)\\b", // 4 keyword
    "\\b(console|document|window|Math|JSON|Object|Array|String|Number|Boolean|Promise|Map|Set|Date|RegExp|Error|parseInt|parseFloat|isNaN|fetch|setTimeout|setInterval|requestAnimationFrame|postMessage)\\b", // 5 builtin
    "\\b(\\d[\\d_]*\\.?[\\d_]*(?:[eE][+-]?\\d+)?n?|0[xXoObB][\\da-fA-F_]+)\\b", // 6 number
  ].join("|"),
  "g",
);

function highlightWith(tok: RegExp, src: string): string {
  let out = "";
  let last = 0;
  let m: RegExpExecArray | null;
  tok.lastIndex = 0;
  while ((m = tok.exec(src))) {
    out += escHtml(src.slice(last, m.index));
    for (let g = 1; g <= 6; g++) {
      if (m[g] != null) {
        out += `<span class="${TOK_CLASS[g]}">${escHtml(m[g])}</span>`;
        break;
      }
    }
    last = m.index + m[0].length;
    if (!m[0].length) tok.lastIndex++; // never loop on a zero-width match
  }
  return out + escHtml(src.slice(last));
}

export const JS_MAGIC = /^\s*%%(js|javascript)[^\n]*\n?/;

export const hlPython = (src: string) => highlightWith(PY_TOK, src);
export const hlJS = (src: string) => highlightWith(JS_TOK, src);
/** Highlight a code cell: %%js cells get the JS grammar, everything else python. */
export const hlCell = (src: string) => (JS_MAGIC.test(src) ? hlJS(src) : hlPython(src));
