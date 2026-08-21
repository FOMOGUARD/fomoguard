const hasKorean = (s) => /[가-힣]/.test(s || '');

async function translateText(text, target) {
  if (!text) return text;
  const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${target}&dt=t&q=${encodeURIComponent(text)}`;
  try {
    const res = await fetch(url);
    if (!res.ok) return text;
    const data = await res.json();
    return (data[0] || []).map(seg => seg[0]).join('') || text;
  } catch (e) {
    return text;
  }
}

function toIsoDate(raw, hasOffset) {
  if (!raw) return '';
  try {
    let s = raw.trim().replace(' ', 'T');
    if (hasOffset) s = s.replace(/T(\d{2}:\d{2}:\d{2}) ([+-]\d{4})$/, 'T$1$2');
    else s += 'Z';
    const d = new Date(s);
    return isNaN(d.getTime()) ? '' : d.toISOString();
  } catch (e) {
    return '';
  }
}

async function fetchNewsData(query, apiKey) {
  const url = `https://newsdata.io/api/1/latest?apikey=${encodeURIComponent(apiKey)}&q=${encodeURIComponent(query)}&language=en`;
  try {
    const res = await fetch(url);
    if (!res.ok) return [];
    const data = await res.json();
    if (!Array.isArray(data.results)) return [];
    return data.results.map(a => ({
      title: a.title || '',
      description: a.description || '',
      url: a.link || '',
      source: a.source_id || a.source_name || '',
      publishedAt: toIsoDate(a.pubDate, false)
    })).filter(a => a.title && a.url);
  } catch (e) {
    return [];
  }
}

async function fetchCurrents(query, apiKey) {
  const url = `https://api.currentsapi.services/v1/search?apiKey=${encodeURIComponent(apiKey)}&keywords=${encodeURIComponent(query)}&language=en`;
  try {
    const res = await fetch(url);
    if (!res.ok) return [];
    const data = await res.json();
    if (!Array.isArray(data.news)) return [];
    return data.news.map(a => {
      let source = a.author || '';
      if (!source && a.url) { try { source = new URL(a.url).hostname.replace(/^www\./, ''); } catch (e) {} }
      return {
        title: a.title || '',
        description: a.description || '',
        url: a.url || '',
        source,
        publishedAt: toIsoDate(a.published, true)
      };
    }).filter(a => a.title && a.url);
  } catch (e) {
    return [];
  }
}

// 무료 뉴스 조회 - NewsData.io(메인) + Currents API(보조) 병합.
exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }
  const NEWSDATA_KEY = process.env.NEWSDATA_SHARED_KEY;
  const CURRENTS_KEY = process.env.CURRENTS_SHARED_KEY;
  if (!NEWSDATA_KEY && !CURRENTS_KEY) {
    return { statusCode: 500, body: JSON.stringify({ error: '서버에 무료 뉴스 설정이 아직 안 되어 있습니다.' }) };
  }
  let body;
  try { body = JSON.parse(event.body || '{}'); } catch (e) { body = {}; }
  const { keyword } = body;
  if (!keyword) return { statusCode: 400, body: JSON.stringify({ error: '검색 키워드가 없습니다.' }) };

  const query = hasKorean(keyword) ? await translateText(keyword, 'en') : keyword;

  const [ndArticles, curArticles] = await Promise.all([
    NEWSDATA_KEY ? fetchNewsData(query, NEWSDATA_KEY) : Promise.resolve([]),
    CURRENTS_KEY ? fetchCurrents(query, CURRENTS_KEY) : Promise.resolve([])
  ]);

  const seen = new Set();
  const merged = [];
  for (const a of [...ndArticles, ...curArticles]) {
    if (!a.url || seen.has(a.url)) continue;
    seen.add(a.url);
    merged.push(a);
  }
  merged.sort((a, b) => Date.parse(b.publishedAt || 0) - Date.parse(a.publishedAt || 0));
  const top = merged.slice(0, 15);

  await Promise.all(top.map(async a => {
    if (!hasKorean(a.title)) {
      a.title = await translateText(a.title, 'ko');
      a.description = a.description ? await translateText(a.description, 'ko') : '';
      a.translated = true;
    }
  }));

  return {
    statusCode: 200,
    body: JSON.stringify({
      articles: top.map(a => ({ title: a.title, description: a.description, url: a.url, source: a.source, publishedAt: a.publishedAt, translated: !!a.translated })),
      totalArticles: merged.length
    })
  };
};
