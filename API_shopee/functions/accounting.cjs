const crypto = require('node:crypto');
const DAY = 86400000;
const TYPES = ['asset', 'liability', 'equity', 'income', 'expense'];
const DEFAULT_ACCOUNTS = require('./accounting-accounts.json');
class AccountingError extends Error { constructor(status, message) { super(message); this.status = status; } }
function fail(status, message) { throw new AccountingError(status, message); }
const today = (now = Date.now()) => new Date(now + 7 * 3600000).toISOString().slice(0, 10);
function date(value) {
  if (typeof value !== 'string' || !/^20\d{2}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(`${value}T00:00:00Z`)) || new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) fail(400, 'Tanggal tidak valid.');
  return value;
}
function period(query, now = Date.now()) {
  const from = date(query.from), to = date(query.to);
  if (from > to || to > today(now) || Date.parse(to) - Date.parse(from) >= 31 * DAY) fail(400, 'Pilih periode 1-31 hari sampai hari ini (WIB).');
  return { from, to };
}
function text(value, label, max = 240) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\x00-\x1f]/.test(value)) fail(400, `${label} tidak valid.`);
  return value.trim();
}
function sum(a, b) {
  const n = a + b;
  if (!Number.isSafeInteger(n)) fail(422, 'Nominal melampaui batas perhitungan.');
  return n;
}
function money(value) {
  if (!['number', 'string'].includes(typeof value) || !/^-?\d{1,12}(\.\d{1,2})?$/.test(String(value))) fail(400, 'Nominal harus berupa rupiah dengan maksimal dua desimal.');
  const negative = String(value).startsWith('-');
  const [whole, fraction = ''] = String(value).replace('-', '').split('.');
  return (negative ? -1 : 1) * (Number(whole) * 100 + Number(fraction.padEnd(2, '0')));
}
function validateJournal(raw, accounts) {
  if (!raw || typeof raw !== 'object') fail(400, 'Jurnal tidak valid.');
  const day = date(raw.date);
  if (day > today()) fail(400, 'Tanggal jurnal tidak boleh melewati hari ini (WIB).');
  const description = text(raw.description, 'Keterangan');
  const reference = raw.reference ? text(raw.reference, 'Referensi', 100) : '';
  if (!Array.isArray(raw.lines) || raw.lines.length < 2 || raw.lines.length > 30) fail(400, 'Jurnal memerlukan 2-30 baris.');
  let debit = 0, credit = 0;
  const lines = raw.lines.map(line => {
    if (!line || typeof line !== 'object' || typeof line.account !== 'string') fail(400, 'Baris jurnal tidak valid.');
    const account = accounts.find(a => a.code === line.account);
    if (!account) fail(400, 'Akun jurnal tidak ditemukan.');
    for (const value of [line.debitMinor, line.creditMinor]) if (!Number.isSafeInteger(value) || value < 0 || value > 1e14) fail(400, 'Nominal jurnal tidak valid.');
    if ((line.debitMinor > 0) === (line.creditMinor > 0)) fail(400, 'Setiap baris harus memiliki salah satu debit atau kredit.');
    debit = sum(debit, line.debitMinor); credit = sum(credit, line.creditMinor);
    return { account: account.code, debitMinor: line.debitMinor, creditMinor: line.creditMinor };
  });
  if (!debit || debit !== credit) fail(400, 'Total debit dan kredit harus sama dan lebih dari nol.');
  return { date: day, description, reference, lines, totalMinor: debit };
}
const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const ref = (ctx, collection, id) => ctx.shop.collection(collection).doc(id);
async function accounts(ctx) {
  const docs = await ctx.shop.collection('accountingAccounts').get();
  return [...DEFAULT_ACCOUNTS, ...docs.docs.map(doc => doc.data())].sort((a, b) => a.code.localeCompare(b.code));
}
async function post(ctx, raw, user, options = {}) {
  const allAccounts = await accounts(ctx);
  const journal = validateJournal(raw, allAccounts);
  const id = options.id || `manual_${text(raw.operationId, 'ID operasi', 36)}`;
  if (!/^(manual_[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}|shopee_[a-f0-9]{64}|reversal_[a-f0-9]{64})$/.test(id)) fail(400, 'ID jurnal tidak valid.');
  const source = options.source || 'manual';
  const fingerprint = digest({ ...journal, source, reversalOf: options.reversalOf || null });
  return ctx.db.runTransaction(async tx => {
    const entryRef = ref(ctx, 'accountingJournals', id);
    const existing = (await tx.get(entryRef)).data();
    if (existing) {
      if (existing.fingerprint !== fingerprint) fail(409, 'ID transaksi sudah dipakai untuk isi berbeda.');
      return { journal: existing, created: false };
    }
    const controlRef = ref(ctx, 'accountingState', 'control');
    const dailyRef = ref(ctx, 'accountingDaily', journal.date);
    const control = (await tx.get(controlRef)).data() || {};
    if (options.leaseOwner && (control.leaseOwner !== options.leaseOwner || control.leaseUntil <= Date.now() || (options.automatic && control.enabled !== true))) fail(409, 'Sinkronisasi berhenti atau kunci proses kedaluwarsa.');
    const daily = (await tx.get(dailyRef)).data() || { date: journal.date, balances: {} };
    let original;
    if (options.reversalOf) {
      original = (await tx.get(ref(ctx, 'accountingJournals', options.reversalOf))).data();
      if (!original || original.reversedBy || original.reversalOf) fail(409, 'Jurnal tidak tersedia atau sudah dibalik.');
      if (journal.date < original.date) fail(400, 'Tanggal pembalik tidak boleh sebelum jurnal asal.');
    }
    const sequence = sum(control.journalSequence || 0, 1);
    const entry = { ...journal, id, number: `JRN-${String(sequence).padStart(6, '0')}`, source, fingerprint,
      createdAt: Date.now(), createdBy: user.uid, reversalOf: options.reversalOf || null, reversedBy: null,
      needsReview: options.needsReview === true, sourceMetadata: options.sourceMetadata || null };
    for (const line of journal.lines) {
      const balance = daily.balances[line.account] || { debitMinor: 0, creditMinor: 0 };
      daily.balances[line.account] = { debitMinor: sum(balance.debitMinor, line.debitMinor), creditMinor: sum(balance.creditMinor, line.creditMinor) };
    }
    tx.set(entryRef, entry); tx.set(dailyRef, daily); tx.set(controlRef, { journalSequence: sequence }, { merge: true });
    if (original) tx.set(ref(ctx, 'accountingJournals', original.id), { reversedBy: id }, { merge: true });
    return { journal: entry, created: true };
  });
}
async function reverse(ctx, body, user) {
  const id = text(body.id, 'ID jurnal', 100);
  if (!/^(manual_[a-f0-9-]{36}|shopee_[a-f0-9]{64})$/.test(id)) fail(400, 'Jurnal ini tidak dapat dibalik.');
  const original = (await ref(ctx, 'accountingJournals', id).get()).data();
  if (!original) fail(404, 'Jurnal tidak ditemukan.');
  const reason = text(body.reason, 'Alasan pembalik', 160);
  return post(ctx, { date: body.date, description: `Pembalik ${original.number}: ${reason}`, reference: original.number,
    lines: original.lines.map(line => ({ account: line.account, debitMinor: line.creditMinor, creditMinor: line.debitMinor })) }, user,
  { id: `reversal_${digest(id)}`, source: 'reversal', reversalOf: id });
}
function aggregate(allAccounts, days, journals, range) {
  const balances = new Map(allAccounts.map(a => [a.code, { ...a, openingMinor: 0, debitMinor: 0, creditMinor: 0, balanceMinor: 0 }]));
  for (const day of days) for (const [code, value] of Object.entries(day.balances)) {
    const row = balances.get(code);
    if (!row) fail(500, 'Akun laporan tidak ditemukan.');
    const net = sum(value.debitMinor, -value.creditMinor);
    row.balanceMinor = sum(row.balanceMinor, net);
    if (day.date < range.from) row.openingMinor = sum(row.openingMinor, net);
    else { row.debitMinor = sum(row.debitMinor, value.debitMinor); row.creditMinor = sum(row.creditMinor, value.creditMinor); }
  }
  const rows = [...balances.values()];
  const group = (type, periodOnly = false) => rows.filter(r => r.type === type).reduce((n, r) => sum(n, periodOnly ? r.debitMinor - r.creditMinor : r.balanceMinor), 0);
  const incomeMinor = -group('income', true), expenseMinor = group('expense', true);
  const retainedMinor = sum(-group('income'), -group('expense'));
  const assetsMinor = group('asset'), liabilitiesMinor = -group('liability'), equityMinor = -group('equity');
  return { period: range, currency: 'IDR', accounts: rows, journals,
    totals: { incomeMinor, expenseMinor, profitMinor: sum(incomeMinor, -expenseMinor), assetsMinor, liabilitiesMinor, equityMinor, retainedMinor,
      balanceDifferenceMinor: sum(sum(assetsMinor, -liabilitiesMinor), sum(-equityMinor, -retainedMinor)),
      suspenseMinor: balances.get('1190').balanceMinor, shopeeMinor: balances.get('1120').balanceMinor } };
}
async function report(ctx, query) {
  const range = period(query), allAccounts = await accounts(ctx);
  const result = await ctx.db.runTransaction(async tx => {
    const days = await tx.get(ctx.shop.collection('accountingDaily').where('date', '<=', range.to).orderBy('date').limit(20001));
    const entries = await tx.get(ctx.shop.collection('accountingJournals').where('date', '>=', range.from).where('date', '<=', range.to).orderBy('date', 'desc').limit(2001));
    if (days.docs.length > 20000 || entries.docs.length > 2000) fail(422, 'Periode terlalu besar. Pilih rentang tanggal lebih pendek.');
    const control = (await tx.get(ref(ctx, 'accountingState', 'control'))).data() || {};
    return { days: days.docs.map(d => d.data()), journals: entries.docs.map(d => d.data()), control };
  });
  const reviews = await ctx.shop.collection('accountingReviews').limit(101).get();
  const { enabled = false, startDate = null, nextDate = null, lastSyncAt = null, lastError = null, lastResult = null, leaseUntil = 0 } = result.control;
  return { ...aggregate(allAccounts, result.days, result.journals, range),
    sync: { enabled, startDate, nextDate, lastSyncAt, lastError, lastResult, running: leaseUntil > Date.now() },
    reviews: reviews.docs.slice(0, 100).map(doc => ({ id: doc.id, ...doc.data() })), moreReviews: reviews.docs.length > 100 };
}
async function createAccount(ctx, body) {
  if (typeof body.code !== 'string' || !/^[1-5]\d{3}$/.test(body.code) || !TYPES.includes(body.type)) fail(400, 'Kode akun harus empat digit (1-5xxx) dan jenis akun valid.');
  if (Number(body.code[0]) !== TYPES.indexOf(body.type) + 1) fail(400, 'Digit pertama kode harus sesuai jenis: 1 aset, 2 liabilitas, 3 ekuitas, 4 pendapatan, 5 beban.');
  const account = { code: body.code, name: text(body.name, 'Nama akun', 100), type: body.type };
  if (DEFAULT_ACCOUNTS.some(a => a.code === account.code)) fail(409, 'Kode akun sudah digunakan.');
  await ctx.db.runTransaction(async tx => {
    const accountRef = ref(ctx, 'accountingAccounts', account.code);
    if ((await tx.get(accountRef)).exists) fail(409, 'Kode akun sudah digunakan.');
    tx.set(accountRef, account);
  });
  return { account };
}
async function route(ctx, req, path, user, deps) {
  if (req.method === 'GET' && path === '/accounting/report') return report(ctx, req.query || {});
  if (req.method !== 'POST') fail(405, 'Metode tidak didukung.');
  const body = req.body || {};
  if (path === '/accounting/accounts') return createAccount(ctx, body);
  if (path === '/accounting/journals') return post(ctx, body, user);
  if (path === '/accounting/reverse') return reverse(ctx, body, user);
  const shopee = require('./accounting-shopee.cjs');
  if (path === '/accounting/sync/settings') return shopee.settings(ctx, body);
  if (path === '/accounting/sync') { const range = period(body); return shopee.sync(ctx, deps.shopContext, range, user); }
  fail(404, 'Endpoint akuntansi tidak ditemukan.');
}
module.exports = { AccountingError, DEFAULT_ACCOUNTS, DAY, today, date, period, money, sum, digest, post, reverse, accounts, report, aggregate, route, ref };
