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

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const FETCH_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'application/rss+xml, application/xml, text/xml, */*',
  'Accept-Language': 'ko-KR,ko;q=0.9,en;q=0.8'
};

async function fetchWithTimeout(url, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { headers: FETCH_HEADERS, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}
// 구글 뉴스가 클라우드 쪽 IP에서 오는 요청을 간헐적으로 503으로 막는 경우가 있어 1번 재시도하되,
// 매 시도에 짧은 타임아웃을 걸어서 막혀 있을 때 응답이 오래 지연되지 않게 한다.
async function fetchWithRetry(url, retries) {
  if (retries === undefined) retries = 1;
  let lastStatus = 0;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await sleep(400);
    let res;
    try {
      res = await fetchWithTimeout(url, 5000);
    } catch (e) {
      continue;
    }
    if (res.ok) return res;
    lastStatus = res.status;
  }
  const err = new Error(`뉴스 조회 오류 (${lastStatus || 502})`);
  err.status = lastStatus || 502;
  throw err;
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
    res = await fetchWithRetry(url);
  } catch (e) {
    return { statusCode: 502, body: JSON.stringify({ error: e.message || '뉴스 서버에 연결하지 못했습니다.' }) };
  }
  const xml = await res.text();
  const articles = parseGoogleNewsRss(xml).slice(0, 20);
  return { statusCode: 200, body: JSON.stringify({ articles, totalArticles: articles.length }) };
};
