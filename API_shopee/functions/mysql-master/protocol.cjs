const PAGE_SIZE = 100;
function pageNumber(value = '0') {
  if (!/^\d{1,6}$/.test(String(value))) throw new Error('Halaman tidak valid.');
  return Number(value);
}
function normalizeRows(rows) {
  if (!Array.isArray(rows) || rows.length > PAGE_SIZE) throw new Error('Data produk tidak valid.');
  const seen = new Set();
  return rows.map(row => {
    if (!row || typeof row.sku !== 'string' || !row.sku.trim() || row.sku.length > 200 ||
        typeof row.name !== 'string' || !row.name.trim() || row.name.length > 1000 || seen.has(row.sku)) throw new Error('SKU/nama tidak valid atau SKU ganda.');
    seen.add(row.sku);
    // Keep DECIMAL prices as strings to avoid rounding money during transport.
    const price = String(row.price ?? '');
    const stockText = String(row.stock ?? '');
    if (!/^\d{1,15}(\.\d{1,6})?$/.test(price) || !/^-?\d{1,15}(\.\d{1,6})?$/.test(stockText)) throw new Error('Harga/stok tidak valid.');
    // Source quantities can be fractional or negative. Preserve decimal text;
    // these are display-only values, never input to the Shopee stock worker.
    return { sku: row.sku, name: row.name, price, stock: typeof row.stock === 'number' && Number.isSafeInteger(row.stock) ? row.stock : stockText };
  });
}
module.exports = { PAGE_SIZE, pageNumber, normalizeRows };
