/* eslint-disable @typescript-eslint/no-var-requires */
const vscode = require('vscode');

const TFS_PROPERTIES = [
  "color","background","border","border-style","border-color","padding",
  "font","font-size","weight","family","outline","fill","track",
  "line-height","text-align","margin","margin-bottom","border-radius",
  "box-shadow","transform","height"
];
const TFS_DIRECTIVES = ["@colors","@fonts","@keyframes","@media"];
const TFS_STATES = ["default","hover","focus","error","warning","success","active","disabled"];

// ---------------- helpers ----------------
function parseColorTokens(text) {
  // Parse `@colors { name: value; }` blocks into Map(name -> raw value)
  const map = new Map();
  const colorsBlock = /@colors\s*\{([\s\S]*?)\}/g;
  let m;
  while ((m = colorsBlock.exec(text))) {
    const block = m[1];
    const lineRe = /([A-Za-z_][\w-]*)\s*:\s*([^;]+);/g;
    let t;
    while ((t = lineRe.exec(block))) {
      const name = t[1].trim();
      const raw  = t[2].trim();
      map.set(name, raw);
    }
  }
  return map;
}

function toVscodeColor(raw) {
  if (!raw) return null;
  let r,g,b,a=1;

  const hex = raw.match(/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/);
  if (hex) {
    const h = hex[1];
    if (h.length === 3) {
      r = parseInt(h[0]+h[0],16); g = parseInt(h[1]+h[1],16); b = parseInt(h[2]+h[2],16);
      return new vscode.Color(r/255,g/255,b/255,1);
    }
    if (h.length === 6) {
      r = parseInt(h.slice(0,2),16); g = parseInt(h.slice(2,4),16); b = parseInt(h.slice(4,6),16);
      return new vscode.Color(r/255,g/255,b/255,1);
    }
    if (h.length === 8) {
      r = parseInt(h.slice(0,2),16); g = parseInt(h.slice(2,4),16); b = parseInt(h.slice(4,6),16);
      a = parseInt(h.slice(6,8),16)/255;
      return new vscode.Color(r/255,g/255,b/255,a);
    }
  }

  const rgba = raw.match(/^rgba?\s*\(\s*([0-9.]+)\s*,\s*([0-9.]+)\s*,\s*([0-9.]+)(?:\s*,\s*([0-9.]+))?\s*\)$/i);
  if (rgba) {
    r = Math.max(0, Math.min(255, parseFloat(rgba[1])));
    g = Math.max(0, Math.min(255, parseFloat(rgba[2])));
    b = Math.max(0, Math.min(255, parseFloat(rgba[3])));
    a = rgba[4] !== undefined ? Math.max(0, Math.min(1, parseFloat(rgba[4]))) : 1;
    return new vscode.Color(r/255,g/255,b/255,a);
  }
  return null;
}

function luminance(c) {
  // WCAG relative luminance from sRGB (0..1)
  const srgb = [c.red, c.green, c.blue].map(v => {
    return v <= 0.03928 ? v/12.92 : Math.pow((v+0.055)/1.055, 2.4);
  });
  return 0.2126*srgb[0] + 0.7152*srgb[1] + 0.0722*srgb[2];
}

function blendTowardsWhite(color, factor) {
  // factor 0..1; 0=no change, 1=white
  const r = color.red   + (1 - color.red)   * factor;
  const g = color.green + (1 - color.green) * factor;
  const b = color.blue  + (1 - color.blue)  * factor;
  return new vscode.Color(r, g, b, color.alpha);
}

function compensateColor(color, minLum) {
  // Brighten dark/low-alpha colors to be readable on dark bg.
  if (color.alpha < 0.55) return blendTowardsWhite(color, 0.5); // simple boost for translucent
  const L = luminance(color);
  if (L >= minLum) return color;
  // progressively blend to reach minLum (cap at factor=0.85)
  let factor = 0.0;
  let out = color;
  while (factor < 0.85 && luminance(out) < minLum) {
    factor += 0.1;
    out = blendTowardsWhite(color, factor);
  }
  return out;
}

function colorToHexCSS(c) {
  const n = x => Math.round(Math.max(0, Math.min(1, x)) * 255);
  const hx = v => v.toString(16).padStart(2, '0');
  const r = n(c.red), g = n(c.green), b = n(c.blue);
  if (c.alpha >= 0.999) return `#${hx(r)}${hx(g)}${hx(b)}`;
  const a = hx(n(c.alpha));
  return `#${hx(r)}${hx(g)}${hx(b)}${a}`;
}

// Exclude comments/strings so we don't color inside those
function computeExcludedRanges(text) {
  const ranges = [];
  const len = text.length;
  let i = 0;
  while (i < len) {
    const ch = text[i];
    const two = text.slice(i, i+2);
    if (two === '//') { const s=i; i+=2; while (i<len && text[i] !== '\n') i++; ranges.push([s,i]); continue; }
    if (two === '/*') { const s=i; i+=2; while (i<len && !(text[i]==='*' && text[i+1]==='/')) i++; i=Math.min(len,i+2); ranges.push([s,i]); continue; }
    if (ch === '"')  { const s=i; i++; while (i<len){ if(text[i]==='\\'){i+=2; continue;} if(text[i]==='"'){i++; break;} i++; } ranges.push([s,i]); continue; }
    i++;
  }
  return ranges;
}
function isInsideAny(idx, ranges) {
  for (const [s,e] of ranges) if (idx >= s && idx < e) return true;
  return false;
}

// Determine if a match is a property key (name followed by optional ws + :)
function isPropertyKey(endIdx, text) {
  let i = endIdx;
  while (i < text.length && /\s/.test(text[i])) i++;
  return text[i] === ':';
}

// Determine if a match is a component definition: Identifier {   (Cap first)
function isComponentDef(startIdx, endIdx, text) {
  const token = text.slice(startIdx, endIdx);
  if (!/^[A-Z]/.test(token)) return false;
  let i = endIdx;
  while (i < text.length && /\s/.test(text[i])) i++;
  return text[i] === '{';
}

// ---------------- decorations ----------------
let tokenColorDeco = new Map();  // per token: colored text + swatch
let tokenSwatchDeco = new Map(); // per token: swatch-only
let stateDecorationType = null;

function updateDecorations(editor) {
  if (!editor || editor.document.languageId !== 'tfs') return;

  const cfg = vscode.workspace.getConfiguration('tfs');
  const allowTextColor = cfg.get('enableColorHighlight', true);
  const compMode = cfg.get('brightness.compensation', 'auto');
  const minLum = cfg.get('brightness.minLuminance', 0.45);

  const text = editor.document.getText();
  const exclude = computeExcludedRanges(text);

  // clear prior
  for (const d of tokenColorDeco.values()) d.dispose();
  for (const d of tokenSwatchDeco.values()) d.dispose();
  tokenColorDeco.clear();
  tokenSwatchDeco.clear();
  if (stateDecorationType) { stateDecorationType.dispose(); stateDecorationType = null; }

  // tokens
  const tokens = parseColorTokens(text);

  // definitions (LHS) detection
  const defBlockRe = /@colors\s*\{([\s\S]*?)\}/g;
  const defLineRe  = /([A-Za-z_][\w-]*)\s*:\s*([^;]+);/g;

  tokens.forEach((raw, name) => {
    const parsed0 = toVscodeColor(raw.trim());
    if (!parsed0) return;

    const parsed = compMode === 'auto' ? compensateColor(parsed0, minLum) : parsed0;
    const cssColor = colorToHexCSS(parsed);

    // two decoration types per token
    const decoColor = vscode.window.createTextEditorDecorationType({
      color: cssColor,
      light: { color: cssColor },
      dark:  { color: cssColor },
      rangeBehavior: vscode.DecorationRangeBehavior.OpenOpen
    });
    const decoSwatch = vscode.window.createTextEditorDecorationType({
      rangeBehavior: vscode.DecorationRangeBehavior.OpenOpen
    });

    tokenColorDeco.set(name, decoColor);
    tokenSwatchDeco.set(name, decoSwatch);

    const rangesColor = [];
    const rangesSwatch = [];
    const seen = new Set();

    // LHS definitions inside @colors
    let m;
    while ((m = defBlockRe.exec(text))) {
      const block = m[1];
      const blockStart = m.index + m[0].indexOf(block);
      let t;
      while ((t = defLineRe.exec(block))) {
        if (t[1].toLowerCase() === name.toLowerCase()) {
          const s = blockStart + t.index;
          const e = s + t[1].length;
          if (!isInsideAny(s, exclude)) {
            const range = new vscode.Range(editor.document.positionAt(s), editor.document.positionAt(e));
            const entry = { range, renderOptions: { before: { contentText: "■", margin: "0 0.25ch 0 0", color: cssColor } } };
            (allowTextColor ? rangesColor : rangesSwatch).push(entry);
            seen.add(s+":"+e);
          }
        }
      }
    }

    // General identifier scanning — compare whole identifiers only
    const idRe = /[A-Za-z_][A-Za-z0-9_-]*/g;
    let u;
    while ((u = idRe.exec(text))) {
      const tokenStart = u.index;
      const tokenEnd   = tokenStart + u[0].length;
      const ident = u[0];

      if (ident.toLowerCase() !== name.toLowerCase()) continue;
      if (isInsideAny(tokenStart, exclude)) continue;
      if (isPropertyKey(tokenEnd, text)) continue;      // don't color keys
      if (isComponentDef(tokenStart, tokenEnd, text)) { // components: swatch only
        const key = "c"+tokenStart+":"+tokenEnd;
        if (!seen.has(key)) {
          seen.add(key);
          const range = new vscode.Range(editor.document.positionAt(tokenStart), editor.document.positionAt(tokenEnd));
          rangesSwatch.push({
            range,
            renderOptions: { before: { contentText: "■", margin: "0 0.25ch 0 0", color: cssColor } }
          });
        }
        continue;
      }

      const key = tokenStart+":"+tokenEnd;
      if (seen.has(key)) continue;
      seen.add(key);

      const range = new vscode.Range(editor.document.positionAt(tokenStart), editor.document.positionAt(tokenEnd));
      const entry = { range, renderOptions: { before: { contentText: "■", margin: "0 0.25ch 0 0", color: cssColor } } };
      (allowTextColor ? rangesColor : rangesSwatch).push(entry);
    }

    editor.setDecorations(decoColor, rangesColor);
    editor.setDecorations(decoSwatch, rangesSwatch);
  });

  // States: color entire [state] (brackets + names)
  stateDecorationType = vscode.window.createTextEditorDecorationType({
    color: "#FF6BD8",
    light: { color: "#FF6BD8" },
    dark:  { color: "#FF6BD8" },
    rangeBehavior: vscode.DecorationRangeBehavior.OpenOpen
  });
  const stateRanges = [];
  const stateRe = /\[([^\]\n]+)\]/g;
  let sMatch;
  while ((sMatch = stateRe.exec(text))) {
    const startIdx = sMatch.index;
    const endIdx   = startIdx + sMatch[0].length;
    if (!isInsideAny(startIdx, exclude)) {
      stateRanges.push(new vscode.Range(
        editor.document.positionAt(startIdx),
        editor.document.positionAt(endIdx)
      ));
    }
  }
  editor.setDecorations(stateDecorationType, stateRanges);
}

function activate(context) {
  // Completions
  context.subscriptions.push(vscode.languages.registerCompletionItemProvider(
    { language: 'tfs' },
    {
      provideCompletionItems(doc) {
        const items = [];

        for (const p of TFS_PROPERTIES) {
          const it = new vscode.CompletionItem(p, vscode.CompletionItemKind.Property);
          it.insertText = `${p}: `;
          items.push(it);
        }
        for (const d of TFS_DIRECTIVES) {
          const it = new vscode.CompletionItem(d, vscode.CompletionItemKind.Keyword);
          it.insertText = d + " ";
          items.push(it);
        }
        for (const s of TFS_STATES) {
          const it = new vscode.CompletionItem(s, vscode.CompletionItemKind.EnumMember);
          it.insertText = s;
          items.push(it);
        }

        const tokens = parseColorTokens(doc.getText());
        for (const [name, raw] of tokens.entries()) {
          const it = new vscode.CompletionItem(name, vscode.CompletionItemKind.Color);
          it.detail = raw;
          it.insertText = name;
          const col = toVscodeColor(raw);
          if (col) it.documentation = new vscode.MarkdownString(`Color **${name}** = \`${raw}\``);
          items.push(it);
        }
        return items;
      }
    },
    "@", "[", ":", "-", "_"
  ));

  // Color provider (hex/rgba literals)
  context.subscriptions.push(vscode.languages.registerColorProvider(
    { language: 'tfs' },
    {
      provideDocumentColors(doc) {
        const text = doc.getText();
        const infos = [];

        const hexRe = /#[0-9a-fA-F]{3,8}\b/g;
        let m;
        while ((m = hexRe.exec(text))) {
          const color = toVscodeColor(m[0]);
          if (!color) continue;
          infos.push(new vscode.ColorInformation(
            new vscode.Range(doc.positionAt(m.index), doc.positionAt(m.index + m[0].length)),
            color
          ));
        }

        const rgbaRe = /rgba?\([^)]*\)/g;
        let r;
        while ((r = rgbaRe.exec(text))) {
          const color = toVscodeColor(r[0]);
          if (!color) continue;
          infos.push(new vscode.ColorInformation(
            new vscode.Range(doc.positionAt(r.index), doc.positionAt(r.index + r[0].length)),
            color
          ));
        }
        return infos;
      },
      provideColorPresentations(color) {
        const n = x => Math.round(x * 255);
        const hx = v => v.toString(16).padStart(2, '0');
        const R = n(color.red), G = n(color.green), B = n(color.blue), A = Math.round(color.alpha * 100) / 100;
        return [
          new vscode.ColorPresentation(`#${hx(R)}${hx(G)}${hx(B)}`),
          new vscode.ColorPresentation(`rgba(${R}, ${G}, ${B}, ${A})`)
        ];
      }
    }
  ));

  // Triggers
  function trigger() {
    const ed = vscode.window.activeTextEditor;
    if (ed && ed.document.languageId === 'tfs') updateDecorations(ed);
  }
  context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(trigger));
  context.subscriptions.push(vscode.workspace.onDidChangeTextDocument(e => {
    const ed = vscode.window.activeTextEditor;
    if (ed && e.document === ed.document) trigger();
  }));
  context.subscriptions.push(vscode.workspace.onDidOpenTextDocument(doc => {
    const ed = vscode.window.activeTextEditor;
    if (ed && doc === ed.document) trigger();
  }));
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(e => {
    if (e.affectsConfiguration('tfs')) trigger();
  }));

  trigger();
}

function deactivate() {
  for (const d of tokenColorDeco.values()) d.dispose();
  for (const d of tokenSwatchDeco.values()) d.dispose();
  tokenColorDeco.clear();
  tokenSwatchDeco.clear();
  if (stateDecorationType) stateDecorationType.dispose();
}

module.exports = { activate, deactivate };
