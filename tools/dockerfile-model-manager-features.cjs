'use strict';
// Which cargo features does the model-manager image really ship with? Read from
// services/model-manager/Dockerfile by tools/gen-model-manager-routes.cjs, to prove that the
// #[cfg(feature = "...")] gates on `mod routing;` / `mod section_writes;` are open in the shipped binary.
//
// This is fail-closed parsing, not inference. Only active instructions count (comment lines are
// dropped, backslash continuations are joined into logical instructions), and the answer is given only
// when the whole path from the final stage to the binary is unambiguous:
//   1. The last stage (and the stages it inherits from with FROM <stage>) writes the binary path
//      exactly once, by `COPY --from=<stage> <workdir>/target/release/noevia-model-manager <BIN>`.
//      A second write (COPY/ADD to the path or to a directory holding it, another copy, a later
//      overwrite), a RUN that names the binary or its directory, ONBUILD, SHELL, parser directives,
//      heredocs and unresolved `$` in COPY/ADD/WORKDIR/FROM are refused.
//   2. That <stage> (with its own ancestors) contains exactly one cargo build/install that could
//      produce noevia-model-manager. Another `cargo build -p <other>` is ignored only when every -p
//      value is a plain package name other than noevia-model-manager. Any other cargo invocation
//      (second build, with or without features, test/run/install, nested shells) is refused.
//   3. That build uses only --release, --locked, -p/--package, --bin, --features/-F with a literal
//      list of `package/feature` items, and --no-default-features; no `$`/ARG expansion, glob or
//      backtick anywhere in a cargo command; it is not conditional (reached through `&&` only).
// Anything else is an Error naming the reason.

const path = require('node:path');

const BIN = '/usr/local/bin/noevia-model-manager';
const PKG = 'noevia-model-manager';
const PRODUCING = new Set(['build', 'b', 'install', 'rustc', 'run', 'r', 'test', 't', 'bench']);
const NONPRODUCING = new Set(['fetch', 'metadata', 'fmt', 'check', 'c', 'clippy', 'doc', 'd', 'tree', 'vendor', 'version', 'help']);
const LAUNCHERS = new Set(['sh', 'bash', 'dash', 'zsh', 'ash', 'eval', 'exec', 'source', '.', 'make', 'just', 'xargs', 'rustup', 'python', 'python3', 'node', 'perl', 'ruby', 'sudo', 'su', 'nohup', 'find', 'time', 'nice', 'timeout', 'command', 'busybox']);
const RESERVED = new Set(['if', 'then', 'else', 'elif', 'fi', 'while', 'until', 'do', 'done', 'for', 'case', 'esac', '{', '}', '!', 'function', 'select']);
const POST_BUILD_OK = new Set(['printf', 'echo', 'grep', 'true', 'test', '[', '{', '}']);
const fail = (m) => { throw new Error(`Dockerfile: ${m}`); };

// ---- instructions ------------------------------------------------------------------------------

function instructions(text) {
  const physical = text.split(/\r?\n/);
  for (const l of physical) if (/^\s*#\s*(escape|syntax)\s*=/i.test(l) && /escape/i.test(l)) fail('a parser directive changes the escape character');
  const out = [];
  let cur = null;
  for (const raw of physical) {
    const line = raw.replace(/\s+$/, '');
    if (/^\s*#/.test(line)) continue; // comment lines vanish, also inside a continuation
    if (cur === null && line.trim() === '') continue;
    const cont = line.endsWith('\\');
    const body = cont ? line.slice(0, -1) : line;
    cur = (cur === null ? '' : cur) + body;
    if (cont) continue;
    out.push(cur.trim()); cur = null;
  }
  if (cur !== null) fail('the file ends inside a continued instruction');
  return out.filter(Boolean).map((s) => {
    const m = /^(\S+)\s*([\s\S]*)$/.exec(s);
    return { kw: m[1].toUpperCase(), args: m[2] };
  });
}

function stages(text) {
  const list = [];
  for (const ins of instructions(text)) {
    if (ins.kw === 'FROM') {
      const m = /^(?:--\S+\s+)*(\S+)(?:\s+AS\s+(\S+))?\s*$/i.exec(ins.args);
      if (!m) fail(`unreadable FROM ${ins.args}`);
      list.push({ base: m[1], name: m[2] ? m[2].toLowerCase() : null, ins: [] });
    } else if (list.length) list[list.length - 1].ins.push(ins);
    else if (ins.kw !== 'ARG') fail(`${ins.kw} before the first FROM`);
  }
  if (!list.length) fail('no FROM');
  const seen = new Set();
  list.forEach((s, i) => { s.index = i; if (s.name) { if (seen.has(s.name)) fail(`stage ${s.name} is defined twice`); seen.add(s.name); } });
  return list;
}

// The stage plus the stages it inherits from, root first. A base that is not an earlier stage name is an
// external image and ends the chain.
function chainOf(all, stage) {
  const chain = [stage];
  let cur = stage;
  for (;;) {
    if (/[$]/.test(cur.base)) fail(`stage ${cur.name || cur.index} has an unresolved base image ${cur.base}`);
    const parent = all.find((s) => s.name && s.name === cur.base.toLowerCase());
    if (!parent) break;
    if (parent.index >= cur.index) fail(`stage ${cur.name || cur.index} inherits from a stage defined later`);
    chain.unshift(parent); cur = parent;
  }
  return chain;
}

// ---- shell -------------------------------------------------------------------------------------

// Words and operators of one RUN command. Quotes are honoured; `$`, backticks and globs are flagged on
// the word so callers can refuse them; $(...) and `...` bodies are kept for a "cargo hidden inside" test.
function shell(src) {
  const toks = [];
  let i = 0, w = null;
  const n = src.length;
  const open = () => (w === null ? (w = { v: '', raw: '', dollar: false, glob: false, subst: [] }) : w);
  const flush = () => { if (w) { toks.push({ t: 'w', ...w }); w = null; } };
  const op = (v) => { flush(); toks.push({ t: 'op', v }); };
  while (i < n) {
    const c = src[i];
    if (c === ' ' || c === '\t' || c === '\n') { flush(); i++; continue; }
    if (c === '#' && w === null) fail('shell comment inside a RUN command');
    if (c === '&' && src[i + 1] === '&') { op('&&'); i += 2; continue; }
    if (c === '|' && src[i + 1] === '|') { op('||'); i += 2; continue; }
    if (c === '|' || c === ';' || c === '(' || c === ')' || (c === '&' && !/[<>]/.test(src[i - 1] || ''))) { op(c); i++; continue; }
    if (c === '>' || c === '<') {
      let pre = '';
      if (w && /^\d+$/.test(w.v)) { pre = w.v; w = null; } else flush();
      let j = i + 1; if (src[j] === c) j++;
      let target = null;
      if (src[j] === '&') { const m = /^&(\d+|-)/.exec(src.slice(j)); if (!m) fail('unreadable redirection'); j += m[0].length; target = m[0]; }
      toks.push({ t: 'redir', v: pre + src.slice(i, j).replace(/&.*/, '') + (target || ''), needsTarget: target === null });
      i = j; continue;
    }
    const word = open();
    if (c === "'") {
      const e = src.indexOf("'", i + 1); if (e < 0) fail('unterminated quote in a RUN command');
      const lit = src.slice(i + 1, e); word.v += lit; word.raw += src.slice(i, e + 1); if (/[$`]/.test(lit)) word.dollar = true; i = e + 1; continue;
    }
    if (c === '"') {
      let j = i + 1, lit = '';
      for (;;) {
        if (j >= n) fail('unterminated quote in a RUN command');
        if (src[j] === '\\' && j + 1 < n) { lit += src[j + 1]; j += 2; continue; }
        if (src[j] === '"') break;
        if (src[j] === '$' || src[j] === '`') word.dollar = true;
        lit += src[j]; j++;
      }
      word.v += lit; word.raw += src.slice(i, j + 1); i = j + 1; continue;
    }
    if (c === '\\') { word.v += src[i + 1] || ''; word.raw += src.slice(i, i + 2); i += 2; continue; }
    if (c === '`') {
      const e = src.indexOf('`', i + 1); if (e < 0) fail('unterminated backtick');
      word.dollar = true; word.subst.push(src.slice(i + 1, e)); word.v += src.slice(i, e + 1); word.raw += src.slice(i, e + 1); i = e + 1; continue;
    }
    if (c === '$') {
      word.dollar = true;
      if (src[i + 1] === '(') {
        let depth = 0, j = i + 1;
        for (; j < n; j++) { if (src[j] === '(') depth++; else if (src[j] === ')' && --depth === 0) break; }
        if (j >= n) fail('unterminated $(');
        word.subst.push(src.slice(i + 2, j)); word.v += src.slice(i, j + 1); word.raw += src.slice(i, j + 1); i = j + 1; continue;
      }
      if (src[i + 1] === '{') {
        const e = src.indexOf('}', i); if (e < 0) fail('unterminated ${');
        word.v += src.slice(i, e + 1); word.raw += src.slice(i, e + 1); i = e + 1; continue;
      }
    }
    if (c === '*' || c === '?' || c === '[') word.glob = true;
    word.v += c; word.raw += c; i++;
  }
  flush();
  // Segments: command groups between operators.
  const segs = [];
  let cur = { words: [], redirs: [], before: null, after: null };
  for (let k = 0; k < toks.length; k++) {
    const t = toks[k];
    if (t.t === 'op') { cur.after = t.v; segs.push(cur); cur = { words: [], redirs: [], before: t.v, after: null }; continue; }
    if (t.t === 'redir') {
      if (t.needsTarget) { const tgt = toks[++k]; if (!tgt || tgt.t !== 'w') fail('redirection without a target'); cur.redirs.push({ v: t.v, target: tgt.v }); }
      else cur.redirs.push({ v: t.v, target: null });
      continue;
    }
    cur.words.push(t);
  }
  segs.push(cur);
  return segs.filter((s) => s.words.length || s.redirs.length || s.before || s.after);
}

const ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=/;
function command(seg) { // index of the command word: after assignments and a group-opening `{`; -1 when there is none
  let k = 0; while (k < seg.words.length && (ASSIGN.test(seg.words[k].raw) || seg.words[k].v === '{')) k++;
  return k < seg.words.length ? k : -1;
}
const base = (w) => w.v.split('/').pop();

// ---- cargo -------------------------------------------------------------------------------------

function parseCargo(seg, at) {
  const w = seg.words.slice(at + 1);
  for (const x of seg.words) if (x.dollar || x.glob) fail(`a cargo command contains an expansion or glob (${x.raw}); refusing`);
  let k = 0;
  if (!w[k] || w[k].v.startsWith('-') || w[k].v.startsWith('+')) fail(`cargo is called with an unsupported global option (${w[k] ? w[k].v : 'none'})`);
  const sub = w[k++].v;
  if (NONPRODUCING.has(sub)) return { kind: 'other', sub };
  if (!PRODUCING.has(sub)) fail(`cargo subcommand "${sub}" may build the binary and is not understood`);
  const info = { kind: 'build', sub, packages: [], bins: [], features: [], noDefault: false, options: [] };
  const val = (opt, inline) => { if (inline !== undefined) return inline; const v = w[k++]; if (!v || v.v.startsWith('-')) fail(`cargo ${opt} has no value`); return v.v; };
  while (k < w.length) {
    const a = w[k++].v, eq = a.indexOf('=');
    const name = a.startsWith('--') && eq > 0 ? a.slice(0, eq) : a, inline = a.startsWith('--') && eq > 0 ? a.slice(eq + 1) : undefined;
    if (name === '--release' || name === '--locked') { info.options.push(name); continue; }
    if (name === '--no-default-features') { info.noDefault = true; continue; }
    if (name === '-p' || name === '--package') { info.packages.push(val(name, inline)); continue; }
    if (name === '--bin') { info.bins.push(val(name, inline)); continue; }
    if (name === '--features' || name === '-F') { info.features.push(...val(name, inline).split(',')); continue; }
    fail(`cargo ${sub} uses an option outside the supported set: ${a}`);
  }
  if (sub !== 'build' && sub !== 'b') fail(`cargo ${sub} could produce ${PKG} and is not a supported build command`);
  return info;
}
const plain = (p) => /^[A-Za-z0-9_-]+$/.test(p);
const couldProduce = (b) => !(b.packages.length > 0 && b.packages.every((p) => plain(p) && p !== PKG) && b.bins.every((x) => plain(x) && x !== PKG));

// ---- paths -------------------------------------------------------------------------------------

function resolveDir(workdir, p, what) {
  if (/[$]/.test(p)) fail(`${what} uses an unresolved variable (${p})`);
  return path.posix.normalize(p.startsWith('/') ? p : path.posix.join(workdir, p));
}
// Does a COPY/ADD (sources, dest) possibly write `target`?
function writes(srcs, dest, target) {
  const dir = dest.endsWith('/') || dest === '.' || dest.endsWith('/.') || srcs.length > 1 || srcs.some((s) => /[*?[]|\/$|\/\.$/.test(s) || s === '.');
  const d = dest.replace(/\/+$/, '') || '/';
  if (d === target) return true;
  if (target.startsWith(d === '/' ? '/' : d + '/')) return true; // a directory copy can place it
  return dir && srcs.some((s) => path.posix.join(d, path.posix.basename(s)) === target);
}

function copyOf(ins, workdir) {
  if (/^\s*\[/.test(ins.args)) fail(`${ins.kw} in JSON form cannot be checked`);
  const words = ins.args.split(/\s+/).filter(Boolean);
  let from = null;
  while (words.length && words[0].startsWith('--')) {
    const m = /^--from=(.+)$/.exec(words[0]);
    if (m && ins.kw === 'COPY') from = m[1]; else fail(`${ins.kw} uses an option other than --from (${words[0]})`);
    words.shift();
  }
  if (words.length < 2) fail(`unreadable ${ins.kw}`);
  for (const x of words) if (/[$]/.test(x)) fail(`${ins.kw} uses an unresolved variable (${x})`);
  const dest = words.pop();
  let d = path.posix.normalize(dest.startsWith('/') ? dest : path.posix.join(workdir, dest));
  if (dest === '.' && !d.endsWith('/')) d += '/';
  return { from, srcs: words, dest: d };
}

// ---- the build stage ---------------------------------------------------------------------------

function proveBuild(all, stage) {
  const chain = chainOf(all, stage);
  let workdir = '/', found = null, afterBuild = false, builtDir = null;
  for (const st of chain) {
    for (const ins of st.ins) {
      if (ins.kw === 'ONBUILD' || ins.kw === 'SHELL') fail(`${ins.kw} in the build stage chain`);
      if (ins.kw === 'ENV' || ins.kw === 'ARG') { if (/\bCARGO_(BUILD_)?TARGET(_DIR)?\b|\bCARGO_BUILD_BUILD_DIR\b/.test(ins.args)) fail('the build stage redirects cargo output'); continue; }
      if (ins.kw === 'WORKDIR') { workdir = resolveDir(workdir, ins.args.trim(), 'WORKDIR'); continue; }
      if (ins.kw === 'COPY' || ins.kw === 'ADD') {
        if (afterBuild && builtDir) { const c = /^(?:--\S+\s+)*([\s\S]*)$/.exec(ins.args); const ws = c[1].split(/\s+/); const d = ws[ws.length - 1]; if (writes(ws.slice(0, -1), d.startsWith('/') ? d : path.posix.join(workdir, d), builtDir + '/target/release/' + PKG)) fail('the build stage copies over the built binary'); }
        continue;
      }
      if (ins.kw !== 'RUN') continue;
      if (/^\s*(--|\[)/.test(ins.args) || /<<-?\s*['"]?\w/.test(ins.args)) fail('a RUN with flags, exec form or a heredoc in the build stage chain cannot be checked');
      const segs = shell(ins.args);
      const afterBuildAtStart = afterBuild;
      let seenBuild = false;
      segs.forEach((seg, si) => {
        for (const x of seg.words) for (const s of x.subst) if (/\bcargo\b/.test(s)) fail('cargo is hidden inside a command substitution');
        if (!found && seg.words[0] && RESERVED.has(seg.words[0].v)) fail(`shell construct "${seg.words[0].v}" before the build in the build stage`);
        const at = command(seg);
        if (at < 0) return;
        const cmd = seg.words[at];
        const cmdBase = base(cmd);
        if (cmdBase === 'cargo') {
          if (cmd.dollar) fail('cargo is invoked through an expansion');
          const b = parseCargo(seg, at);
          if (b.kind !== 'build' || !couldProduce(b)) return;
          if (found) fail(`a second cargo build could produce ${PKG}: only one build is accepted`);
          if (!b.packages.includes(PKG)) fail(`the cargo build does not name -p ${PKG}`);
          // Reached only through && (pipes before it are fine), and followed only by && or the end.
          for (let p = 0; p < si; p++) if (segs[p].after && !['&&', '|'].includes(segs[p].after)) fail(`the cargo build is conditional or backgrounded (${segs[p].after} before it)`);
          for (let p = 0; p < si; p++) if (segs[p].words[0] && RESERVED.has(segs[p].words[0].v)) fail('the cargo build sits inside a shell construct');
          if (!['&&', null].includes(seg.after)) fail(`the cargo build is followed by ${seg.after}`);
          if (seg.before && seg.before !== '&&') fail(`the cargo build is preceded by ${seg.before}`);
          found = { ...b, workdir }; seenBuild = true; builtDir = workdir; return;
        }
        if (cmd.v.includes('cargo')) fail(`unsupported command mentioning cargo (${cmd.v})`);
        const unwrapped = cmdBase === 'env' ? seg.words.slice(at + 1).find((x, k, a) => !x.v.startsWith('-') && !ASSIGN.test(x.raw) && !(a[k - 1] && a[k - 1].v === '-u')) : cmd;
        const ub = unwrapped ? base(unwrapped) : '';
        for (const x of seg.words.slice(at)) if (x !== cmd && base(x) === 'cargo') fail('cargo is not a plain command word (wrapped, quoted or an argument)');
        if (LAUNCHERS.has(cmdBase) || LAUNCHERS.has(ub)) fail(`the build stage runs "${cmdBase === 'env' ? ub : cmdBase}", which could build or rewrite the binary indirectly`);
        if (found && seenBuild) {
          const ok = POST_BUILD_OK.has(cmdBase) || cmd.v.startsWith('./target/release/') || cmd.v.startsWith('target/release/') || (cmdBase === 'env' && unwrapped && /^\.?\/?target\/release\//.test(unwrapped.v));
          if (!ok) fail(`"${cmdBase}" after the build could rewrite the binary`);
          for (const r of seg.redirs) if (!(r.target === null || r.target === '/dev/null')) fail('a redirection after the build writes a file');
        }
      });
      if (afterBuildAtStart && /target|noevia-model-manager/.test(ins.args)) fail('a RUN after the build mentions the target directory or the binary');
      if (found && !afterBuild && seenBuild) afterBuild = true;
    }
  }
  if (!found) fail(`no cargo build of ${PKG} in stage ${stage.name || stage.index}`);
  return found;
}

// ---- the whole proof ---------------------------------------------------------------------------

function proveFeatures(text) {
  const all = stages(text);
  const final = all[all.length - 1];
  if (/\$/.test(final.base)) fail('the final stage has an unresolved base image');
  const chain = chainOf(all, final);
  let workdir = '/', hit = null, count = 0;
  for (const st of chain) {
    for (const ins of st.ins) {
      if (ins.kw === 'ONBUILD' || ins.kw === 'SHELL') fail(`${ins.kw} in the final stage chain`);
      if (ins.kw === 'WORKDIR') { workdir = resolveDir(workdir, ins.args.trim(), 'WORKDIR'); continue; }
      if (ins.kw === 'RUN' && /noevia-model-manager|\/usr\/local\/bin|\/usr\/local\b/.test(ins.args)) fail('a RUN in the final stage chain names the binary or its directory, so it could replace it');
      if (ins.kw !== 'COPY' && ins.kw !== 'ADD') continue;
      const c = copyOf(ins, workdir);
      if (writes(c.srcs, c.dest, BIN)) { count++; hit = { ins, c, stage: st }; }
    }
  }
  if (count === 0) fail(`the final stage never copies ${PKG} to ${BIN}`);
  if (count > 1) fail(`${count} copies or overwrites can write ${BIN}; refusing to pick one`);
  if (hit.ins.kw !== 'COPY' || hit.c.dest !== BIN || hit.c.srcs.length !== 1 || !hit.c.from) fail(`the write to ${BIN} is not a plain COPY --from=<stage> of one file to it`);
  const source = all.find((s) => s.name === hit.c.from.toLowerCase());
  if (!source) fail(`COPY --from=${hit.c.from} does not name a stage of this Dockerfile`);
  if (source.index >= hit.stage.index) fail(`COPY --from=${hit.c.from} names a stage defined later`);
  const build = proveBuild(all, source);
  if (hit.c.srcs[0] !== path.posix.join(build.workdir, 'target/release', PKG)) fail(`the copy source ${hit.c.srcs[0]} is not the release binary of the build in ${hit.c.from} (${build.workdir})`);
  const features = [];
  for (const item of build.features) {
    const m = /^([A-Za-z0-9_-]+)\/([A-Za-z0-9_-]+)$/.exec(item);
    if (!m) fail(`feature list item "${item}" is not a literal package/feature`);
    if (m[1] === PKG) features.push(m[2]);
  }
  return { features, noDefault: build.noDefault, buildStage: source.name };
}

module.exports = { proveFeatures, instructions, stages, shell, BIN };
