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

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function searchGNews(q, apiKey, fromDate, max, lang, retriesLeft) {
  if (retriesLeft === undefined) retriesLeft = 1;
  let url = `https://gnews.io/api/v4/search?q=${encodeURIComponent(q)}&sortby=publishedAt&from=${encodeURIComponent(fromDate || '')}&max=${encodeURIComponent(max || 10)}&apikey=${encodeURIComponent(apiKey)}`;
  if (lang) url += `&lang=${encodeURIComponent(lang)}`;
  const res = await fetch(url);
  const text = await res.text();
  if (!res.ok) {
    if (res.status === 429 && retriesLeft > 0) {
      await sleep(1500);
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
  let body;
  try { body = JSON.parse(event.body || '{}'); } catch (e) { body = {}; }
  const { keyword, apiKey, fromDate, max } = body;
  if (!apiKey) return { statusCode: 400, body: JSON.stringify({ error: 'GNews API 키가 없습니다. 설정에서 등록해주세요.' }) };
  if (!keyword) return { statusCode: 400, body: JSON.stringify({ error: '검색 키워드가 없습니다.' }) };

  const perSearchMax = Math.min(max || 10, 10);
  const korean = hasKorean(keyword);

  let globalQuery = keyword;
  if (korean) {
    globalQuery = await translateText(keyword, 'en');
  }

  let domesticResult = { articles: [], totalArticles: 0 };
  let globalResult = { articles: [], totalArticles: 0 };
  try {
    if (korean) {
      domesticResult = await searchGNews(keyword, apiKey, fromDate, perSearchMax, 'ko');
      await sleep(350);
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

  await Promise.all(top.map(async (a) => {
    if (!hasKorean(a.title)) {
      a.titleKo = await translateText(a.title, 'ko');
      a.descriptionKo = a.description ? await translateText(a.description, 'ko') : '';
      a.translated = true;
    }
  }));

  const totalArticles = Math.max(domesticResult.totalArticles, globalResult.totalArticles);
  return { statusCode: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ articles: top, totalArticles }) };
};
