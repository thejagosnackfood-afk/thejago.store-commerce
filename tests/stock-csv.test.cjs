const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const ts = require("typescript");
const compiled = ts.transpileModule(
  fs.readFileSync("lib/stock-csv.ts", "utf8"),
  {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2021,
    },
  },
).outputText;
const result = { exports: {} };
new Function("exports", "module", compiled)(result.exports, result);
const { parseCsv, stockCsv, readStockChanges } = result.exports;

test("CSV export/import preserves quoted names, commas, newlines, and zero stock", () => {
  const products = [
    {
      name: 'Produk, "uji"\nBaris kedua',
      variant: "Pedas",
      sku: "ABC",
      stock: 0,
    },
  ];
  const csv = stockCsv(products);
  assert.equal(parseCsv(csv)[1][0], products[0].name);
  assert.equal(readStockChanges(csv, new Set(["ABC"])).get("ABC"), 0);
});

test("CSV imports reject malformed or ambiguous stock changes before applying them", () => {
  const invalid = [
    "Master SKU,Stok\nABC,-1",
    "Master SKU,Stok\nABC,1.5",
    "Master SKU,Stok\nABC,",
    "Master SKU,Stok\nUNKNOWN,3",
    "Master SKU,Stok\nABC,2\nABC,3",
    "Nama,Stok\nABC,2",
    'Master SKU,Stok\n"ABC,2',
    "Master SKU,Stok",
    "Master SKU,Stok\nABC,999999999999999999999",
  ];
  for (const csv of invalid)
    assert.throws(() => readStockChanges(csv, new Set(["ABC"])));
});
