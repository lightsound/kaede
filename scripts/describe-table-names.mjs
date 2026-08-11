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
// 対応行が無いテーブルは source_name にフォールバックせず失敗する(fail closed):
// camelCase 名を通すと EXCLUDE_TABLES の完全一致(call_config)をすり抜けて
// 秘密テーブルを artifact に書き出しかねない。ローカル実測では 25 テーブル
// すべてに対応行があるので、失敗 = describe の形が再び変わったサイン。
// どちらの形にも当てはまらない・JSON ですらない場合も、次の断絶に気づける
// よう診断付きで失敗する。

function findSection(sections, key) {
  for (const section of sections) {
    if (key in section) return section[key];
  }
  return undefined;
}

// ExplicitNames セクションから source_name → canonical_name の対応表を作る。
function canonicalNames(sections) {
  const explicit = findSection(sections, 'ExplicitNames');
  const names = new Map();
  const entries = explicit ? explicit.entries : [];
  for (const entry of entries) {
    if (entry.Table) names.set(entry.Table.source_name, entry.Table.canonical_name);
  }
  return names;
}

function failMissingCanonicalName(sourceName) {
  console.error(
    'describe-table-names: no ExplicitNames canonical_name for table ' +
      `${JSON.stringify(sourceName)}.\n` +
      '  refusing to fall back to the camelCase source_name: EXCLUDE_TABLES in\n' +
      '  backup-maincloud.sh matches exact snake_case names, so a fallback could\n' +
      '  leak a secret table into the backup artifact (fail closed).',
  );
  process.exit(1);
}

function tableNamesV10(sections) {
  const tables = findSection(sections, 'Tables');
  if (!Array.isArray(tables)) return null;
  const canonical = canonicalNames(sections);
  return tables.map((t) => {
    const name = canonical.get(t.source_name);
    if (name === undefined) failMissingCanonicalName(t.source_name);
    return name;
  });
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

function parseJson(input) {
  try {
    return JSON.parse(input);
  } catch (error) {
    console.error(
      `describe-table-names: stdin is not valid JSON (${error.message}).\n` +
        `  input head: ${JSON.stringify(input.slice(0, 300))}`,
    );
    process.exit(1);
  }
}

let input = '';
process.stdin.on('data', (chunk) => {
  input += chunk;
});
process.stdin.on('end', () => {
  const doc = parseJson(input);
  const names = tableNames(doc);
  if (names === null || !allNonEmptyStrings(names)) failUnexpectedShape(doc);
  console.log(names.join('\n'));
});
