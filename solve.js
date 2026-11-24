// solve.js — a fast drop-in for makefun-site 1.0.0.
//
// Answers every case with exactly the output tree makefun-site 1.0.0's
// build() returns, byte for byte, but built for speed: bulk escaping
// instead of per-character escaping, a fused Markdown lexer/renderer,
// indexOf-driven inline parsing, an ASCII fast path for slugs, and no
// allocations on the hot paths that can be avoided.
//
// The observable behaviour (front matter, template dialect, Markdown
// subset, slug rule, report) matches makefun-site 1.0.0 exactly; its code
// is the reference wherever its README differs from it.
//
// export: run(input) -> output tree (plain object of path -> text)

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];
const DAYS_IN = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

// ---------------------------------------------------------------- text --

// Characters escapeHtml replaces, and their entities.
const ESCAPE_TEST = /[&<>"']/;
const ESCAPE_FIND = /[&<>"']/g;
const ENTITIES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

// Escape &, <, >, " and ' exactly as makefun-site does. Most strings hold
// none of those, so a single fast test returns the input unchanged.
export function escapeHtml(s) {
  if (!ESCAPE_TEST.test(s)) return s;
  let out = '';
  let start = 0;
  ESCAPE_FIND.lastIndex = 0;
  let m;
  while ((m = ESCAPE_FIND.exec(s)) !== null) {
    out += s.slice(start, m.index) + ENTITIES[m[0]];
    start = m.index + 1;
  }
  return out + s.slice(start);
}

// Slug rule: NFKD, drop combining marks, A-Z lowered, each run of
// non [a-z0-9] becomes one '-', none at either end, cut to 64 chars
// (a trailing '-' at the cut is dropped), 'untitled' when empty.
// Pure-ASCII input is the common case and skips normalisation entirely:
// NFKD is the identity on ASCII and ASCII holds no combining marks.
function slugifySlow(text) {
  const plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
  let out = '';
  let gap = false;
  for (const ch of plain) {
    if (ch >= 'A' && ch <= 'Z') {
      if (gap) out += '-';
      gap = false;
      out += ch.toLowerCase();
    } else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) {
      if (gap) out += '-';
      gap = false;
      out += ch;
    } else {
      gap = out.length > 0;
    }
  }
  out = out.slice(0, 64).replace(/-+$/, '');
  return out === '' ? 'untitled' : out;
}

function slugify(text) {
  let out = '';
  let gap = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c >= 128) return slugifySlow(text);
    if (c >= 65 && c <= 90) {
      if (gap) out += '-';
      gap = false;
      out += String.fromCharCode(c + 32);
    } else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) {
      if (gap) out += '-';
      gap = false;
      out += text[i];
    } else {
      gap = out.length > 0;
    }
  }
  out = out.slice(0, 64).replace(/-+$/, '');
  return out === '' ? 'untitled' : out;
}

function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

// '2026-11-09' -> '9 November 2026', from the string alone.
function longDate(date) {
  const parts = date.split('-');
  return `${Number(parts[2])} ${MONTHS[Number(parts[1]) - 1]} ${parts[0]}`;
}

// A word is a run of non-whitespace, exactly as /\S+/g counts it.
// Counted by hand so no array of matches is ever allocated, with the
// whitespace test inlined: ASCII whitespace (the common case) is two
// comparisons, and the wider \s set is checked only past ASCII.
function isSpaceCode(c) {
  return c === 9 || c === 10 || c === 11 || c === 12 || c === 13 || c === 32 ||
    c === 160 || c === 5760 || (c >= 8192 && c <= 8202) || c === 8232 ||
    c === 8233 || c === 8239 || c === 8287 || c === 12288 || c === 65279;
}

function wordsOf(text) {
  let count = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    const space = c < 128
      ? (c === 32 || (c >= 9 && c <= 13))
      : isSpaceCode(c);
    if (space) {
      inWord = false;
    } else if (!inWord) {
      inWord = true;
      count++;
    }
  }
  return count;
}

// ---------------------------------------------------------- front matter --

const FM_KEYS = new Set(['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary']);

// A line of only spaces/tabs (or empty).
function isBlankLine(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

function trimLineEnds(s) {
  let a = 0;
  let b = s.length;
  while (a < b && (s.charCodeAt(a) === 32 || s.charCodeAt(a) === 9)) a++;
  while (b > a && (s.charCodeAt(b - 1) === 32 || s.charCodeAt(b - 1) === 9)) b--;
  return s.slice(a, b);
}

function isAlnumLower(c) {
  return (c >= 48 && c <= 57) || (c >= 97 && c <= 122);
}

// valueOf mirrors makefun-site's key rules exactly, including every
// error string. Returns { value } or { error }.
function fmValue(key, raw) {
  if (key === 'title' || key === 'summary') {
    if (raw.charCodeAt(0) === 34) { // opens on '"'
      if (raw.length < 2 || raw.charCodeAt(raw.length - 1) !== 34) {
        return { error: `key "${key}": a quoted string is not closed` };
      }
      let out = '';
      for (let i = 1; i < raw.length - 1; i++) {
        const c = raw[i];
        if (c === '\\') {
          const n = raw[i + 1];
          if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) {
            return { error: `key "${key}": a quoted string holds an escape other than \\" or \\\\` };
          }
          out += n;
          i++;
        } else if (c === '"') {
          return { error: `key "${key}": a quoted string holds a stray quote` };
        } else {
          out += c;
        }
      }
      return { value: out };
    }
    if (raw.charCodeAt(0) === 91) { // opens on '['
      return { error: `key "${key}": a bare string opens on [` };
    }
    return { value: raw };
  }
  if (key === 'date') {
    // YYYY-MM-DD, a real day from 1970-01-01 to 2099-12-31.
    let ok = raw.length === 10 && raw.charCodeAt(4) === 45 && raw.charCodeAt(7) === 45;
    let y = 0;
    let mo = 0;
    let d = 0;
    if (ok) {
      for (let i = 0; i < 10; i++) {
        if (i === 4 || i === 7) continue;
        const c = raw.charCodeAt(i);
        if (c < 48 || c > 57) { ok = false; break; }
        if (i < 4) y = y * 10 + (c - 48);
        else if (i < 7) mo = mo * 10 + (c - 48);
        else d = d * 10 + (c - 48);
      }
    }
    if (ok) {
      const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
      const maxDay = DAYS_IN[mo - 1] + (mo === 2 && leap ? 1 : 0);
      if (y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > maxDay) ok = false;
    }
    if (!ok) {
      return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
    }
    return { value: raw };
  }
  if (key === 'tags') {
    if (raw.length < 2 || raw.charCodeAt(0) !== 91 || raw.charCodeAt(raw.length - 1) !== 93) {
      return { error: 'key "tags": not a list [a, b]' };
    }
    const inner = raw.slice(1, -1);
    if (inner.trim() === '') return { value: [] };
    const parts = inner.split(',');
    const out = [];
    for (let p = 0; p < parts.length; p++) {
      const t = parts[p].trim();
      if (t === '') return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      for (let i = 0; i < t.length; i++) {
        const c = t.charCodeAt(i);
        if (c === 34 || c === 91 || c === 93) {
          return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
        }
      }
      out.push(t);
    }
    return { value: out };
  }
  if (key === 'draft') {
    if (raw === 'true') return { value: true };
    if (raw === 'false') return { value: false };
    return { error: 'key "draft": true or false' };
  }
  if (key === 'layout') {
    for (let i = 0; i < raw.length; i++) {
      const c = raw.charCodeAt(i);
      if (!isAlnumLower(c) && c !== 45) {
        return { error: 'key "layout": not a template name' };
      }
    }
    return { value: raw };
  }
  // slug: [a-z0-9]+(-[a-z0-9]+)*, at most 64 chars.
  let ok = raw.length > 0 && raw.length <= 64;
  if (ok) {
    let i = 0;
    const n = raw.length;
    if (!isAlnumLower(raw.charCodeAt(0))) ok = false;
    while (ok && i < n) {
      while (i < n && isAlnumLower(raw.charCodeAt(i))) i++;
      if (i === n) break;
      if (raw.charCodeAt(i) !== 45) { ok = false; break; }
      i++;
      if (i === n || !isAlnumLower(raw.charCodeAt(i))) { ok = false; break; }
    }
  }
  if (!ok) return { error: 'key "slug": not a slug' };
  return { value: raw };
}

// Parse one front-matter line (1-based line number lineno, counting the
// opening '---' as line 1). Returns null to skip, or an error string.
function fmLine(line, lineno, data) {
  if (isBlankLine(line)) return null;
  if (line.charCodeAt(0) === 35) return null; // comment opens on '#'
  const ci = line.indexOf(':');
  if (ci <= 0) return `line ${lineno} is not "key: value"`;
  for (let k = 0; k < ci; k++) {
    const cc = line.charCodeAt(k);
    if (!((cc >= 97 && cc <= 122) || cc === 95)) return `line ${lineno} is not "key: value"`;
  }
  const key = line.slice(0, ci);
  let raw;
  if (ci === line.length - 1) raw = '';
  else if (line.charCodeAt(ci + 1) === 32) raw = line.slice(ci + 2);
  else return `line ${lineno} is not "key: value"`;
  let end = raw.length;
  while (end > 0 && (raw.charCodeAt(end - 1) === 32 || raw.charCodeAt(end - 1) === 9)) end--;
  if (end < raw.length) raw = raw.slice(0, end);
  if (!FM_KEYS.has(key)) return `unknown key "${key}"`;
  if (Object.hasOwn(data, key)) return `key "${key}" is given twice`;
  if (raw === '') return `key "${key}" has no value`;
  const v = fmValue(key, raw);
  if (v.error !== undefined) return v.error;
  data[key] = v.value;
  return null;
}

// Parse the front matter of a source. The body is sliced, never split
// and rejoined (a split/join round-trip is the identity, so the body is
// exactly the text after the closing line). Returns { data, body } or
// { error }.
function parseFrontMatter(text) {
  const nl = text.indexOf('\n');
  const first = nl === -1 ? text : text.slice(0, nl);
  if (first !== '---') return { error: 'no front matter' };
  if (nl === -1) return { error: 'the front matter is not closed' };
  // Find the closing line first, before processing any line: without
  // one, the error is 'the front matter is not closed' even if an
  // earlier line is itself malformed.
  let closeStart = -1;
  let closeEnd = -1;
  let pos = nl + 1;
  for (;;) {
    const end = text.indexOf('\n', pos);
    const line = end === -1 ? text.slice(pos) : text.slice(pos, end);
    if (line === '---') {
      closeStart = pos;
      closeEnd = end;
      break;
    }
    if (end === -1) return { error: 'the front matter is not closed' };
    pos = end + 1;
  }
  const data = {};
  let lineno = 2;
  pos = nl + 1;
  while (pos < closeStart) {
    const end = text.indexOf('\n', pos);
    const err = fmLine(text.slice(pos, end), lineno, data);
    if (err !== null) return { error: err };
    pos = end + 1;
    lineno++;
  }
  if (data.title === undefined) return { error: 'no title' };
  return { data, body: closeEnd === -1 ? '' : text.slice(closeEnd + 1) };
}

// -------------------------------------------------------------- markdown --

// Characters a backslash can escape in inline text.
const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);
// Characters that can open an inline construct (or an escape). The
// pattern is compiled fresh in each inline() call: inline() recurses
// (strong/em/link text), so a shared /g regex would lose its lastIndex.

// findUnescaped in makefun-site scans left to right, skipping \-pairs.
// A candidate is escaped exactly when the run of backslashes immediately
// before it has odd length: the scan reaches that run fresh (the char
// before the run is not a backslash, or the run starts at `from`), pairs
// the backslashes off two by two, and a leftover one escapes the next
// char. So indexOf jumps plus a parity count give the same answer.
function countBackslashes(s, from, j) {
  let n = 0;
  for (let p = j - 1; p >= from && s.charCodeAt(p) === 92; p--) n++;
  return n;
}

function findStrong(s, from) {
  let j = s.indexOf('**', from);
  while (j !== -1) {
    if (countBackslashes(s, from, j) % 2 === 0) return j;
    j = s.indexOf('**', j + 1);
  }
  return -1;
}

function findEm(s, from) {
  let j = s.indexOf('*', from);
  while (j !== -1) {
    if (countBackslashes(s, from, j) % 2 === 1) { j = s.indexOf('*', j + 1); continue; }
    if (s.charCodeAt(j + 1) === 42) { j = s.indexOf('*', j + 2); continue; }
    return j;
  }
  return -1;
}

function findBracket(s, from) {
  let j = s.indexOf(']', from);
  while (j !== -1) {
    if (countBackslashes(s, from, j) % 2 === 0) return j;
    j = s.indexOf(']', j + 1);
  }
  return -1;
}

// Render inline markup into `out` (an array of string pieces). Plain
// runs are bulk-escaped in one call instead of character by character;
// constructs are found with indexOf jumps.
function inline(s, env, out) {
  const re = /[\\`*\[]/g;
  let start = 0;
  let m;
  while ((m = re.exec(s)) !== null) {
    const i = m.index;
    const c = s.charCodeAt(i);
    if (c === 92) { // backslash
      const n = s[i + 1];
      if (n !== undefined && ESCAPABLE.has(n)) {
        if (i > start) out.push(escapeHtml(s.slice(start, i)));
        out.push(escapeHtml(n));
        start = i + 2;
        re.lastIndex = i + 2;
      }
      // otherwise the backslash is itself: it stays in the plain run.
      continue;
    }
    if (c === 96) { // backtick: code span, plain indexOf, no escapes
      const j = s.indexOf('`', i + 1);
      if (j > i + 1) {
        if (i > start) out.push(escapeHtml(s.slice(start, i)));
        out.push('<code>', escapeHtml(s.slice(i + 1, j)), '</code>');
        start = j + 1;
        re.lastIndex = j + 1;
      }
      // otherwise the backtick is itself: it stays in the plain run.
      continue;
    }
    if (c === 42) { // '*'
      if (s.charCodeAt(i + 1) === 42) { // strong
        const j = findStrong(s, i + 2);
        if (j > i + 2) {
          if (i > start) out.push(escapeHtml(s.slice(start, i)));
          out.push('<strong>');
          inline(s.slice(i + 2, j), env, out);
          out.push('</strong>');
          start = j + 2;
          re.lastIndex = j + 2;
        } else {
          // literal '**': skip both stars so the second is not read as
          // an emphasis opener. They stay in the plain run.
          re.lastIndex = i + 2;
        }
      } else { // emphasis
        const j = findEm(s, i + 1);
        if (j > i + 1) {
          if (i > start) out.push(escapeHtml(s.slice(start, i)));
          out.push('<em>');
          inline(s.slice(i + 1, j), env, out);
          out.push('</em>');
          start = j + 1;
          re.lastIndex = j + 1;
        }
        // otherwise the star is itself: it stays in the plain run.
      }
      continue;
    }
    // '[': a link, if a ']' closes the text, '(' follows at once, and a
    // non-empty target without whitespace follows.
    const k = findBracket(s, i + 1);
    const p = k !== -1 && s.charCodeAt(k + 1) === 40 ? s.indexOf(')', k + 2) : -1;
    if (p !== -1) {
      const target = s.slice(k + 2, p);
      if (target !== '' && !/\s/.test(target)) {
        if (i > start) out.push(escapeHtml(s.slice(start, i)));
        out.push('<a href="', escapeHtml(env.link(target)), '">');
        inline(s.slice(i + 1, k), env, out);
        out.push('</a>');
        start = p + 1;
        re.lastIndex = p + 1;
      }
    }
    // otherwise the bracket is itself: it stays in the plain run.
  }
  if (start < s.length) out.push(escapeHtml(s.slice(start)));
}

function inlineStr(s, env) {
  const out = [];
  inline(s, env, out);
  return out.join('');
}

// ------------------------------------------------------------ block scan --

// '```' + optional lang [A-Za-z0-9_+-]* + spaces/tabs only. Returns the
// lang, or null when the line does not open a fence.
function fenceOpen(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return null;
  let i = 3;
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) ||
        c === 95 || c === 43 || c === 45) { i++; continue; }
    break;
  }
  const lang = line.slice(3, i);
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return null;
    i++;
  }
  return lang;
}

// '```' + spaces/tabs only.
function isFenceClose(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return false;
  for (let i = 3; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

// 1-6 '#', at least one space/tab, then non-empty text with trailing
// spaces/tabs dropped. Returns { depth, text } or null.
function headingOf(line) {
  let depth = 0;
  while (depth < line.length && line.charCodeAt(depth) === 35) depth++;
  if (depth === 0 || depth > 6) return null;
  let i = depth;
  if (i >= line.length) return null;
  const c = line.charCodeAt(i);
  if (c !== 32 && c !== 9) return null;
  while (i < line.length && (line.charCodeAt(i) === 32 || line.charCodeAt(i) === 9)) i++;
  let end = line.length;
  while (end > i && (line.charCodeAt(end - 1) === 32 || line.charCodeAt(end - 1) === 9)) end--;
  if (end <= i) return null;
  return { depth, text: line.slice(i, end) };
}

// '---' or '***' + spaces/tabs only.
function isHr(line) {
  const c = line.charCodeAt(0);
  if (c !== 45 && c !== 42) return false;
  if (line.charCodeAt(1) !== c || line.charCodeAt(2) !== c) return false;
  for (let i = 3; i < line.length; i++) {
    const d = line.charCodeAt(i);
    if (d !== 32 && d !== 9) return false;
  }
  return true;
}

// A list item line: '- ' / '* ' (bullet) or 1-9 digits + '. ' (ordered).
// Returns { ordered, start, text } or null.
function listMarker(line) {
  const c0 = line.charCodeAt(0);
  if ((c0 === 45 || c0 === 42) && line.charCodeAt(1) === 32) {
    return { ordered: false, start: 1, text: trimLineEnds(line.slice(2)) };
  }
  if (c0 >= 48 && c0 <= 57) {
    let i = 0;
    let n = 0;
    while (i < line.length && i < 9) {
      const c = line.charCodeAt(i);
      if (c < 48 || c > 57) break;
      n = n * 10 + (c - 48);
      i++;
    }
    if (i > 0 && i < 10 && line.charCodeAt(i) === 46 && line.charCodeAt(i + 1) === 32) {
      // A 10-digit run is not a marker: the digit loop above stops at 9,
      // so a 10th digit means line[i] is a digit, not '.', and we fail.
      return { ordered: true, start: n, text: trimLineEnds(line.slice(i + 2)) };
    }
  }
  return null;
}

// A continuation line: 2+ spaces, then a non-whitespace character.
function isContinued(line) {
  let i = 0;
  while (i < line.length && line.charCodeAt(i) === 32) i++;
  if (i < 2 || i >= line.length) return false;
  return !isSpaceCode(line.charCodeAt(i));
}

// A line that ends a paragraph: blank, a fence opening, a heading, or a
// thematic break. (Quote and list lines do not end a paragraph.) Each of
// the four can only start with certain characters, so the first
// character decides which test can possibly pass; most lines are
// decided by that one comparison alone.
function endsParagraph(line) {
  const c0 = line.charCodeAt(0);
  if (c0 === 96) return fenceOpen(line) !== null; // '`'
  if (c0 === 35) return headingOf(line) !== null; // '#'
  if (c0 === 45 || c0 === 42) return isHr(line); // '-' or '*'
  if (line === '' || c0 === 32 || c0 === 9) return isBlankLine(line);
  return false;
}

// Render a Markdown body in one fused pass: lexing and rendering happen
// together, so no token objects are ever built. Returns
// { html, toc, excerpt } where excerpt is the first paragraph's inline
// HTML, or '' when there is no paragraph.
function renderMarkdown(src, env, b) {
  const lines = src.split('\n');
  const n = lines.length;
  const out = [];
  const toc = [];
  let excerpt = '';
  let haveExcerpt = false;
  const ids = new Set();
  let i = 0;
  while (i < n) {
    // Dispatch on the first character: each block kind can only start
    // with certain characters, so a plain-text line (the common case)
    // falls straight through to the paragraph branch without ever
    // calling a classifier. The checks run in the reference's order:
    // blank, fence, heading, thematic break, quote, list, paragraph.
    const line = lines[i];
    const c0 = line.charCodeAt(0);
    if (c0 === 96) { // '`': a fence, or paragraph text
      const lang = fenceOpen(line);
      if (lang !== null) {
        i++;
        const body = [];
        while (i < n && !isFenceClose(lines[i])) body.push(lines[i++]);
        i++; // past the closing fence, or past the end
        const cls = lang === '' ? '' : ` class="language-${escapeHtml(lang)}"`;
        // Escaping is per character, so escaping the joined body equals
        // escaping each line: one call instead of one per line.
        out.push('<pre><code', cls, '>',
          body.length === 0 ? '' : escapeHtml(body.join('\n') + '\n'),
          '</code></pre>\n');
        continue;
      }
    } else if (c0 === 35) { // '#': a heading, or paragraph text
      const h = headingOf(line);
      if (h !== null) {
        const id = uniqueSlug(slugifyMemo(h.text, b), ids);
        out.push(`<h${h.depth} id="${id}">`);
        if (h.depth === 2 || h.depth === 3) {
          // Only levels 2-3 need their HTML as a string, for the toc.
          const html = inlineStr(h.text, env);
          out.push(html);
          toc.push({ level: h.depth, id, html });
        } else {
          inline(h.text, env, out);
        }
        out.push(`</h${h.depth}>\n`);
        i++;
        continue;
      }
    } else if (c0 === 45 || c0 === 42 || (c0 >= 48 && c0 <= 57)) {
      // '-' or '*': a thematic break, a list, or paragraph text;
      // a digit: an ordered list, or paragraph text.
      if ((c0 === 45 || c0 === 42) && isHr(line)) { out.push('<hr>\n'); i++; continue; }
      const first = listMarker(line);
      if (first !== null) {
        const items = [first.text];
        const ordered = first.ordered;
        const startNum = first.start;
        i++;
        while (i < n) {
          const l = lines[i];
          const d0 = l.charCodeAt(0);
          if (d0 === 45 || d0 === 42 || (d0 >= 48 && d0 <= 57)) {
            const m = listMarker(l);
            if (m !== null && m.ordered === ordered) { items.push(m.text); i++; continue; }
            // A marker-start line that is not our marker ends the list:
            // it cannot be a continuation (those open on spaces).
            break;
          }
          if (d0 === 32 && isContinued(l)) {
            items[items.length - 1] += `\n${trimLineEnds(l)}`;
            i++;
            continue;
          }
          break;
        }
        if (ordered) out.push(startNum === 1 ? '<ol>\n' : `<ol start="${startNum}">\n`);
        else out.push('<ul>\n');
        for (let k = 0; k < items.length; k++) {
          out.push('<li>');
          inline(items[k], env, out);
          out.push('</li>\n');
        }
        out.push(ordered ? '</ol>\n' : '</ul>\n');
        continue;
      }
    } else if (c0 === 62) { // '>': always a blockquote
      const body = [];
      while (i < n && lines[i].charCodeAt(0) === 62) {
        const l = lines[i++];
        body.push(trimLineEnds(l.charCodeAt(1) === 32 ? l.slice(2) : l.slice(1)));
      }
      const kept = body.filter((l) => l !== '');
      if (kept.length === 0) out.push('<blockquote>\n</blockquote>\n');
      else {
        out.push('<blockquote>\n<p>');
        inline(kept.join('\n'), env, out);
        out.push('</p>\n</blockquote>\n');
      }
      continue;
    } else if (line === '' || c0 === 32 || c0 === 9) {
      // Empty, or opening on a space/tab: blank, or indented text.
      if (isBlankLine(line)) { i++; continue; }
    }
    const parts = [trimLineEnds(line)];
    i++;
    while (i < n && !endsParagraph(lines[i])) parts.push(trimLineEnds(lines[i++]));
    out.push('<p>');
    if (!haveExcerpt) {
      // Only the first paragraph needs its HTML as a string, for the
      // excerpt; every later paragraph renders straight into the page.
      const html = inlineStr(parts.join('\n'), env);
      excerpt = html;
      haveExcerpt = true;
      out.push(html);
    } else {
      inline(parts.join('\n'), env, out);
    }
    out.push('</p>\n');
  }
  return { html: out.join(''), toc, excerpt };
}

// ------------------------------------------------------------- templates --

class TemplateError extends Error {}

// Node kinds are small integers so the renderer's dispatch is an
// integer switch, not a string comparison per node.
const K_TEXT = 0;
const K_VAR = 1;
const K_RAW = 2;
const K_FOR = 3;
const K_IF = 4;
const K_INCLUDE = 5;
const K_TAG = 6; // tokenizer-only: consumed by the parser
const K_ROOT = 7; // parser-only

const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INCLUDE_RE = /^include "([a-z0-9-]+)"$/;

function pathOf(text) {
  if (!PATH_RE.test(text)) throw new TemplateError(`${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

// Tokenise a template. A {% %} tag alone on its line (only spaces/tabs
// beside it) takes the whole line with it, newline included.
function tokenize(src) {
  const tokens = [];
  let text = '';
  let i = 0;
  for (;;) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(raw ? 'a {{{ is not closed' : 'a {{ is not closed');
      if (text !== '') tokens.push({ kind: K_TEXT, text });
      text = '';
      tokens.push({ kind: raw ? K_RAW : K_VAR, path: pathOf(src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError('a {% is not closed');
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    let standalone = true;
    for (let p = lineStart; p < open; p++) {
      const c = src.charCodeAt(p);
      if (c !== 32 && c !== 9) { standalone = false; break; }
    }
    if (standalone) {
      for (let p = end; p < lineEnd; p++) {
        const c = src.charCodeAt(p);
        if (c !== 32 && c !== 9) { standalone = false; break; }
      }
    }
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ kind: K_TEXT, text });
    text = '';
    tokens.push({ kind: K_TAG, tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ kind: K_TEXT, text });
  return tokens;
}

function parseTemplate(src) {
  const root = { kind: K_ROOT, body: [] };
  const stack = [root];
  let body = root.body;
  for (const token of tokenize(src)) {
    if (token.kind !== K_TAG) {
      body.push(token);
      continue;
    }
    const tag = token.tag;
    let m = FOR_RE.exec(tag);
    if (m !== null) {
      const node = { kind: K_FOR, name: m[1], path: pathOf(m[2]), body: [] };
      body.push(node);
      stack.push(node);
      body = node.body;
      continue;
    }
    m = IF_RE.exec(tag);
    if (m !== null) {
      const node = { kind: K_IF, not: m[1] !== undefined, path: pathOf(m[2]), then: [], else: null };
      body.push(node);
      stack.push(node);
      body = node.then;
      continue;
    }
    if (tag === 'else') {
      const top = stack[stack.length - 1];
      if (top.kind !== K_IF || top.else !== null) throw new TemplateError('an else outside an if');
      top.else = [];
      body = top.else;
      continue;
    }
    if (tag === 'endfor' || tag === 'endif') {
      const top = stack[stack.length - 1];
      if (top.kind !== (tag === 'endfor' ? K_FOR : K_IF)) {
        throw new TemplateError(`an ${tag} with no open ${tag.slice(3)}`);
      }
      stack.pop();
      const parent = stack[stack.length - 1];
      body = parent.kind === K_ROOT ? parent.body : parent.kind === K_FOR ? parent.body : parent.else ?? parent.then;
      continue;
    }
    m = INCLUDE_RE.exec(tag);
    if (m !== null) {
      body.push({ kind: K_INCLUDE, name: m[1] });
      continue;
    }
    throw new TemplateError(`{% ${tag} %} is not a tag`);
  }
  if (stack.length > 1) {
    throw new TemplateError(`a ${stack[stack.length - 1].kind === K_FOR ? 'for' : 'if'} is not closed`);
  }
  return root.body;
}

function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

// Look a dotted path up through the scope stack: the first name comes
// from the innermost frame holding it, then each next name is an own
// property or the lookup is undefined.
function lookup(path, scopes) {
  const first = path[0];
  let v;
  let found = false;
  for (let s = scopes.length - 1; s >= 0; s--) {
    const vars = scopes[s];
    if (Object.hasOwn(vars, first)) { v = vars[first]; found = true; break; }
  }
  if (!found) return undefined;
  for (let k = 1; k < path.length; k++) {
    if (typeof v !== 'object' || v === null || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

function renderNodes(nodes, scopes, ctx, depth, out) {
  for (let n = 0; n < nodes.length; n++) {
    const node = nodes[n];
    switch (node.kind) {
      case K_TEXT:
        out.push(node.text);
        break;
      case K_VAR: {
        // Most values are strings: skip the textOf call for them.
        const v = lookup(node.path, scopes);
        out.push(escapeHtml(typeof v === 'string' ? v : textOf(v)));
        break;
      }
      case K_RAW: {
        const v = lookup(node.path, scopes);
        out.push(typeof v === 'string' ? v : textOf(v));
        break;
      }
      case K_FOR: {
        const xs = lookup(node.path, scopes);
        if (!Array.isArray(xs)) break;
        // One vars object and one loop object per for-node, reused
        // across iterations and renders instead of allocated per
        // iteration. Their previous contents are saved and restored
        // around the loop, so a template that includes itself (and
        // re-enters this same node) still sees its own values: renders
        // nest strictly, and the inner render restores before the
        // outer one reads again. When the element is named 'loop',
        // the loop object wins, exactly as in the reference's object
        // literal { [name]: x, loop: {...} }.
        let vars = node.vars;
        if (vars === undefined) {
          vars = {};
          node.vars = vars;
        }
        let loop = node.loop;
        if (loop === undefined) {
          loop = { index: 0, first: false, last: false, length: 0 };
          node.loop = loop;
        }
        const name = node.name;
        const savedVar = vars[name];
        const savedLoop = vars.loop;
        const savedIndex = loop.index;
        const savedFirst = loop.first;
        const savedLast = loop.last;
        const savedLength = loop.length;
        scopes.push(vars);
        for (let k = 0; k < xs.length; k++) {
          vars[name] = xs[k];
          vars.loop = loop;
          loop.index = k + 1;
          loop.first = k === 0;
          loop.last = k === xs.length - 1;
          loop.length = xs.length;
          renderNodes(node.body, scopes, ctx, depth, out);
        }
        scopes.pop();
        vars[name] = savedVar;
        vars.loop = savedLoop;
        loop.index = savedIndex;
        loop.first = savedFirst;
        loop.last = savedLast;
        loop.length = savedLength;
        break;
      }
      case K_IF: {
        const branch = truthy(lookup(node.path, scopes)) !== node.not ? node.then : node.else;
        if (branch !== null) renderNodes(branch, scopes, ctx, depth, out);
        break;
      }
      default: {
        // include: same scope, one past depth 8 renders nothing.
        const t = ctx.templates.get(node.name);
        if (t !== undefined && depth < 8) renderNodes(t, scopes, ctx, depth + 1, out);
        break;
      }
    }
  }
}

// ---------------------------------------------------------------- build --

function byCodeUnits(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function dirOf(path) {
  const i = path.lastIndexOf('/');
  return i === -1 ? '' : path.slice(0, i);
}

// Per-build memoisation only: the caches live on `b`, which is fresh for
// every run() call, so nothing is ever carried from one case to the next.
function slugifyMemo(text, b) {
  const hit = b.slugCache.get(text);
  if (hit !== undefined) return hit;
  const s = slugify(text);
  b.slugCache.set(text, s);
  return s;
}

function longDateMemo(date, b) {
  const hit = b.dateCache.get(date);
  if (hit !== undefined) return hit;
  const s = longDate(date);
  b.dateCache.set(date, s);
  return s;
}

// dirParts is the source's directory already split (once per source,
// not once per link); the copy is mutated, never the original.
function resolvePath(dirParts, rel) {
  const parts = dirParts.slice();
  for (const part of rel.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (parts.length === 0) return null;
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  return parts.join('/');
}

const SCHEME_RE = /^[A-Za-z][A-Za-z0-9+.-]*:/;

function cardOf(s, b) {
  return {
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDateMemo(s.data.date, b),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(wordsOf(s.body) / 200)),
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  };
}

function linkOf(s, b) {
  if (s === null) return null;
  return {
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDateMemo(s.data.date, b),
  };
}

function pageOf(s, b) {
  // Posts reuse the card the layouts stage already computed; the spread
  // copies it, so the cached card is never mutated.
  const card = s.post ? b.cards.get(s) : cardOf(s, b);
  return {
    ...card,
    slug: s.slug,
    content: s.html,
    toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
    newer: linkOf(s.newer ?? null, b),
    older: linkOf(s.older ?? null, b),
    is_post: s.post,
  };
}

const RESERVED = ['posts', 'tags', 'page'];

export function run(input) {
  const b = {
    base: input.site.base_url.replace(/\/+$/, ''),
    templates: new Map(),
    report: [],
    output: {},
    slugCache: new Map(),
    dateCache: new Map(),
  };

  // Templates, parsed in code-unit name order. One that does not parse
  // is reported and left out; anything else thrown is a real bug.
  const names = Object.keys(input.templates).sort(byCodeUnits);
  for (const name of names) {
    try {
      b.templates.set(name, parseTemplate(input.templates[name]));
    } catch (err) {
      if (err instanceof TemplateError) b.report.push(`template "${name}": ${err.message}`);
      else throw err;
    }
  }

  // readSources: files in code-unit path order; .md sources have their
  // line endings normalised, the rest are static. The replace is skipped
  // outright when the content holds no carriage return.
  const files = input.files.slice().sort((x, y) => byCodeUnits(x.path, y.path));
  const sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) {
      sources.push({
        path: f.path,
        text: f.content.indexOf('\r') === -1 ? f.content : f.content.replace(/\r\n?/g, '\n'),
      });
    } else {
      statics.push(f);
    }
  }

  // frontMatter: refuse, reserve, date, layout, draft — in that order.
  const kept = [];
  for (const s of sources) {
    const parsed = parseFrontMatter(s.text);
    if (parsed.error !== undefined) {
      b.report.push(`refused ${s.path}: ${parsed.error}`);
      continue;
    }
    const post = s.path.startsWith('posts/');
    const reserved = post ? undefined : RESERVED.find((d) => d !== 'posts' && s.path.startsWith(`${d}/`));
    if (reserved !== undefined) {
      b.report.push(`refused ${s.path}: ${reserved}/ is the generator's own`);
      continue;
    }
    if (post && parsed.data.date === undefined) {
      b.report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = parsed.data.layout ?? (post ? 'post' : 'page');
    if (!b.templates.has(layout)) {
      b.report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    if (parsed.data.draft === true) {
      b.report.push(`draft ${s.path}`);
      continue;
    }
    s.data = parsed.data;
    s.body = parsed.body;
    s.layout = layout;
    s.post = post;
    kept.push(s);
  }
  b.sources = kept;
  b.statics = statics;

  // permalinks: slugs unique in their directory, in source order; at
  // the root, posts, tags and page are taken from the start.
  const takenByDir = new Map([['', new Set(RESERVED)]]);
  for (const s of b.sources) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    let taken = takenByDir.get(dir);
    if (taken === undefined) {
      taken = new Set();
      takenByDir.set(dir, taken);
    }
    const slug = uniqueSlug(s.data.slug ?? slugifyMemo(s.data.title, b), taken);
    const outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.slug = slug;
    s.outDir = outDir;
    s.url = `${b.base}/${outDir}/`;
  }

  // markdown: render each body, resolving links against pages and
  // static files, recording broken ones once each.
  const bySource = new Map(b.sources.map((s) => [s.path, s]));
  const staticPaths = new Set(b.statics.map((f) => f.path));
  const broken = new Set();
  for (const s of b.sources) {
    const dir = dirOf(s.path);
    const dirParts = dir === '' ? [] : dir.split('/');
    const env = {
      link: (target) => {
        if (SCHEME_RE.test(target) || target.startsWith('/') || target.startsWith('#')) return target;
        const hash = target.indexOf('#');
        const rel = hash === -1 ? target : target.slice(0, hash);
        const frag = hash === -1 ? '' : target.slice(hash);
        const path = rel === '' ? null : resolvePath(dirParts, rel);
        if (path !== null) {
          const page = bySource.get(path);
          if (page !== undefined) return page.url + frag;
          if (staticPaths.has(path)) return `${b.base}/${path}${frag}`;
        }
        broken.add(`broken-link ${s.path} -> ${target}`);
        return target;
      },
    };
    const rendered = renderMarkdown(s.body, env, b);
    s.html = rendered.html;
    s.toc = rendered.toc;
    s.excerpt = rendered.excerpt;
  }
  b.broken = broken;

  // collections: posts newest first, equal dates by slug; neighbours.
  b.posts = b.sources.filter((s) => s.post).sort(
    (x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug),
  );
  for (let k = 0; k < b.posts.length; k++) {
    b.posts[k].newer = k === 0 ? null : b.posts[k - 1];
    b.posts[k].older = k === b.posts.length - 1 ? null : b.posts[k + 1];
  }

  // tags: each post's tags, each slug once, first spelling kept; a tag
  // is all the posts with its slug, in collection order.
  const bySlug = new Map();
  for (const p of b.posts) {
    p.tagRefs = [];
    const seen = new Set();
    for (const name of p.data.tags ?? []) {
      const slug = slugifyMemo(name, b);
      if (seen.has(slug)) continue;
      seen.add(slug);
      let tag = bySlug.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: `${b.base}/tags/${slug}/`, posts: [] };
        bySlug.set(slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  b.tags = [...bySlug.values()].sort(
    (x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug),
  );
  for (const s of b.sources) {
    if (s.post) continue;
    const seen = new Set();
    s.tagRefs = [];
    for (const name of s.data.tags ?? []) {
      const slug = slugifyMemo(name, b);
      if (seen.has(slug)) continue;
      seen.add(slug);
      s.tagRefs.push(bySlug.get(slug) ?? { name, slug, url: '', posts: [] });
    }
  }

  // layouts: every page through its layout, the index paginated, each
  // tag through its template, then the static files.
  b.cards = new Map(b.posts.map((p) => [p, cardOf(p, b)]));
  const site = { title: input.site.title, base_url: b.base };
  const allTags = b.tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = b.posts.slice(0, input.site.recent).map((p) => b.cards.get(p));
  const ctx = { templates: b.templates };
  function render(name, vars) {
    const nodes = b.templates.get(name);
    if (nodes === undefined) return null;
    const scopes = [{ site, tags: allTags, recent, ...vars }];
    const out = [];
    renderNodes(nodes, scopes, ctx, 0, out);
    return out.join('');
  }
  for (const s of b.sources) {
    b.output[`${s.outDir}/index.html`] = render(s.layout, { page: pageOf(s, b) });
  }
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(b.posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${b.base}/` : `${b.base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: b.posts.slice((k - 1) * per, k * per).map((p) => b.cards.get(p)),
      pager: {
        number: k,
        total: pages,
        url: indexUrl(k),
        newer_url: k === 1 ? '' : indexUrl(k - 1),
        older_url: k === pages ? '' : indexUrl(k + 1),
      },
    });
    if (html !== null) b.output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of b.tags) {
    const html = render('tag', {
      tag: {
        name: t.name,
        slug: t.slug,
        url: t.url,
        count: t.posts.length,
        posts: t.posts.map((p) => b.cards.get(p)),
      },
    });
    if (html !== null) b.output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) b.output['tags/index.html'] = tagsHtml;
  for (const f of b.statics) {
    if (Object.hasOwn(b.output, f.path)) b.report.push(`shadowed ${f.path}: a built page has its path`);
    else b.output[f.path] = f.content;
  }

  // report: every reported line and broken link, sorted, then the
  // summary line; every line ends with a newline.
  const lines = [...b.report, ...b.broken].sort(byCodeUnits);
  lines.push(
    `built ${b.sources.filter((s) => !s.post).length} pages, ${b.posts.length} posts, ` +
    `${b.tags.length} tags and ${b.statics.length} static files`,
  );
  b.output['build-report.txt'] = `${lines.join('\n')}\n`;
  return b.output;
}
