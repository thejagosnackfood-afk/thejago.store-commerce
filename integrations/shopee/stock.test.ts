import { strict as assert } from "node:assert";
import { test } from "node:test";
import { planStockUpdates } from "./stock";

const at = "2026-09-25T00:00:00Z";
const mapping = { sidProductCode: "ABC", shopId: 1, itemId: 2, modelId: 3 };

test("reserves stock and clamps at zero", () => {
  const result = planStockUpdates(
    [
      { sidProductCode: "ABC", available: 8, snapshotAt: at },
      { sidProductCode: "XYZ", available: 1, snapshotAt: at },
    ],
    [mapping, { sidProductCode: "XYZ", shopId: 1, itemId: 4, modelId: 5 }],
    2
  );
  assert.deepEqual(result.updates.map((row) => row.normalStock), [6, 0]);
  assert.equal(result.skipped.length, 0);
});

test("fails closed on unmapped, duplicate and invalid stock", () => {
  const result = planStockUpdates(
    [
      { sidProductCode: "ABC", available: 3, snapshotAt: at },
      { sidProductCode: "ABC", available: 4, snapshotAt: at },
      { sidProductCode: "BAD", available: -1, snapshotAt: at },
      { sidProductCode: "UNKNOWN", available: 1, snapshotAt: at },
    ],
    [mapping]
  );
  assert.equal(result.updates.length, 0);
  assert.equal(result.skipped.length, 4);
});

test("rejects two SKU mapped to the same Shopee model", () => {
  const result = planStockUpdates(
    [
      { sidProductCode: "ABC", available: 2, snapshotAt: at },
      { sidProductCode: "XYZ", available: 4, snapshotAt: at },
    ],
    [mapping, { ...mapping, sidProductCode: "XYZ" }]
  );
  assert.equal(result.updates.length, 0);
  assert.equal(result.skipped.length, 2);
});
