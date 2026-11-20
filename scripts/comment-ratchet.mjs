// fallow-ignore-file coverage-gaps -- lint 用 CLI スクリプトで単体テストを持たない。検証は lint:comments として全 lint で実行されること自体で行う
//
// コメント・ラチェット: 新しい散文コメントの混入を禁止し、残存分は
// comment-baseline.json の件数まで許容する。ベースラインは削除ラウンドの
// たびに --write で再生成して小さくしていく一方通行の歯止めであり、
// 増やす方向の再生成は「新しいコメントを書いた」ことと同義なので、
// レビューで必ず差分を確認すること。
//
// 使い方:
//   bun scripts/comment-ratchet.mjs            検査（lint:comments）
//   bun scripts/comment-ratchet.mjs --write    ベースラインを再生成する
//   bun scripts/comment-ratchet.mjs --baseline <path>  別ベースラインで検査
//
// 数えるのは「散文コメントブロック」= コメントブロックのうち Functional
// 指令（fallow-ignore 等のツール指令、import-lint の JSDoc タグ）でない
// もの。抽出とブロック化の規則はコメント監査（2026-11-21）の抽出器と同一。
import { parse } from '@babel/parser';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_BASELINE = join(REPO, 'comment-baseline.json');
const SELF = 'scripts/comment-ratchet.mjs';
const BASELINE_NAME = 'comment-baseline.json';

const args = process.argv.slice(2);
const write = args.includes('--write');
const baselinePath = (() => {
  const i = args.indexOf('--baseline');
  return i >= 0 ? args[i + 1] : DEFAULT_BASELINE;
})();

// ---- 対象ファイルの列挙 ---------------------------------------------------
const EXTS = new Set(['.ts', '.tsx', '.js', '.mjs', '.jsx', '.jsonc']);
const SKIP_DIRS = new Set(['node_modules', 'dist', 'coverage', 'module_bindings', '.git']);

function walk(dir, out) {
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    if (entry.isDirectory()) {
      // ドットディレクトリ（.cloudflare の生成物など）と生成・依存ディレクトリは対象外
      if (!SKIP_DIRS.has(entry.name) && !entry.name.startsWith('.'))
        walk(join(dir, entry.name), out);
    } else if (entry.isFile() && EXTS.has(entry.name.slice(entry.name.lastIndexOf('.')))) {
      out.push(relative(REPO, join(dir, entry.name)));
    }
  }
}

function packageFiles(packagesDir, pkg) {
  const out = [];
  for (const sub of ['src', 'test']) {
    const dir = join(packagesDir, pkg, sub);
    if (existsSync(dir)) walk(dir, out);
  }
  return out;
}

function scopeFiles() {
  const out = [];
  const packagesDir = join(REPO, 'packages');
  for (const pkg of readdirSync(packagesDir, { withFileTypes: true })) {
    if (pkg.isDirectory()) out.push(...packageFiles(packagesDir, pkg.name));
  }
  for (const dir of ['infra', 'scripts']) walk(join(REPO, dir), out);
  for (const entry of readdirSync(REPO, { withFileTypes: true })) {
    if (entry.isFile() && (entry.name.endsWith('.jsonc') || entry.name === 'vite.config.ts'))
      out.push(entry.name);
  }
  return out.filter((f) => f !== SELF && f !== BASELINE_NAME).sort((a, b) => a.localeCompare(b));
}

// ---- コメント抽出（監査の抽出器と同一規則） --------------------------------
function scanJsoncString(src, i, line) {
  i++;
  while (i < src.length && src[i] !== '"') {
    if (src[i] === '\\') i++;
    if (src[i] === '\n') line++;
    i++;
  }
  return { i: Math.min(i + 1, src.length), line };
}

function scanJsoncLineComment(src, i, line) {
  const start = i;
  while (i < src.length && src[i] !== '\n') i++;
  return { comment: { type: 'CommentLine', start, end: i, startLine: line, endLine: line }, i };
}

function scanJsoncBlockComment(src, i, line) {
  const start = i,
    startLine = line;
  i += 2;
  while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) {
    if (src[i] === '\n') line++;
    i++;
  }
  const end = Math.min(i + 2, src.length);
  return { comment: { type: 'CommentBlock', start, end, startLine, endLine: line }, i: end, line };
}

function extractJsonc(src) {
  const out = [];
  let i = 0,
    line = 1;
  while (i < src.length) {
    const ch = src[i];
    if (ch === '\n') {
      line++;
      i++;
    } else if (ch === '"') {
      ({ i, line } = scanJsoncString(src, i, line));
    } else if (ch === '/' && src[i + 1] === '/') {
      const r = scanJsoncLineComment(src, i, line);
      out.push(r.comment);
      i = r.i;
    } else if (ch === '/' && src[i + 1] === '*') {
      const r = scanJsoncBlockComment(src, i, line);
      out.push(r.comment);
      i = r.i;
      line = r.line;
    } else {
      i++;
    }
  }
  return out;
}

function rawComments(src, file) {
  if (file.endsWith('.jsonc')) {
    return extractJsonc(src).map((c) => ({
      ...c,
      startCol: c.start - (src.lastIndexOf('\n', c.start - 1) + 1),
    }));
  }
  const plugins = ['jsx'];
  if (/\.(ts|tsx)$/.test(file)) plugins.push('typescript');
  let ast;
  try {
    ast = parse(src, {
      sourceType: 'module',
      plugins,
      ranges: true,
      errorRecovery: true,
      attachComment: true,
    });
  } catch {
    ast = parse(src, {
      sourceType: 'unambiguous',
      plugins,
      ranges: true,
      errorRecovery: true,
      attachComment: true,
    });
  }
  return ast.comments.map((c) => ({
    type: c.type,
    start: c.start,
    end: c.end,
    startLine: c.loc.start.line,
    endLine: c.loc.end.line,
    startCol: c.loc.start.column,
  }));
}

function groupBlocks(raw, src) {
  const lines = src.split('\n');
  const ownLine = (c) => lines[c.startLine - 1].slice(0, c.startCol).trim() === '';
  const blocks = [];
  let cur = null;
  const flush = () => {
    if (cur) {
      blocks.push(cur);
      cur = null;
    }
  };
  for (const c of raw) {
    const isLine = c.type === 'CommentLine';
    if (isLine && ownLine(c) && cur && cur.kind === 'lineRun' && c.startLine === cur.endLine + 1) {
      cur.endLine = c.endLine;
      cur.end = c.end;
      continue;
    }
    flush();
    cur = {
      kind: isLine ? 'lineRun' : 'block',
      startLine: c.startLine,
      endLine: c.endLine,
      start: c.start,
      end: c.end,
    };
  }
  flush();
  for (const b of blocks) b.text = src.slice(b.start, b.end);
  return blocks;
}

function extractBlocks(src, file) {
  const raw = rawComments(src, file);
  raw.sort((a, b) => a.start - b.start);
  return groupBlocks(raw, src);
}

// ---- Functional 指令の判定 --------------------------------------------------
// 指令として数えるのは、コメント行の先頭（マーカーを除いた位置）に指令
// トークンが現れる場合だけ。本文中で指令名に言及しただけの散文（例:
// 「fallow-ignore header」への言及）は指令ではない。fallow の指令は
// ignore-file / ignore-next-line の2綴りだけが実在するので、
// 裸の fallow-ignore は指令として扱わない。
const DIRECTIVES = [
  'fallow-ignore-file',
  'fallow-ignore-next-line',
  'oxlint-disable',
  'oxlint-enable',
  'eslint-disable',
  'import-lint-disable',
  'oxfmt-ignore',
  'prettier-ignore',
  '@vite-ignore',
  '@ts-ignore',
  '@ts-expect-error',
  '@ts-nocheck',
  'istanbul ignore',
  'c8 ignore',
  'v8 ignore',
  '@__PURE__',
  '@__NO_SIDE_EFFECTS__',
];
const DIRECTIVE_AT_LINE_START = new RegExp(`^(?:${DIRECTIVES.join('|')})\\b`);

function contentLine(raw) {
  let s = raw.trimStart();
  if (s.startsWith('//')) return s.slice(2).trimStart();
  if (s.startsWith('/*')) s = s.slice(2);
  else if (s.startsWith('*')) s = s.slice(1);
  return s.replace(/^\*+/, '').trimStart();
}

function isFunctional(block) {
  if (block.text.split('\n').some((line) => DIRECTIVE_AT_LINE_START.test(contentLine(line))))
    return true;
  if (block.kind === 'block') {
    const inner = block.text
      .replace(/^\/\*+/, '')
      .replace(/\*+\/$/, '')
      .replace(/^\s*\*\s?/gm, '')
      .trim();
    if (/^@(public|package|private|access)\b/.test(inner)) return true;
  }
  return false;
}

function proseCount(file) {
  const src = readFileSync(join(REPO, file), 'utf8');
  return extractBlocks(src, file).filter((b) => !isFunctional(b)).length;
}

// ---- 本体 -------------------------------------------------------------------
const files = scopeFiles();
const actual = new Map();
for (const f of files) {
  const n = proseCount(f);
  if (n > 0) actual.set(f, n);
}
const actualTotal = [...actual.values()].reduce((s, n) => s + n, 0);

if (write) {
  const data = {
    version: 1,
    total: actualTotal,
    files: Object.fromEntries([...actual.entries()].sort(([a], [b]) => a.localeCompare(b))),
  };
  writeFileSync(baselinePath, JSON.stringify(data, null, 2) + '\n');
  console.log(
    `comment-ratchet: baseline を再生成した（散文コメント ${actualTotal} ブロック / ${actual.size} ファイル）: ${relative(REPO, baselinePath)}`,
  );
  process.exit(0);
}

if (!existsSync(baselinePath)) {
  console.error(`comment-ratchet: ベースラインが無い: ${baselinePath}（--write で生成する）`);
  process.exit(2);
}
const baseline = JSON.parse(readFileSync(baselinePath, 'utf8'));
const baseFiles = new Map(Object.entries(baseline.files || {}));

const violations = [];
for (const [file, n] of actual) {
  const base = baseFiles.get(file) || 0;
  if (n > base) violations.push({ file, base, actual: n });
}
if (violations.length) {
  console.error('comment-ratchet: ベースラインを超える散文コメントがあります:');
  for (const v of violations.sort((a, b) => a.file.localeCompare(b.file))) {
    console.error(
      v.base === 0
        ? `  ${v.file}: 散文コメント ${v.actual} 件（ベースラインに無いファイル）`
        : `  ${v.file}: 散文コメント ${v.actual} 件（ベースライン ${v.base} 件）`,
    );
  }
  console.error(
    '新しい散文コメントは書かず、決定の記録は ADR（docs/adr-*.md）へ。意図した削除ラウンドの後は --write でベースラインを再生成すること。',
  );
  process.exit(1);
}
console.log(
  `comment-ratchet: OK（散文コメント ${actualTotal} 件 / ベースライン ${baseline.total} 件）`,
);
