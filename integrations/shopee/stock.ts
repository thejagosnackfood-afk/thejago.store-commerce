/** Pure preparation step; no SQL reads or Shopee API writes happen here. */
export type SidStock = {
  sidProductCode: string;
  available: number;
  snapshotAt: string;
};

export type ShopeeMapping = {
  sidProductCode: string;
  shopId: number;
  itemId: number;
  modelId: number;
};

export type StockUpdate = {
  shopId: number;
  itemId: number;
  modelId: number;
  normalStock: number;
  sidProductCode: string;
  snapshotAt: string;
};

export type StockPlan = {
  updates: StockUpdate[];
  skipped: { sidProductCode: string; reason: string }[];
};

/** Reserve is subtracted before publishing; fail closed for invalid or ambiguous mappings. */
export function planStockUpdates(
  stocks: SidStock[],
  mappings: ShopeeMapping[],
  reserve: number = 0
): StockPlan {
  if (!Number.isSafeInteger(reserve) || reserve < 0) {
    throw new Error("Reserve must be a non-negative safe integer");
  }

  const byCode = new Map<string, ShopeeMapping[]>();
  const byTarget = new Map<string, number>();
  for (const mapping of mappings) {
    const code = mapping.sidProductCode.trim();
    const target = `${mapping.shopId}:${mapping.itemId}:${mapping.modelId}`;
    byCode.set(code, [...(byCode.get(code) ?? []), mapping]);
    byTarget.set(target, (byTarget.get(target) ?? 0) + 1);
  }

  const stockCounts = new Map<string, number>();
  for (const stock of stocks) {
    const code = stock.sidProductCode.trim();
    stockCounts.set(code, (stockCounts.get(code) ?? 0) + 1);
  }

  const updates: StockUpdate[] = [];
  const skipped: StockPlan["skipped"] = [];
  for (const stock of stocks) {
    const code = stock.sidProductCode.trim();
    const matches = byCode.get(code) ?? [];
    const mapping = matches[0];
    const target = mapping
      ? `${mapping.shopId}:${mapping.itemId}:${mapping.modelId}`
      : "";

    let reason = "";
    if (!code) reason = "Kode SID kosong";
    else if (stockCounts.get(code) !== 1) reason = "Snapshot SKU ganda";
    else if (!Number.isSafeInteger(stock.available) || stock.available < 0)
      reason = "Stok tidak valid";
    else if (!stock.snapshotAt || !Number.isFinite(Date.parse(stock.snapshotAt)))
      reason = "Waktu snapshot tidak valid";
    else if (matches.length !== 1 || !mapping) reason = "Mapping tidak unik atau belum ada";
    else if (
      ![mapping.shopId, mapping.itemId, mapping.modelId].every(
        (id) => Number.isSafeInteger(id) && id > 0
      )
    )
      reason = "ID Shopee tidak valid";
    else if (byTarget.get(target) !== 1) reason = "Target Shopee dipakai beberapa SKU";

    if (reason || !mapping) {
      skipped.push({ sidProductCode: code, reason: reason || "Mapping tidak ada" });
      continue;
    }

    updates.push({
      sidProductCode: code,
      shopId: mapping.shopId,
      itemId: mapping.itemId,
      modelId: mapping.modelId,
      normalStock: Math.max(0, stock.available - reserve),
      snapshotAt: stock.snapshotAt,
    });
  }
  return { updates, skipped };
}
