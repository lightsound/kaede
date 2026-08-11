// fallow-ignore-file unused-file -- backup-maincloud.sh が node で直接実行する補助スクリプト。モジュールグラフからは到達しない
// `spacetime describe <db> --json` の出力からテーブル名を 1 行 1 件で出力する。
// backup-maincloud.sh のテーブル一覧取得部。単体で使う場合:
//   spacetime describe kaede --server maincloud --no-config --json \
//     | node scripts/describe-table-names.mjs
//
// describe は UNSTABLE コマンドで、CLI 2.8.0 で JSON の形が変わった
// (2026-08-11 実測。旧形式は 2026-08-04 実測):
//   - v9 (CLI ≤ 2.7.x): { tables: [{ name: "space_member", … }, …] }
//   - v10 (CLI 2.8.0):  { sections: [{ Tables: [{ source_name: "spaceMember", … }] },
//                                    { ExplicitNames: { entries: [{ Table: {
//                                        source_name, canonical_name } }] } }, …] }
// SQL・除外リスト(EXCLUDE_TABLES)・出力ファイル名・docs/backup-restore.md は
// すべて snake_case の canonical 名で揃えているため、v10 では ExplicitNames の
// canonical_name を引く(source_name は TS の camelCase フィールド名)。
// どちらの形にも当てはまらなければ、次の断絶に気づけるよう診断付きで失敗する。

function findSection(sections, key) {
  for (const section of sections) {
    if (key in section) return section[key];
  }
  return undefined;
}

// ExplicitNames セクションから source_name → canonical_name の対応表を作る。
// ローカル実測ではテーブル 25 件すべてに対応行があった。無いテーブルは
// 呼び出し側で source_name にフォールバックする。
function canonicalNames(sections) {
  const explicit = findSection(sections, 'ExplicitNames');
  const names = new Map();
  const entries = explicit ? explicit.entries : [];
  for (const entry of entries) {
    if (entry.Table) names.set(entry.Table.source_name, entry.Table.canonical_name);
  }
  return names;
}

function tableNamesV10(sections) {
  const tables = findSection(sections, 'Tables');
  if (!Array.isArray(tables)) return null;
  const canonical = canonicalNames(sections);
  return tables.map((t) => canonical.get(t.source_name) ?? t.source_name);
}

function tableNames(doc) {
  const root = Object(doc);
  if (Array.isArray(root.tables)) return root.tables.map((t) => t.name);
  if (Array.isArray(root.sections)) return tableNamesV10(root.sections);
  return null;
}

function allNonEmptyStrings(names) {
  return names.every((name) => typeof name === 'string' && name !== '');
}

function failUnexpectedShape(doc) {
  const root = Object(doc);
  console.error(
    'describe-table-names: unexpected describe JSON shape.\n' +
      `  root keys: ${JSON.stringify(Object.keys(root))}\n` +
      `  typeof tables: ${typeof root.tables}\n` +
      '  see the shape notes at the top of scripts/describe-table-names.mjs',
  );
  process.exit(1);
}

let input = '';
process.stdin.on('data', (chunk) => {
  input += chunk;
});
process.stdin.on('end', () => {
  const doc = JSON.parse(input);
  const names = tableNames(doc);
  if (names === null || !allNonEmptyStrings(names)) failUnexpectedShape(doc);
  console.log(names.join('\n'));
});
