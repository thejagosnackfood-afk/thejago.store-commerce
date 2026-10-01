const fs = require('node:fs');
const path = require('node:path');
class ProductError extends Error { constructor(message, status = 400) { super(message); this.status = status; } }
function text(value, label, max, required = true) {
  if (typeof value !== 'string' || (required && !value.trim()) || value.trim().length > max) throw new ProductError(`${label} wajib berupa teks, maksimal ${max} karakter.`);
  return value.trim();
}
function positive(value, label, integer = true) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || (integer && !Number.isSafeInteger(value))) throw new ProductError(`${label} harus angka positif.`);
  return value;
}
function editPayload(body) {
  return { item_id: positive(body.itemId, 'ID produk'), item_name: text(body.name, 'Judul', 120), item_sku: text(body.sku, 'SKU', 100) };
}
function createPayload(body) {
  const result = { item_name: text(body.name, 'Judul', 120), item_sku: text(body.sku, 'SKU', 100), description: text(body.description, 'Deskripsi', 5000), category_id: positive(body.categoryId, 'Kategori'), original_price: positive(body.price, 'Harga', false), weight: positive(body.weight, 'Berat', false), item_status: 'UNLIST', condition: 'NEW' };
  if (!Number.isSafeInteger(body.stock) || body.stock < 0) throw new ProductError('Stok harus bilangan bulat non-negatif.');
  result.seller_stock = [{ stock: body.stock }];
  if (!Array.isArray(body.imageIds) || body.imageIds.length < 1 || body.imageIds.length > 9) throw new ProductError('Isi 1 sampai 9 ID gambar Shopee.');
  result.image = { image_id_list: body.imageIds.map(id => text(id, 'ID gambar', 200)) };
  result.logistic_info = [{ logistic_id: positive(body.logisticId, 'ID logistik'), enabled: true }];
  if (body.attributeList !== undefined) {
    if (!Array.isArray(body.attributeList)) throw new ProductError('Atribut harus berupa array JSON.');
    result.attribute_list = body.attributeList;
  }
  if (body.brandId !== undefined) result.brand = { brand_id: positive(body.brandId, 'ID merek'), original_brand_name: text(body.brandName, 'Merek', 100) };
  return result;
}
function checked(result) {
  if (!result || result.error || !result.response) throw new ProductError(result?.message || result?.error || 'Respons Shopee tidak valid.', 502);
  return result;
}
async function writeProduct({ body, action, sdk }) {
  if (action === 'create') {
    const payload = createPayload(body);
    const result = checked(await sdk.product.addItem(payload));
    if (!Number.isSafeInteger(result.response.item_id) || result.response.item_id <= 0) throw new ProductError('Shopee tidak mengembalikan ID produk baru.', 502);
    return { ok: true, itemId: result.response.item_id, status: 'UNLIST', warning: result.warning || result.response.warning || null };
  }
  const payload = editPayload(body);
  const current = checked(await sdk.product.getItemBaseInfo({ item_id_list: [payload.item_id] })).response.item_list?.[0];
  if (!current || current.item_id !== payload.item_id) throw new ProductError('Produk tidak ditemukan di toko ini.', 404);
  // Item SKU differs from variant model SKU; never silently overwrite variants.
  if (current.has_model) throw new ProductError('Produk bervariasi: SKU varian belum didukung. Pilih produk tanpa variasi.', 409);
  if (!body.before || body.before.name !== current.item_name || body.before.sku !== (current.item_sku || '')) throw new ProductError('Produk berubah sejak dibuka. Muat ulang sebelum menyimpan.', 409);
  checked(await sdk.product.updateItem(payload));
  const verified = checked(await sdk.product.getItemBaseInfo({ item_id_list: [payload.item_id] })).response.item_list?.[0];
  if (verified?.item_name !== payload.item_name || verified?.item_sku !== payload.item_sku) throw new ProductError('Permintaan dikirim, tetapi hasil belum terverifikasi. Muat ulang produk sebelum mencoba lagi.', 502);
  return { ok: true, itemId: payload.item_id, updated: { name: verified.item_name, sku: verified.item_sku } };
}
// Candidate ranking only. No fuzzy result is ever applied automatically.
function matchMaster(product, masters) {
  const normalize = value => String(value || '').toLowerCase().normalize('NFKC').replace(/(\d+(?:\.\d+)?)\s*(kg|kilogram)\b/g, (_, n) => `${Number(n) * 1000}g`).replace(/(\d+)\s*(gram|gr|g)\b/g, '$1g').replace(/(\d+(?:\.\d+)?)\s*(liter|ltr|l)\b/g, (_, n) => `${Number(n) * 1000}ml`).replace(/(\d+)\s*ml\b/g, '$1ml').replace(/[^\p{L}\p{N}.]+/gu, ' ').trim();
  const tokens = value => new Set(normalize(value).split(' ').filter(Boolean));
  const quantities = value => [...normalize(value).matchAll(/\b\d+(?:\.\d+)?(?:g|ml)\b|\bisi\s+\d+\b/g)].map(m => m[0]).sort().join('|');
  const a = tokens(product.name);
  return masters.map(master => {
    const exact = Boolean(product.sku) && product.sku.trim() === master.sku.trim();
    const b = tokens(master.name);
    const overlap = [...a].filter(t => b.has(t)).length;
    const score = exact ? 100 : Math.round(200 * overlap / Math.max(1, a.size + b.size));
    const conflict = Boolean(quantities(product.name) && quantities(master.name) && quantities(product.name) !== quantities(master.name));
    return { ...master, score, conflict, method: exact ? 'SKU persis' : 'Kemiripan judul' };
  }).sort((a, b) => Number(a.conflict) - Number(b.conflict) || b.score - a.score).slice(0, 5);
}
function renderProductModule(renderPage, res) {
  const html = fs.readFileSync(path.join(__dirname, 'product-module.html'), 'utf8');
  return renderPage(res, 200, 'Modul Produk Shopee', html.replace('/* MATCH_MASTER */', `const matchMaster = ${matchMaster.toString()};`));
}
module.exports = { ProductError, editPayload, createPayload, writeProduct, matchMaster, renderProductModule };
