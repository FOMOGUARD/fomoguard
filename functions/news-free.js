function json(status, obj) {
  return new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
}
const hasKorean = (s) => /[가-힣]/.test(s || '');

// 자주 쓰이는 한국어 금융 키워드는 번역 API 호출 없이 바로 영문 검색어로 매핑한다.
const KEYWORD_DICTIONARY = {
  '코스피': 'KOSPI', '코스닥': 'KOSDAQ', '나스닥': 'NASDAQ', '다우존스': 'Dow Jones', '다우': 'Dow Jones',
  '삼성전자': 'Samsung Electronics', 'sk하이닉스': 'SK Hynix', '하이닉스': 'SK Hynix',
  '엔비디아': 'Nvidia', '테슬라': 'Tesla', '애플': 'Apple', '구글': 'Google', '아마존': 'Amazon',
  '마이크로소프트': 'Microsoft', '메타': 'Meta', '넷플릭스': 'Netflix', '알파벳': 'Alphabet',
  '반도체': 'semiconductor', '이차전지': 'battery', '배터리': 'battery', '2차전지': 'battery',
  '환율': 'exchange rate', '금리': 'interest rate', '연준': 'Federal Reserve', '기준금리': 'interest rate',
  '비트코인': 'Bitcoin', '이더리움': 'Ethereum', '가상화폐': 'cryptocurrency', '암호화폐': 'cryptocurrency',
  '금값': 'gold price', '유가': 'oil price', '국제유가': 'crude oil price',
  'lg에너지솔루션': 'LG Energy Solution', '카카오': 'Kakao', '네이버': 'Naver',
  '현대차': 'Hyundai Motor', '기아': 'Kia', '포스코': 'POSCO', '셀트리온': 'Celltrion',
  '미국증시': 'US stock market', '국내증시': 'Korea stock market', 's&p500': 'S&P 500', 'sp500': 'S&P 500'
};
function dictLookup(keyword) {
  return KEYWORD_DICTIONARY[keyword.trim().toLowerCase()] || null;
}

// MyMemory Translation API - 키 없이 쓸 수 있고 무료 일일 한도가 넉넉함(익명 5,000단어/일).
// GEMINI_SHARED_KEY(무료 티어 하루 20건)와 완전히 분리된 자원이라, 번역을 여기로 1차 처리하면
// AI 데일리 분석과 쿼터를 다툴 일이 없다. 배치 API가 없어서 건별로 병렬 호출한다.
async function translateOneWithMyMemory(text, sourceLang, targetLang, debugInfo) {
  if (!text || !text.trim()) return null;
  const q = text.replace(/\n/g, ' ').slice(0, 480);
  try {
    const res = await fetch(`https://api.mymemory.translated.net/get?q=${encodeURIComponent(q)}&langpair=${sourceLang}|${targetLang}`);
    const raw = await res.text();
    if (debugInfo) debugInfo.mymemory = { status: res.status, body: raw.slice(0, 500) };
    if (!res.ok) return null;
    const data = JSON.parse(raw);
    if (data.quotaFinished) return null;
    const t = data.responseData?.translatedText;
    if (!t || /MYMEMORY WARNING/i.test(t)) return null;
    return t;
  } catch (e) {
    if (debugInfo) debugInfo.mymemory = { error: String(e) };
    return null;
  }
}

// 구글 번역 공개 엔드포인트(translate.googleapis.com)는 클라우드 IP발 요청을 막아버리는 걸 확인해서
// (실측: "Sorry..." 봇 차단 페이지, 429) 쓰지 않는다. Gemini는 MyMemory가 실패한 항목에 한해
// 최후 보루로만 쓴다(무료 쿼터가 워낙 낮아서 - 실측 하루 20건).
async function translateBatchWithGemini(items, targetLang, geminiKey, quotaFlag) {
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
    if (!res.ok) {
      if (res.status === 429 && quotaFlag) quotaFlag.hit = true;
      return items;
    }
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

// 여러 문자열을 번역: 1차 MyMemory(건별 병렬), 실패한 것만 2차 Gemini(배치)로 보충.
async function translateBatch(items, sourceLang, targetLang, geminiKey, quotaFlag, debugInfo) {
  if (!items.length) return items;
  const myMemoryResults = await Promise.all(items.map(t => translateOneWithMyMemory(t, sourceLang, targetLang, debugInfo)));
  const result = items.map((orig, i) => myMemoryResults[i] || orig);
  const fallbackItems = [];
  const fallbackIdx = [];
  myMemoryResults.forEach((r, i) => { if (!r && (items[i] || '').trim()) { fallbackItems.push(items[i]); fallbackIdx.push(i); } });
  if (fallbackItems.length) {
    const geminiResults = await translateBatchWithGemini(fallbackItems, targetLang === 'ko' ? 'ko' : 'en', geminiKey, quotaFlag);
    geminiResults.forEach((t, j) => { if (t && t !== fallbackItems[j]) result[fallbackIdx[j]] = t; });
  }
  return result;
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
  const GEMINI_KEY = env.GEMINI_SHARED_KEY;
  if (!NEWSDATA_KEY && !CURRENTS_KEY) {
    return json(500, { error: '서버에 무료 뉴스 설정이 아직 안 되어 있습니다.' });
  }
  let body;
  try { body = await request.json(); } catch (e) { body = {}; }
  const { keyword, debug } = body;
  if (!keyword) return json(400, { error: '검색 키워드가 없습니다.' });
  const debugInfo = debug ? {} : null;

  const quotaFlag = { hit: false };
  let query = keyword;
  if (hasKorean(keyword)) {
    const dict = dictLookup(keyword);
    if (dict) {
      query = dict;
    } else {
      const [translated] = await translateBatch([keyword], 'ko', 'en', GEMINI_KEY, quotaFlag, debugInfo);
      query = translated || keyword;
    }
  }
  // 키워드 번역이 안 됐다면(사전에도 없고 MyMemory·Gemini 둘 다 실패) 한국어 쿼리로라도 그대로 검색 시도.

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
  const top = merged.slice(0, 10);

  const needsTranslation = top.filter(a => !hasKorean(a.title));
  if (needsTranslation.length) {
    const flat = [];
    needsTranslation.forEach(a => { flat.push(a.title); flat.push(a.description); });
    const translated = await translateBatch(flat, 'en', 'ko', GEMINI_KEY, quotaFlag, debugInfo);
    needsTranslation.forEach((a, i) => {
      const newTitle = translated[i * 2];
      const newDesc = translated[i * 2 + 1];
      if (newTitle && newTitle !== a.title) { a.title = newTitle; a.translated = true; }
      if (a.description && newDesc) a.description = newDesc;
    });
  }
  if (debugInfo) return json(200, debugInfo);

  return json(200, {
    articles: top.map(a => ({ title: a.title, description: a.description, url: a.url, source: a.source, publishedAt: a.publishedAt, translated: !!a.translated })),
    totalArticles: merged.length,
    translationLimited: quotaFlag.hit
  });
}
