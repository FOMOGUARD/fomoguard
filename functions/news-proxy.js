function json(status, obj) {
  return new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
}

export async function onRequestPost(context) {
  const { request } = context;
  let body;
  try { body = await request.json(); } catch (e) { body = {}; }
  const { keyword, apiKey, fromDate, max } = body;
  if (!apiKey) return json(400, { error: 'GNews API 키가 없습니다. 설정에서 등록해주세요.' });
  if (!keyword) return json(400, { error: '검색 키워드가 없습니다.' });

  const url = `https://gnews.io/api/v4/search?q=${encodeURIComponent(keyword)}&sortby=publishedAt&from=${encodeURIComponent(fromDate || '')}&max=${encodeURIComponent(max || 10)}&apikey=${encodeURIComponent(apiKey)}`;
  let res;
  try {
    res = await fetch(url);
  } catch (e) {
    return json(502, { error: '뉴스 서버(GNews)에 연결하지 못했습니다.' });
  }
  const text = await res.text();
  if (!res.ok) {
    let msg = text.slice(0, 200);
    try { msg = JSON.parse(text).errors?.join(' ') || msg; } catch (e) {}
    return json(res.status, { error: `GNews API 오류 (${res.status}): ${msg}` });
  }
  return new Response(text, { status: 200, headers: { 'content-type': 'application/json' } });
}
