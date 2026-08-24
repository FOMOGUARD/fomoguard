const hasKorean = (s) => /[가-힣]/.test(s || '');

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
// GEMINI_SHARED_KEY(무료 티어 하루 20건)와 완전히 분리된 자원이라 1차로 쓴다.
async function translateOneWithMyMemory(text, sourceLang, targetLang) {
  if (!text || !text.trim()) return null;
  const q = text.replace(/\n/g, ' ').slice(0, 480);
  try {
    const res = await fetch(`https://api.mymemory.translated.net/get?q=${encodeURIComponent(q)}&langpair=${sourceLang}|${targetLang}`);
    if (!res.ok) return null;
    const data = await res.json();
    if (data.quotaFinished) return null;
    const t = data.responseData?.translatedText;
    if (!t || /MYMEMORY WARNING/i.test(t)) return null;
    return t;
  } catch (e) {
    return null;
  }
}

// 구글 번역 공개 엔드포인트는 클라우드 IP발 요청을 막는 걸 확인해서 쓰지 않는다.
// Gemini는 MyMemory가 실패한 항목에 한해 최후 보루로만 쓴다(무료 쿼터가 낮아서 - 실측 하루 20건).
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
async function translateBatch(items, sourceLang, targetLang, geminiKey, quotaFlag) {
  if (!items.length) return items;
  const myMemoryResults = await Promise.all(items.map(t => translateOneWithMyMemory(t, sourceLang, targetLang)));
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

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function searchGNews(q, apiKey, fromDate, max, lang, retriesLeft) {
  if (retriesLeft === undefined) retriesLeft = 2;
  let url = `https://gnews.io/api/v4/search?q=${encodeURIComponent(q)}&sortby=publishedAt&from=${encodeURIComponent(fromDate || '')}&max=${encodeURIComponent(max || 10)}&apikey=${encodeURIComponent(apiKey)}`;
  if (lang) url += `&lang=${encodeURIComponent(lang)}`;
  const res = await fetch(url);
  const text = await res.text();
  if (!res.ok) {
    // GNews는 짧은 시간에 요청이 몰리면 일일 한도와 별개로 순간 버스트 제한(429)을 걸 수 있어서,
    // 지수적으로 늘어나는 대기시간으로 재시도한다(1.8초 -> 3.2초).
    if (res.status === 429 && retriesLeft > 0) {
      await sleep(retriesLeft === 2 ? 1800 : 3200);
      return searchGNews(q, apiKey, fromDate, max, lang, retriesLeft - 1);
    }
    let msg = text.slice(0, 200);
    try { msg = JSON.parse(text).errors?.join(' ') || msg; } catch (e) {}
    const err = new Error(`GNews API 오류 (${res.status}): ${msg}`);
    err.status = res.status;
    throw err;
  }
  let data;
  try { data = JSON.parse(text); } catch (e) { throw new Error('GNews 응답 형식이 예상과 다릅니다: ' + text.slice(0, 200)); }
  return { articles: Array.isArray(data.articles) ? data.articles : [], totalArticles: data.totalArticles ?? 0 };
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }
  const GEMINI_KEY = process.env.GEMINI_SHARED_KEY;
  let body;
  try { body = JSON.parse(event.body || '{}'); } catch (e) { body = {}; }
  const { keyword, apiKey, fromDate, max } = body;
  if (!apiKey) return { statusCode: 400, body: JSON.stringify({ error: 'GNews API 키가 없습니다. 설정에서 등록해주세요.' }) };
  if (!keyword) return { statusCode: 400, body: JSON.stringify({ error: '검색 키워드가 없습니다.' }) };

  const perSearchMax = Math.min(max || 10, 10);
  const korean = hasKorean(keyword);
  const quotaFlag = { hit: false };

  let globalQuery = keyword;
  if (korean) {
    const dict = dictLookup(keyword);
    if (dict) {
      globalQuery = dict;
    } else {
      const [translated] = await translateBatch([keyword], 'ko', 'en', GEMINI_KEY, quotaFlag);
      globalQuery = translated || keyword;
    }
  }

  let domesticResult = { articles: [], totalArticles: 0 };
  let globalResult = { articles: [], totalArticles: 0 };
  try {
    if (korean) {
      domesticResult = await searchGNews(keyword, apiKey, fromDate, perSearchMax, 'ko');
      await sleep(600);
    }
    globalResult = await searchGNews(globalQuery, apiKey, fromDate, perSearchMax, null);
  } catch (e) {
    return { statusCode: e.status || 502, body: JSON.stringify({ error: e.message || '뉴스 서버(GNews)에 연결하지 못했습니다.' }) };
  }

  const seen = new Set();
  const merged = [];
  for (const a of [...domesticResult.articles, ...globalResult.articles]) {
    const url = a.url || '';
    if (!url || seen.has(url)) continue;
    seen.add(url);
    merged.push(a);
  }
  merged.sort((a, b) => Date.parse(b.publishedAt || 0) - Date.parse(a.publishedAt || 0));
  const top = merged.slice(0, 10);

  const needsTranslation = top.filter(a => !hasKorean(a.title));
  if (needsTranslation.length) {
    const flat = [];
    needsTranslation.forEach(a => { flat.push(a.title); flat.push(a.description || ''); });
    const translated = await translateBatch(flat, 'en', 'ko', GEMINI_KEY, quotaFlag);
    needsTranslation.forEach((a, i) => {
      const newTitle = translated[i * 2];
      const newDesc = translated[i * 2 + 1];
      if (newTitle && newTitle !== a.title) { a.titleKo = newTitle; a.translated = true; }
      if (a.description && newDesc) a.descriptionKo = newDesc;
    });
  }

  const totalArticles = Math.max(domesticResult.totalArticles, globalResult.totalArticles);
  return { statusCode: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ articles: top, totalArticles, translationLimited: quotaFlag.hit }) };
};
