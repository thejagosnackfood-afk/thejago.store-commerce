const SITES = {
  ID: { label: 'Indonesia', domain: 'shopee.co.id' },
  MY: { label: 'Malaysia', domain: 'shopee.com.my' },
  PH: { label: 'Filipina', domain: 'shopee.ph' },
  VN: { label: 'Vietnam', domain: 'shopee.vn' },
  TH: { label: 'Thailand', domain: 'shopee.co.th' },
  SG: { label: 'Singapura', domain: 'shopee.sg' },
  TW: { label: 'Taiwan', domain: 'shopee.tw' },
  BR: { label: 'Brasil', domain: 'shopee.com.br' },
};
const MODES = new Set(['products', 'keywords', 'competitor', 'trends']);
const callsByUser = new Map();

function problem(status, message) { const error = new Error(message); error.status = status; throw error; }

function researchPrompt(mode, query, site) {
  const market = SITES[site];
  const focus = {
    products: 'Cari listing publik yang relevan dan bandingkan kisaran harga yang terlihat, positioning, fitur, ulasan yang tampak, serta celah diferensiasi.',
    keywords: 'Analisis variasi frasa pencarian, maksud pembeli, kata terkait, dan saran judul listing yang relevan. Jangan mengklaim volume pencarian jika sumber tidak menampilkan angka.',
    competitor: 'Telusuri toko/URL yang disebut jika dapat diakses publik. Ringkas jenis produk, positioning, pola harga, ulasan yang tampak, dan peluang bersaing; bedakan observasi dari inferensi.',
    trends: 'Tinjau sinyal tren publik terbaru yang tersedia untuk produk/kategori ini, tanggal sumber, pemicu permintaan, dan risiko tren jangka pendek.',
  }[mode];
  return [
    `Lakukan riset produk e-commerce untuk Shopee ${market.label} (${market.domain}) dengan topik: ${query}`,
    focus,
    'Gunakan web search sekarang. Utamakan halaman listing Shopee lokal dan sumber publik yang relevan. Sajikan ringkasan dalam bahasa Indonesia dengan bagian: Ringkasan, Temuan, Peluang dan risiko, Rekomendasi tindakan. Beri tanggal atau konteks waktu pada temuan yang berubah cepat.',
    'Jangan mengarang harga, jumlah penjualan, volume pencarian, rating, atau metrik internal marketplace. Jika data tidak tampil di sumber publik, nyatakan tidak tersedia. Tandai analisis sebagai inferensi bila bukan fakta yang dinyatakan sumber.',
    'Sertakan sitasi URL dari hasil pencarian pada kalimat terkait. Jangan mengaku memiliki akses ke data seller-center atau API privat Shopee.',
  ].join('\n\n');
}

function extractResult(response) {
  const messages = (response.output || []).filter(item => item.type === 'message');
  const textParts = [];
  const sources = new Map();
  for (const message of messages) for (const block of message.content || []) {
    if (block.type !== 'output_text' || typeof block.text !== 'string') continue;
    textParts.push(block.text);
    for (const annotation of block.annotations || []) {
      const citation = annotation.url_citation || annotation;
      if (citation.url) sources.set(citation.url, { title: citation.title || citation.url, url: citation.url });
    }
  }
  for (const item of response.output || []) if (item.type === 'web_search_call') {
    for (const source of item.action?.sources || []) if (source.url) sources.set(source.url, { title: source.title || source.url, url: source.url });
  }
  const result = textParts.join('\n\n').trim();
  if (!result) problem(502, 'OpenAI tidak mengembalikan ringkasan riset. Coba lagi.');
  return { result, sources: [...sources.values()].filter(source => { try { return new URL(source.url).protocol === 'https:'; } catch { return false; } }).slice(0, 20) };
}

async function queryOpenAIResearch(body = {}, userId = '') {
  const mode = String(body.mode || '');
  if (!MODES.has(mode)) problem(400, 'Jenis riset tidak valid.');
  const query = String(body.query || '').trim();
  if (!query || query.length > 180 || /[\u0000-\u001f]/.test(query)) problem(400, 'Masukkan topik riset dengan panjang 1 sampai 180 karakter.');
  const site = String(body.site || 'ID').toUpperCase();
  if (!Object.hasOwn(SITES, site)) problem(400, 'Marketplace tidak didukung.');
  const key = String(process.env.OPENAI_API_KEY || '').trim();
  if (!key) problem(503, 'OpenAI belum dikonfigurasi. Tambahkan OPENAI_API_KEY pada Variables service Railway shopee-api.');
  if (!userId) problem(401, 'Login dashboard diperlukan untuk menjalankan riset.');
  const now = Date.now();
  const recent = (callsByUser.get(userId) || []).filter(time => now - time < 60000);
  if (recent.length >= 6) problem(429, 'Batas riset tercapai. Maksimal 6 permintaan per akun setiap menit.');
  recent.push(now); callsByUser.set(userId, recent);
  if (callsByUser.size > 1000) for (const [id, times] of callsByUser) if (!times.some(time => now - time < 60000)) callsByUser.delete(id);
  const model = String(process.env.OPENAI_MODEL || 'gpt-5.5').trim();
  let response;
  try {
    response = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST', redirect: 'error',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model, store: false, max_output_tokens: 2200, tool_choice: 'required',
        tools: [{ type: 'web_search' }], include: ['web_search_call.action.sources'],
        input: researchPrompt(mode, query, site),
      }),
      signal: AbortSignal.timeout(50000),
    });
  } catch { problem(502, 'Koneksi OpenAI gagal atau melewati batas waktu. Coba lagi.'); }
  const raw = await response.text();
  if (raw.length > 1000000) problem(502, 'Respons OpenAI terlalu besar untuk ditampilkan.');
  let payload;
  try { payload = JSON.parse(raw); } catch { problem(502, 'OpenAI mengirim respons yang tidak valid.'); }
  if (!response.ok) {
    if (response.status === 401) problem(503, 'OPENAI_API_KEY ditolak. Periksa key pada Variables service Railway.');
    if (response.status === 429) problem(503, 'Batas penggunaan atau saldo API OpenAI tercapai. Periksa Usage dan billing di OpenAI Platform.');
    problem(502, `Permintaan riset OpenAI gagal (HTTP ${response.status}).`);
  }
  if (payload.error) problem(502, 'OpenAI gagal memproses permintaan riset.');
  const extracted = extractResult(payload);
  return { source: 'OpenAI Responses API · web search', marketplace: `Shopee ${SITES[site].label}`, mode, model, result: extracted.result, sources: extracted.sources, fetchedAt: Date.now() };
}

module.exports = { queryOpenAIResearch };
