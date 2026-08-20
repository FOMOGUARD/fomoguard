exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }
  let body;
  try { body = JSON.parse(event.body || '{}'); } catch (e) { body = {}; }
  const { keyword, apiKey, fromDate, max } = body;
  if (!apiKey) return { statusCode: 400, body: JSON.stringify({ error: 'GNews API 키가 없습니다. 설정에서 등록해주세요.' }) };
  if (!keyword) return { statusCode: 400, body: JSON.stringify({ error: '검색 키워드가 없습니다.' }) };

  const url = `https://gnews.io/api/v4/search?q=${encodeURIComponent(keyword)}&sortby=publishedAt&from=${encodeURIComponent(fromDate || '')}&max=${encodeURIComponent(max || 10)}&apikey=${encodeURIComponent(apiKey)}`;
  let res;
  try {
    res = await fetch(url);
  } catch (e) {
    return { statusCode: 502, body: JSON.stringify({ error: '뉴스 서버(GNews)에 연결하지 못했습니다.' }) };
  }
  const text = await res.text();
  if (!res.ok) {
    let msg = text.slice(0, 200);
    try { msg = JSON.parse(text).errors?.join(' ') || msg; } catch (e) {}
    return { statusCode: res.status, body: JSON.stringify({ error: `GNews API 오류 (${res.status}): ${msg}` }) };
  }
  return { statusCode: 200, headers: { 'content-type': 'application/json' }, body: text };
};
