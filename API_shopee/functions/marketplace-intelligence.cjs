const crypto = require('node:crypto');

const SITES = new Set(['ID', 'MY', 'PH', 'VN', 'TH', 'SG', 'TW', 'BR']);
const MODES = {
  products: { tool: 'shopee_product_search_from_name', inputSchema: { type: 'object', properties: { name: { type: 'string', minLength: 1, maxLength: 180 }, site: { type: 'string', enum: ['ID', 'MY', 'PH', 'VN', 'TH', 'SG', 'TW', 'BR'] }, page: { type: 'integer', minimum: 1, maximum: 20 } }, required: ['name', 'site'], additionalProperties: false }, map: args => ({ name: args.name, site: args.site, page: args.page || 1 }) },
  keywords: { tool: 'shopee_keyword_search', inputSchema: { type: 'object', properties: { keyword: { type: 'string', minLength: 1, maxLength: 180 }, site: { type: 'string', enum: ['ID', 'MY', 'PH', 'VN', 'TH', 'SG', 'TW', 'BR'] }, page: { type: 'integer', minimum: 1, maximum: 20 } }, required: ['keyword', 'site'], additionalProperties: false }, map: args => ({ keyword: args.keyword, site: args.site, page: args.page || 1 }) },
  competitor: { tool: 'shopee_shop_request', inputSchema: { type: 'object', properties: { shop_id: { type: 'string', pattern: '^[0-9]{1,30}$' }, site: { type: 'string', enum: ['ID', 'MY', 'PH', 'VN', 'TH', 'SG', 'TW', 'BR'] } }, required: ['shop_id', 'site'], additionalProperties: false }, map: args => ({ shop_id: args.shop_id, site: args.site }) },
  trends: { tool: 'shopee_product_trend', inputSchema: { type: 'object', properties: { product_id: { type: 'string', pattern: '^[0-9]{1,30}$' }, site: { type: 'string', enum: ['ID', 'MY', 'PH', 'VN', 'TH', 'SG', 'TW', 'BR'] }, query_start: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' }, query_end: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' } }, required: ['product_id', 'site'], additionalProperties: false }, map: args => ({ product_id: args.product_id, site: args.site, ...(args.query_start ? { query_start: args.query_start } : {}), ...(args.query_end ? { query_end: args.query_end } : {}) }) },
};

const TOOL_DESCRIPTIONS = {
  products: 'Cari produk Shopee berdasarkan nama pada marketplace yang dipilih.',
  keywords: 'Cari riset kata kunci Shopee untuk marketplace yang dipilih.',
  competitor: 'Ambil intelijen toko Shopee berdasarkan ID toko.',
  trends: 'Ambil tren untuk produk Shopee berdasarkan ID produk dan rentang tanggal opsional.',
};

function problem(status, message) { const error = new Error(message); error.status = status; throw error; }

function decodeMcpResponse(raw) {
  const eventData = raw.split(/\r?\n/).find(line => line.startsWith('data:'));
  const payloadText = eventData ? eventData.slice(5).trim() : raw.trim();
  let payload;
  try { payload = JSON.parse(payloadText); } catch { problem(502, 'Sorftime mengirim respons MCP yang tidak valid.'); }
  if (payload.error) problem(502, 'Sorftime gagal memproses permintaan riset.');
  const result = payload.result;
  if (!result || result.isError) {
    const detail = result?.content?.find(item => item.type === 'text')?.text;
    problem(502, String(detail || 'Sorftime menolak permintaan riset.').slice(0, 300));
  }
  const textContent = result.content?.find(item => item.type === 'text')?.text;
  const structured = result.structuredContent;
  const value = structured ?? textContent;
  if (value === undefined || value === null || (typeof value === 'string' && !value.trim())) problem(502, 'Sorftime tidak mengembalikan data riset.');
  if (typeof value === 'string' && value.length > 150000) problem(502, 'Hasil riset terlalu besar untuk ditampilkan.');
  if (typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0) problem(502, 'Sorftime mengembalikan hasil riset kosong.');
  try { return typeof value === 'string' ? JSON.parse(value) : value; } catch { return value; }
}

async function callResearchTool(name, args = {}) {
  const mode = Object.keys(MODES).find(item => MODES[item].tool === name);
  if (!mode) problem(400, 'Tool riset tidak tersedia.');
  if (!args || typeof args !== 'object' || Array.isArray(args)) problem(400, 'Parameter tool riset tidak valid.');
  const key = String(process.env.SORFTIME_MCP_KEY || '').trim();
  if (!key) problem(503, 'Sorftime belum dikonfigurasi. Tambahkan SORFTIME_MCP_KEY pada environment server.');
  const site = String(args.site || 'ID').toUpperCase();
  if (!SITES.has(site)) problem(400, 'Marketplace Shopee tidak didukung.');
  const mapped = MODES[mode].map({ ...args, site });
  const rawQuery = mapped.name || mapped.keyword || mapped.shop_id || mapped.product_id;
  const query = String(rawQuery || '').trim();
  if (!query || query.length > 180 || /[\u0000-\u001f]/.test(query)) problem(400, 'Masukkan kata kunci, ID produk, atau ID toko yang valid.');
  const page = Number(mapped.page ?? 1);
  if (!Number.isSafeInteger(page) || page < 1 || page > 20) problem(400, 'Halaman harus bernilai 1 sampai 20.');
  const from = mapped.query_start ? String(mapped.query_start) : '';
  const to = mapped.query_end ? String(mapped.query_end) : '';
  for (const date of [from, to]) if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) problem(400, 'Tanggal tren harus berformat YYYY-MM-DD.');
  const toolArguments = MODES[mode].map({ ...args, site, page, query_start: from, query_end: to });
  const endpoint = new URL(process.env.SORFTIME_MCP_URL || 'https://mcp.sorftime.com');
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.hash) problem(503, 'Alamat layanan Sorftime harus menggunakan HTTPS yang valid.');
  endpoint.searchParams.set('key', key);
  let response;
  try {
    response = await fetch(endpoint, {
      method: 'POST', redirect: 'error', headers: { Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: crypto.randomUUID(), method: 'tools/call', params: { name: MODES[mode].tool, arguments: toolArguments } }),
      signal: AbortSignal.timeout(35000),
    });
  } catch { problem(502, 'Koneksi ke Sorftime gagal atau melewati batas waktu.'); }
  const raw = await response.text();
  if (!response.ok) problem(502, `Sorftime menolak permintaan (HTTP ${response.status}).`);
  if (raw.length > 200000) problem(502, 'Respons Sorftime melebihi batas ukuran.');
  const result = decodeMcpResponse(raw);
  return { source: 'Sorftime MCP', marketplace: `Shopee ${site}`, mode, tool: MODES[mode].tool, result, fetchedAt: Date.now() };
}

async function querySorftime(body = {}) {
  const mode = String(body.mode || '');
  if (!Object.hasOwn(MODES, mode)) problem(400, 'Jenis riset tidak valid.');
  const modeArgs = {
    products: { name: body.query }, keywords: { keyword: body.query },
    competitor: { shop_id: body.query }, trends: { product_id: body.query },
  }[mode];
  return callResearchTool(MODES[mode].tool, { ...modeArgs, site: String(body.site || 'ID').toUpperCase(), page: Number(body.page ?? 1), ...(body.from ? { query_start: String(body.from) } : {}), ...(body.to ? { query_end: String(body.to) } : {}) });
}

function listResearchTools() {
  return Object.entries(MODES).map(([mode, definition]) => ({ name: definition.tool, description: TOOL_DESCRIPTIONS[mode], inputSchema: definition.inputSchema }));
}

module.exports = { querySorftime, callResearchTool, listResearchTools };
