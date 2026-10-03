const crypto = require('node:crypto');
const { AccountingError, DAY, today, date, period, money, sum, digest, post, ref } = require('./accounting.cjs');
const fail = (status, message) => { throw new AccountingError(status, message); };
const shift = (day, offset) => new Date(Date.parse(day) + offset * DAY).toISOString().slice(0, 10);
const controlRef = ctx => ref(ctx, 'accountingState', 'control');
function sourceMoney(value, field, optional = false) {
  if (optional && value === undefined) return 0;
  try { return money(value); } catch { fail(502, `Nominal ${field} dari Shopee tidak lengkap atau tidak valid.`); }
}
function settlement(list, detail, currency) {
  if (currency !== 'IDR') fail(422, 'Pembukuan saat ini hanya menerima pesanan IDR.');
  if (list.order_sn !== detail.order_sn || !/^[A-Za-z0-9_-]{1,64}$/.test(list.order_sn || '')) fail(502, 'Identitas escrow tidak sesuai.');
  if (!Number.isSafeInteger(list.escrow_release_time) || list.escrow_release_time <= 0 || list.escrow_release_time * 1000 > Date.now() + 60000) fail(502, 'Tanggal pencairan Shopee tidak valid.');
  const income = detail.order_income;
  if (!income) fail(502, 'Rincian escrow belum tersedia.');
  const payout = sourceMoney(list.payout_amount, 'payout_amount');
  const expected = sourceMoney(income.escrow_amount_after_adjustment ?? income.escrow_amount, 'escrow_amount');
  if (payout !== expected) fail(422, 'Pencairan dan rincian escrow berbeda. Perlu rekonsiliasi sebelum dibukukan.');
  const original = sourceMoney(income.original_price, 'original_price');
  const discount = sourceMoney(income.seller_discount, 'seller_discount');
  const voucher = sourceMoney(income.voucher_from_seller, 'voucher_from_seller');
  const refund = sourceMoney(income.seller_return_refund, 'seller_return_refund');
  if ([original, discount, voucher, refund].some(n => n < 0) || discount + voucher > original) fail(422, 'Rincian harga atau diskon Shopee perlu diperiksa.');
  const sales = original - discount - voucher;
  const lines = [];
  const add = (account, signedDebit) => { if (signedDebit) lines.push({ account, debitMinor: Math.max(0, signedDebit), creditMinor: Math.max(0, -signedDebit) }); };
  add('1120', payout); add('4100', -sales); add('4190', refund);
  const feeFields = [
    ['5200', income.net_commission_fee ?? income.commission_fee, 'commission_fee', false],
    ['5210', income.net_service_fee ?? income.service_fee, 'service_fee', false],
    ['5220', income.seller_transaction_fee, 'seller_transaction_fee', false],
    ['5230', income.order_ams_commission_fee, 'order_ams_commission_fee', true],
    ['5240', income.seller_order_processing_fee, 'seller_order_processing_fee', true],
    ['5240', income.campaign_fee, 'campaign_fee', true],
  ];
  let fees = 0;
  for (const [code, value, field, optional] of feeFields) {
    const amount = sourceMoney(value, field, optional);
    if (amount < 0) fail(422, 'Potongan Shopee negatif memerlukan pemeriksaan.');
    fees = sum(fees, amount); add(code, amount);
  }
  // Shipping, taxes and other adjustments are not guessed into revenue/expenses.
  const unallocated = -lines.reduce((n, line) => sum(n, line.debitMinor - line.creditMinor), 0);
  add('1190', unallocated);
  if (lines.length < 2) fail(422, 'Escrow tanpa nilai memerlukan pemeriksaan.');
  return { id: `shopee_${digest(list.order_sn)}`, date: today(list.escrow_release_time * 1000),
    description: `Penjualan Shopee ${list.order_sn}`, reference: list.order_sn, lines,
    needsReview: unallocated !== 0, sourceMetadata: { orderSn: list.order_sn, payoutMinor: payout, salesMinor: sales, refundMinor: refund, feesMinor: fees, unallocatedMinor: unallocated, basis: 'escrow_release', currency: 'IDR' } };
}
async function collect(api, range) {
  period(range);
  const deadline = Date.now() + 90000;
  const request = async (...args) => {
    if (Date.now() > deadline) fail(422, 'Pengambilan escrow terlalu lama. Pilih periode lebih pendek.');
    return api(...args);
  };
  const list = new Map();
  for (let start = range.from; start <= range.to; start = shift(start, 7)) {
    const end = shift(start, 6) < range.to ? shift(start, 6) : range.to;
    for (let page = 1; ; page++) {
      if (page > 20) fail(422, 'Terlalu banyak pencairan. Pilih periode lebih pendek.');
      const data = await request('/payment/get_escrow_list', { release_time_from: Date.parse(`${start}T00:00:00+07:00`) / 1000,
        release_time_to: Math.min(Date.parse(`${end}T23:59:59+07:00`) / 1000, Math.floor(Date.now() / 1000)), page_size: 100, page_no: page });
      if (!Array.isArray(data.escrow_list) || typeof data.more !== 'boolean') fail(502, 'Daftar pencairan Shopee belum lengkap.');
      let added = 0;
      for (const row of data.escrow_list) {
        if (!/^[A-Za-z0-9_-]{1,64}$/.test(row.order_sn || '')) fail(502, 'ID pesanan escrow tidak valid.');
        if (list.has(row.order_sn) && JSON.stringify(list.get(row.order_sn)) !== JSON.stringify(row)) fail(502, 'Shopee mengembalikan versi pencairan berbeda untuk satu pesanan.');
        if (!list.has(row.order_sn)) { list.set(row.order_sn, row); added++; }
        if (list.size > 1000) fail(422, 'Maksimal 1.000 pencairan per proses. Pilih periode lebih pendek.');
      }
      if (!data.more) break;
      if (!added) fail(502, 'Paginasi escrow tidak maju.');
    }
  }
  const ids = [...list.keys()], results = [];
  for (let offset = 0; offset < ids.length; offset += 20) {
    const batch = ids.slice(offset, offset + 20);
    const details = await request('/payment/get_escrow_detail_batch', { order_sn_list: batch }, 'POST');
    const orders = await request('/order/get_order_detail', { order_sn_list: batch.join(',') });
    for (const rows of [details.order_income_list, orders.order_list]) {
      if (!Array.isArray(rows) || rows.length !== batch.length || new Set(rows.map(row => row.order_sn)).size !== batch.length || rows.some(row => !batch.includes(row.order_sn))) fail(502, 'Sebagian rincian pesanan belum tersedia. Sinkronisasi tidak dibukukan.');
    }
    for (const detail of details.order_income_list) {
      const row = list.get(detail.order_sn);
      try {
        const entry = settlement(row, detail, orders.order_list.find(order => order.order_sn === detail.order_sn).currency);
        if (entry.date < range.from || entry.date > range.to) fail(502, 'Tanggal escrow di luar periode yang diminta.');
        results.push({ orderSn: detail.order_sn, entry });
      } catch (error) {
        if (!(error instanceof AccountingError)) throw error;
        results.push({ orderSn: detail.order_sn, error: error.message });
      }
    }
  }
  return results;
}
async function settings(ctx, body) {
  if (typeof body.enabled !== 'boolean') fail(400, 'Status sinkronisasi tidak valid.');
  if (body.enabled) {
    date(body.startDate);
    if (body.startDate > today() || body.startDate < shift(today(), -365)) fail(400, 'Tanggal mulai harus dalam 365 hari terakhir.');
  }
  await ctx.db.runTransaction(async tx => {
    const current = (await tx.get(controlRef(ctx))).data() || {};
    tx.set(controlRef(ctx), { enabled: body.enabled, configVersion: (current.configVersion || 0) + 1,
      ...(body.enabled ? { startDate: body.startDate, nextDate: current.enabled && current.startDate === body.startDate ? current.nextDate || body.startDate : body.startDate, nextRunAt: 0 } : {}) }, { merge: true });
  });
  return { enabled: body.enabled };
}
async function sync(ctx, shopContext, range, user, automatic = false) {
  const leaseOwner = crypto.randomUUID();
  const claimed = await ctx.db.runTransaction(async tx => {
    const current = (await tx.get(controlRef(ctx))).data() || {};
    if (automatic && (!current.enabled || current.nextRunAt > Date.now())) return false;
    if (current.leaseUntil > Date.now()) fail(409, 'Sinkronisasi akuntansi masih berjalan.');
    tx.set(controlRef(ctx), { leaseOwner, leaseUntil: Date.now() + 180000, lastError: null }, { merge: true });
    return { startDate: current.startDate || null, configVersion: current.configVersion || 0 };
  });
  if (!claimed) return { skipped: true };
  const renew = async () => ctx.db.runTransaction(async tx => {
    const current = (await tx.get(controlRef(ctx))).data() || {};
    if (current.leaseOwner !== leaseOwner || (automatic && !current.enabled)) fail(409, 'Sinkronisasi dihentikan.');
    tx.set(controlRef(ctx), { leaseUntil: Date.now() + 180000 }, { merge: true });
  });
  let result, failure;
  try {
    const shopee = await shopContext();
    const records = await collect(shopee.api, range);
    result = { from: range.from, to: range.to, found: records.length, posted: 0, existing: 0, review: 0 };
    for (let index = 0; index < records.length; index++) {
      if (index % 10 === 0) await renew();
      const record = records[index];
      const reviewRef = ref(ctx, 'accountingReviews', digest(record.orderSn));
      let issue = record.error;
      if (!issue) {
        try {
          const posted = await post(ctx, record.entry, user, { ...record.entry, source: 'shopee', leaseOwner, automatic });
          result[posted.created ? 'posted' : 'existing']++;
          if (record.entry.needsReview) issue = 'Selisih escrow belum dialokasikan. Buat jurnal penyesuaian setelah memeriksa rincian Shopee.';
        } catch (error) {
          if (!(error instanceof AccountingError) || error.status !== 409 || error.message !== 'ID transaksi sudah dipakai untuk isi berbeda.') throw error;
          issue = 'Rincian Shopee berubah setelah dibukukan. Jurnal lama dipertahankan; periksa kebutuhan jurnal penyesuaian.';
        }
      }
      if (issue) {
        result.review++;
        await reviewRef.set({ orderSn: record.orderSn, message: issue, checkedAt: Date.now(), journalId: record.entry?.id || null });
      } else await reviewRef.delete();
    }
  } catch (error) {
    failure = error instanceof AccountingError ? error : new AccountingError(502, 'Sinkronisasi Shopee gagal. Jurnal yang sudah tersimpan tetap aman; coba ulang.');
  } finally {
    await ctx.db.runTransaction(async tx => {
      const current = (await tx.get(controlRef(ctx))).data() || {};
      if (current.leaseOwner !== leaseOwner) return;
      const caughtUp = range.to >= today();
      const sameConfig = !automatic || (current.configVersion || 0) === claimed.configVersion && current.startDate === claimed.startDate;
      tx.set(controlRef(ctx), { leaseUntil: 0, leaseOwner: null, lastError: failure?.message || null,
        ...(result ? { lastResult: result } : {}),
        ...(!failure ? { lastSyncAt: Date.now() } : {}),
        ...(automatic ? { nextRunAt: Date.now() + (failure || caughtUp ? 15 * 60000 : 10000),
          ...(!failure && sameConfig ? { nextDate: caughtUp ? (shift(today(), -6) < current.startDate ? current.startDate : shift(today(), -6)) : shift(range.to, 1) } : {}) } : {}) }, { merge: true });
    });
  }
  if (failure) throw failure;
  return result;
}
function startWorker(storeContext, shopContext) {
  let busy = false;
  const run = async () => {
    if (busy) return;
    busy = true;
    try {
      const ctx = storeContext();
      const current = (await controlRef(ctx).get()).data() || {};
      if (!current.enabled || current.nextRunAt > Date.now() || current.leaseUntil > Date.now()) return;
      const from = date(current.nextDate || current.startDate);
      const to = shift(from, 6) < today() ? shift(from, 6) : today();
      if (from > to) return;
      await sync(ctx, shopContext, { from, to }, { uid: 'shopee-accounting-worker' }, true);
    } catch (error) { console.error('accounting_sync_failed', error instanceof AccountingError ? error.message : 'server_unavailable'); }
    finally { busy = false; }
  };
  setTimeout(run, 10000).unref();
  const timer = setInterval(run, 30000); timer.unref();
  return () => clearInterval(timer);
}
module.exports = { settlement, collect, settings, sync, startWorker };
