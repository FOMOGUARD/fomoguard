function decodeEntities(str) {
  return (str || '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
}
function extractTag(block, tag) {
  const m = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'));
  if (!m) return '';
  return m[1].replace(/^<!\[CDATA\[/, '').replace(/\]\]>$/, '').trim();
}
function parseGoogleNewsRss(xml) {
  const items = [];
  const itemBlocks = xml.match(/<item>[\s\S]*?<\/item>/g) || [];
  for (const block of itemBlocks) {
    let title = decodeEntities(extractTag(block, 'title'));
    const link = decodeEntities(extractTag(block, 'link'));
    const pubDate = extractTag(block, 'pubDate');
    const source = decodeEntities(extractTag(block, 'source'));
    if (!title || !link) continue;
    if (source && title.endsWith(' - ' + source)) title = title.slice(0, -(' - ' + source).length).trim();
    items.push({
      title,
      url: link,
      source,
      publishedAt: pubDate ? new Date(pubDate).toISOString() : '',
      description: ''
    });
  }
  return items;
}

// 무료 뉴스 조회 - GNews API 키를 등록하지 않은 사용자를 위한 기본 경로 (구글 뉴스 공개 RSS).
exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }
  let body;
  try { body = JSON.parse(event.body || '{}'); } catch (e) { body = {}; }
  const { keyword } = body;
  if (!keyword) return { statusCode: 400, body: JSON.stringify({ error: '검색 키워드가 없습니다.' }) };

  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(keyword)}&hl=ko&gl=KR&ceid=KR:ko`;
  let res;
  try {
    res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  } catch (e) {
    return { statusCode: 502, body: JSON.stringify({ error: '뉴스 서버에 연결하지 못했습니다.' }) };
  }
  if (!res.ok) return { statusCode: 502, body: JSON.stringify({ error: `뉴스 조회 오류 (${res.status})` }) };
  const xml = await res.text();
  const articles = parseGoogleNewsRss(xml).slice(0, 20);
  return { statusCode: 200, body: JSON.stringify({ articles, totalArticles: articles.length }) };
};
