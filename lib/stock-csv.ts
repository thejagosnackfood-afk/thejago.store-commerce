export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      if (quoted && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else quoted = !quoted;
    } else if (c === "," && !quoted) {
      row.push(cell);
      cell = "";
    } else if ((c === "\n" || c === "\r") && !quoted) {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      if (row.some(Boolean)) rows.push(row);
      row = [];
      cell = "";
    } else cell += c;
  }
  if (quoted) throw new Error("Tanda kutip CSV tidak lengkap.");
  row.push(cell);
  if (row.some(Boolean)) rows.push(row);
  return rows;
}
export function readStockChanges(
  text: string,
  knownSkus: Set<string>,
): Map<string, number> {
  const rows = parseCsv(text.replace(/^\uFEFF/, ""));
  const header = rows.shift() || [];
  const skuIndex = header.indexOf("Master SKU");
  const stockIndex = header.indexOf("Stok");
  if (skuIndex < 0 || stockIndex < 0)
    throw new Error(
      "Kolom Master SKU dan Stok wajib tersedia. Gunakan file hasil Ekspor Stok.",
    );
  const changes = new Map<string, number>();
  for (const [i, row] of rows.entries()) {
    const sku = row[skuIndex] || "";
    const raw = row[stockIndex]?.trim();
    if (!knownSkus.has(sku))
      throw new Error(`SKU pada baris ${i + 2} tidak ditemukan.`);
    if (!raw || !/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw)))
      throw new Error(
        `Stok pada baris ${i + 2} harus bilangan bulat positif atau nol.`,
      );
    if (changes.has(sku)) throw new Error(`SKU ganda pada baris ${i + 2}.`);
    changes.set(sku, Number(raw));
  }
  if (!changes.size) throw new Error("File CSV tidak berisi data.");
  return changes;
}
export function stockCsv(
  rows: { name: string; variant: string; sku: string; stock: number }[],
) {
  const escape = (v: unknown) => `"${String(v).replaceAll('"', '""')}"`;
  return (
    "\uFEFF" +
    [
      ["Nama Produk", "Nama Variasi", "Master SKU", "Stok"],
      ...rows.map((p) => [p.name, p.variant, p.sku, p.stock]),
    ]
      .map((row) => row.map(escape).join(","))
      .join("\r\n")
  );
}
