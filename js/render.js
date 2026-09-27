// Shared question rendering: inline LaTeX via KaTeX, moderator notes, word-by-word reveal.

export function escapeHtml (s) {
  return s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

export function renderMath (tex) {
  try {
    return window.katex.renderToString(tex, { throwOnError: false, output: 'html' });
  } catch (e) {
    return escapeHtml(tex);
  }
}

// plain text with \( ... \) math, pronunciation guides in [ ] and (read as: ...)
export function renderRich (text) {
  let html = '';
  const re = /\\\((.*?)\\\)/g;
  let last = 0; let m;
  while ((m = re.exec(text))) {
    html += escapeHtml(text.slice(last, m.index));
    html += renderMath(m[1]);
    last = re.lastIndex;
  }
  html += escapeHtml(text.slice(last));
  return html
    .replace(/\[([^\]<]*)\]/g, '<span class="pron">[$1]</span>')
    .replace(/\((read as:[^)<]*)\)/gi, '<span class="pron">($1)</span>');
}

// split into words without breaking a \( ... \) group
export function splitWords (text) {
  const words = [];
  let cur = ''; let inMath = false;
  for (let i = 0; i < text.length; i++) {
    if (text.startsWith('\\(', i)) inMath = true;
    if (text.startsWith('\\)', i)) inMath = false;
    const c = text[i];
    if (/\s/.test(c) && !inMath) {
      if (cur) words.push(cur);
      cur = '';
    } else cur += c;
  }
  if (cur) words.push(cur);
  return words;
}

// tokens: [{ text, br }] where br = starts a choice line
export function tokenize (q) {
  const toks = splitWords(q.text).map(t => ({ text: t }));
  if (q.choices) {
    q.choices.forEach((c, i) => {
      toks.push({ text: 'WXYZ'[i] + ')', br: true });
      splitWords(c).forEach(w => toks.push({ text: w }));
    });
  }
  return toks;
}

export function renderTokens (toks, upto, buzzAt = -1) {
  let html = ''; let line = [];
  const flush = (isChoice) => {
    if (!line.length) return;
    const inner = renderRich(line.join(' '));
    html += isChoice ? `<span class="choice">${inner}</span>` : inner + ' ';
    line = [];
  };
  let inChoice = false;
  for (let i = 0; i < upto; i++) {
    const t = toks[i];
    if (t.br) { flush(inChoice); inChoice = true; }
    if (i === buzzAt) line.push('\u0000BUZZ\u0000');
    line.push(t.text);
  }
  if (buzzAt === upto) line.push('\u0000BUZZ\u0000');
  flush(inChoice);
  return html.replace(/\u0000BUZZ\u0000/g, '<span class="buzzmark">(#)</span>');
}

