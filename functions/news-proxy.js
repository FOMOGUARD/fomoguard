function json(status, obj) {
  return new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
}
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

async function searchGNews(q, apiKey, fromDate, max, lang) {
  let url = `https://gnews.io/api/v4/search?q=${encodeURIComponent(q)}&sortby=publishedAt&from=${encodeURIComponent(fromDate || '')}&max=${encodeURIComponent(max || 10)}&apikey=${encodeURIComponent(apiKey)}`;
  if (lang) url += `&lang=${encodeURIComponent(lang)}`;
  const res = await fetch(url);
  const text = await res.text();
  if (!res.ok) {
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

export async function onRequestPost(context) {
  const { request } = context;
  let body;
  try { body = await request.json(); } catch (e) { body = {}; }
  const { keyword, apiKey, fromDate, max } = body;
  if (!apiKey) return json(400, { error: 'GNews API 키가 없습니다. 설정에서 등록해주세요.' });
  if (!keyword) return json(400, { error: '검색 키워드가 없습니다.' });

  const perSearchMax = Math.min(max || 10, 10);
  const korean = hasKorean(keyword);

  let globalQuery = keyword;
  if (korean) {
    globalQuery = await translateText(keyword, 'en');
  }

  let domesticResult = { articles: [], totalArticles: 0 };
  let globalResult = { articles: [], totalArticles: 0 };
  try {
    const searches = [];
    // 국내(한국어) 뉴스: 원래 키워드 그대로, 한국어로 제한
    if (korean) searches.push(searchGNews(keyword, apiKey, fromDate, perSearchMax, 'ko').then(r => { domesticResult = r; }));
    // 해외(글로벌) 뉴스: 번역된(또는 원본) 키워드로, 언어 제한 없이 폭넓게
    searches.push(searchGNews(globalQuery, apiKey, fromDate, perSearchMax, null).then(r => { globalResult = r; }));
    await Promise.all(searches);
  } catch (e) {
    return json(e.status || 502, { error: e.message || '뉴스 서버(GNews)에 연결하지 못했습니다.' });
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

  // 이미 한국어 기사인 건 번역 생략, 해외(비한국어) 기사만 번역해서 노출
  await Promise.all(top.map(async (a) => {
    if (!hasKorean(a.title)) {
      a.titleKo = await translateText(a.title, 'ko');
      a.descriptionKo = a.description ? await translateText(a.description, 'ko') : '';
      a.translated = true;
    }
  }));

  const totalArticles = Math.max(domesticResult.totalArticles, globalResult.totalArticles);
  return json(200, { articles: top, totalArticles });
}
