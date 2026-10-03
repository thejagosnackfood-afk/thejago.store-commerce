'use strict';
const { shopContext } = require('./dashboard-api.cjs');

function jakartaDay(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jakarta', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}
function dayBounds(day) {
  const [year, month, date] = day.split('-').map(Number);
  const from = Math.floor(Date.UTC(year, month - 1, date) / 1000) - 7 * 3600;
  return { from, to: from + 86400 };
}
async function runDailyBoostRotation(getContext = shopContext) {
  const ctx = await getContext();
  const ref = ctx.shop.collection('boostRotation').doc('config');
  const config = (await ref.get()).data() || {};
  if (!config.enabled || !Array.isArray(config.itemIds) || !config.itemIds.length) return { skipped: 'disabled_or_empty' };
  const today = jakartaDay();
  if (config.lastRunDay === today) return { skipped: 'already_run', day: today };
  const yesterday = new Date(dayBounds(today).from * 1000 - 1000);
  const salesDay = jakartaDay(yesterday), { from, to } = dayBounds(salesDay);
  const sales = new Map(config.itemIds.map(id => [Number(id), 0]));
  let cursor = '', pages = 0;
  do {
    const page = await ctx.api('/order/get_order_list', { time_range_field: 'create_time', time_from: from, time_to: to - 1, page_size: 50, ...(cursor ? { cursor } : {}), response_optional_fields: 'order_status' });
    const list = page.order_list || [];
    for (let i = 0; i < list.length; i += 50) {
      const detail = await ctx.api('/order/get_order_detail', { order_sn_list: list.slice(i, i + 50).map(x => x.order_sn).join(','), response_optional_fields: 'item_list' });
      if (!Array.isArray(detail.order_list) || detail.order_list.length !== list.slice(i, i + 50).length) throw new Error('Detail pesanan harian tidak lengkap. Rotasi dibatalkan.');
      for (const order of detail.order_list) {
        if (['UNPAID', 'CANCELLED', 'IN_CANCEL', 'TO_RETURN'].includes(order.order_status)) continue;
        for (const item of order.item_list || []) {
          const id = Number(item.item_id);
          if (sales.has(id)) sales.set(id, sales.get(id) + (Number(item.model_quantity_purchased) || 0));
        }
      }
    }
    pages++;
    if (!page.more) break;
    if (!page.next_cursor || page.next_cursor === cursor || pages >= 100) throw new Error('Pagination pesanan harian tidak valid.');
    cursor = page.next_cursor;
  } while (true);

  const ranked = [...sales].sort((a, b) => b[1] - a[1] || a[0] - b[0]);
  const activeIds = [];
  for (let i = 0; i < ranked.length && activeIds.length < 5; i += 50) {
    const candidates = ranked.slice(i, i + 50).map(([id]) => id);
    const current = await ctx.api('/product/get_item_base_info', { item_id_list: candidates.join(',') });
    if (!Array.isArray(current.item_list) || current.item_list.length !== candidates.length) throw new Error('Status produk tidak lengkap. Rotasi dibatalkan.');
    const active = new Set(current.item_list.filter(item => item.item_status === 'NORMAL').map(item => Number(item.item_id)));
    activeIds.push(...candidates.filter(id => active.has(id)).slice(0, 5 - activeIds.length));
  }
  if (!activeIds.length) throw new Error('Tidak ada produk aktif yang bisa dinaikkan hari ini.');
  const result = await ctx.api('/product/boost_item', { item_id_list: activeIds }, 'POST');
  const confirmed = result.success_list?.item_id_list;
  if (!Array.isArray(confirmed) || confirmed.length !== activeIds.length || activeIds.some(id => !confirmed.includes(id)) || result.failure_list?.length) throw new Error('Shopee tidak mengonfirmasi seluruh produk pada batch rotasi. Periksa hasil sebelum mengulang.');
  const summary = { day: today, salesDay, itemIds: activeIds, selected: activeIds.map(itemId => ({ itemId, units: sales.get(itemId) || 0 })), completedAt: Date.now() };
  await ref.set({ lastRunDay: today, lastRun: summary }, { merge: true });
  await ctx.shop.collection('boostRotationRuns').doc(today).set(summary);
  return summary;
}
module.exports = { runDailyBoostRotation, jakartaDay, dayBounds };
