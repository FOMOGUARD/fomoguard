function json(status, obj) {
  return new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
}
const hasKorean = (s) => /[가-힣]/.test(s || '');

// 구글 번역 공개 엔드포인트(translate.googleapis.com)는 클라우드 IP에서 오는 요청을
// 누적 사용량 기준으로 막아버리는 경우가 있어(실측: "Sorry..." 봇 차단 페이지, 429),
// 이미 안정적으로 쓰고 있는 정식 키 기반 Gemini API로 번역을 대체한다.
// 기사 여러 건을 한 번에 배치 번역해서 호출 횟수도 최소화한다.
async function translateBatchWithGemini(items, targetLang, geminiKey) {
  if (!geminiKey || !items.length) return items;
  const nonEmpty = items.some(t => (t || '').trim());
  if (!nonEmpty) return items;
  const targetLabel = targetLang === 'ko' ? '자연스러운 한국어' : '영어';
  const prompt = `아래는 번호가 매겨진 텍스트 목록입니다. 각 줄을 ${targetLabel}로 번역해서, 반드시 같은 줄 수만큼 "번호: 번역문" 형식으로만 답하세요. 다른 설명은 절대 붙이지 마세요. 원문이 비어있으면 그 번호는 생략하세요.\n\n${items.map((t, i) => `${i + 1}: ${(t || '').replace(/\n/g, ' ').slice(0, 500)}`).join('\n')}`;
  try {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent?key=${encodeURIComponent(geminiKey)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig: { maxOutputTokens: 4000 } })
    });
    if (!res.ok) return items;
    const data = await res.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    if (!text) return items;
    const result = items.slice();
    for (const line of text.split('\n')) {
      const m = line.match(/^\s*(\d+)\s*[:.]\s*(.+)$/);
      if (!m) continue;
      const idx = parseInt(m[1], 10) - 1;
      if (idx >= 0 && idx < result.length && m[2].trim()) result[idx] = m[2].trim();
    }
    return result;
  } catch (e) {
    return items;
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

// NewsData.io - 무료 티어에서도 상업적 사용 허용, 하루 200크레딧(기사 최대 2,000건).
async function fetchNewsData(query, apiKey, debugInfo) {
  const url = `https://newsdata.io/api/1/latest?apikey=${encodeURIComponent(apiKey)}&q=${encodeURIComponent(query)}&language=en`;
  try {
    const res = await fetch(url);
    const raw = await res.text();
    if (debugInfo) debugInfo.newsdata = { status: res.status, body: raw.slice(0, 500) };
    if (!res.ok) return [];
    const data = JSON.parse(raw);
    if (!Array.isArray(data.results)) return [];
    return data.results.map(a => ({
      title: a.title || '',
      description: a.description || '',
      url: a.link || '',
      source: a.source_id || a.source_name || '',
      publishedAt: toIsoDate(a.pubDate, false)
    })).filter(a => a.title && a.url);
  } catch (e) {
    if (debugInfo) debugInfo.newsdata = { error: String(e) };
    return [];
  }
}

// Currents API - 무료 티어에서도 상업적 사용 허용, 하루 최대 약 250~1,000건, 소스 2만개 이상.
async function fetchCurrents(query, apiKey, debugInfo) {
  const url = `https://api.currentsapi.services/v1/search?apiKey=${encodeURIComponent(apiKey)}&keywords=${encodeURIComponent(query)}&language=en`;
  try {
    const res = await fetch(url);
    const raw = await res.text();
    if (debugInfo) debugInfo.currents = { status: res.status, body: raw.slice(0, 500) };
    if (!res.ok) return [];
    const data = JSON.parse(raw);
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
    if (debugInfo) debugInfo.currents = { error: String(e) };
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
  const GEMINI_KEY = env.GEMINI_SHARED_KEY;
  if (!NEWSDATA_KEY && !CURRENTS_KEY) {
    return json(500, { error: '서버에 무료 뉴스 설정이 아직 안 되어 있습니다.' });
  }
  let body;
  try { body = await request.json(); } catch (e) { body = {}; }
  const { keyword, debug } = body;
  if (!keyword) return json(400, { error: '검색 키워드가 없습니다.' });
  const debugInfo = debug ? {} : null;

  let query = keyword;
  if (hasKorean(keyword)) {
    const [translated] = await translateBatchWithGemini([keyword], 'en', GEMINI_KEY);
    query = translated || keyword;
  }
  if (debugInfo) debugInfo.query = query;
  // 키워드 번역이 안 됐다면(키 없음 등) 한국어 쿼리로라도 그대로 검색 시도 - 결과가 아예 없는 것보다 낫다.

  const [ndArticles, curArticles] = await Promise.all([
    NEWSDATA_KEY ? fetchNewsData(query, NEWSDATA_KEY, debugInfo) : Promise.resolve([]),
    CURRENTS_KEY ? fetchCurrents(query, CURRENTS_KEY, debugInfo) : Promise.resolve([])
  ]);
  if (debugInfo) return json(200, debugInfo);

  const seen = new Set();
  const merged = [];
  for (const a of [...ndArticles, ...curArticles]) {
    if (!a.url || seen.has(a.url)) continue;
    seen.add(a.url);
    merged.push(a);
  }
  merged.sort((a, b) => Date.parse(b.publishedAt || 0) - Date.parse(a.publishedAt || 0));
  const top = merged.slice(0, 10);

  const needsTranslation = top.filter(a => !hasKorean(a.title));
  if (needsTranslation.length) {
    const flat = [];
    needsTranslation.forEach(a => { flat.push(a.title); flat.push(a.description); });
    const translated = await translateBatchWithGemini(flat, 'ko', GEMINI_KEY);
    needsTranslation.forEach((a, i) => {
      const newTitle = translated[i * 2];
      const newDesc = translated[i * 2 + 1];
      if (newTitle && newTitle !== a.title) { a.title = newTitle; a.translated = true; }
      if (a.description && newDesc) a.description = newDesc;
    });
  }

  return json(200, {
    articles: top.map(a => ({ title: a.title, description: a.description, url: a.url, source: a.source, publishedAt: a.publishedAt, translated: !!a.translated })),
    totalArticles: merged.length
  });
}
