function json(status, obj) {
  return new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
}
const hasKorean = (s) => /[가-힣]/.test(s || '');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// 구글 번역 공개 엔드포인트가 짧은 순간 여러 번 호출되면 간헐적으로 429를 반환해서,
// 짧은 지연을 두고 최대 2번 재시도한다.
async function translateText(text, target, dbg) {
  if (!text) return text;
  const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${target}&dt=t&q=${encodeURIComponent(text)}`;
  for (let attempt = 0; attempt <= 2; attempt++) {
    if (attempt > 0) await sleep(300 * attempt);
    try {
      const res = await fetch(url);
      const bodyText = await res.text();
      if (dbg) dbg.push({ attempt, status: res.status, bodyPreview: bodyText.slice(0, 150) });
      if (!res.ok) continue;
      const data = JSON.parse(bodyText);
      return (data[0] || []).map(seg => seg[0]).join('') || text;
    } catch (e) {
      if (dbg) dbg.push({ attempt, error: String(e) });
    }
  }
  return text;
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

// NewsData.io - 무료 티어에서도 상업적 사용 허용, 하루 200크레딧(기사 최대 2,000건).
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

// Currents API - 무료 티어에서도 상업적 사용 허용, 하루 최대 약 250~1,000건, 소스 2만개 이상.
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

// 무료 뉴스 조회 - GNews API 키를 등록하지 않은 사용자를 위한 기본 경로.
// NewsData.io(메인) + Currents API(보조)를 병합해서 요청 횟수 허들 없이 글로벌 뉴스를 제공한다.
// 둘 다 무료 티어에서 상업적 사용이 허용되는 소스만 선정했다 (Guardian Open Platform은 무료 티어가
// 비상업적 전용이라 제외함).
export async function onRequestPost(context) {
  const { request, env } = context;
  const NEWSDATA_KEY = env.NEWSDATA_SHARED_KEY;
  const CURRENTS_KEY = env.CURRENTS_SHARED_KEY;
  if (!NEWSDATA_KEY && !CURRENTS_KEY) {
    return json(500, { error: '서버에 무료 뉴스 설정이 아직 안 되어 있습니다.' });
  }
  let body;
  try { body = await request.json(); } catch (e) { body = {}; }
  const { keyword } = body;
  if (!keyword) return json(400, { error: '검색 키워드가 없습니다.' });

  const tdbg = [];
  const query = hasKorean(keyword) ? await translateText(keyword, 'en', tdbg) : keyword;

  const [ndArticles, curArticles] = await Promise.all([
    NEWSDATA_KEY ? fetchNewsData(query, NEWSDATA_KEY) : Promise.resolve([]),
    CURRENTS_KEY ? fetchCurrents(query, CURRENTS_KEY) : Promise.resolve([])
  ]);

  if (body.debug) {
    return json(200, { originalKeyword: keyword, translatedQuery: query, ndCount: ndArticles.length, curCount: curArticles.length, translateAttempts: tdbg });
  }

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

  return json(200, {
    articles: top.map(a => ({ title: a.title, description: a.description, url: a.url, source: a.source, publishedAt: a.publishedAt, translated: !!a.translated })),
    totalArticles: merged.length
  });
}
