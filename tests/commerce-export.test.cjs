const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const ts = require('typescript');
const moduleResult = { exports: {} };
const code = ts.transpileModule(fs.readFileSync('lib/commerce-export.ts', 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 } }).outputText;
new Function('exports', 'module', code)(moduleResult.exports, moduleResult);
const { csvCell } = moduleResult.exports;
test('product CSV escapes commas, quotes and line breaks while preserving zero stock', () => {
  assert.equal(csvCell('Keripik, "Pedas"\n250g'), '"Keripik, ""Pedas""\n250g"');
  assert.equal(csvCell(0), '"0"');
  assert.equal(csvCell(null), '""');
});
test('product and SKU text cannot become spreadsheet formulas', () => {
  for (const value of ['=HYPERLINK("url")', '+SUM(1,1)', '-cmd', '@SUM(1)', '\t=1+1']) assert.ok(csvCell(value).startsWith('"\''));
});
