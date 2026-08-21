function json(status, obj) {
  return new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
}

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

// 구글 뉴스 RSS(공개 피드, 키 불필요)를 파싱한다. 정식 API가 아니라 XML을 직접 파싱해야 해서
// 위와 같이 정규식 기반의 가벼운 파서를 쓴다 (별도 XML 파서 라이브러리 없이 동작하도록).
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

// 무료 뉴스 조회 - GNews API 키를 등록하지 않은 사용자를 위한 기본 경로.
// 구글 뉴스 공개 RSS 검색을 사용해 요청 횟수 허들 없이 헤드라인을 제공한다.
// 자체 GNews 키를 등록한 사용자는 이 경로 대신 기존 /news-proxy(GNews)를 그대로 사용한다.
export async function onRequestPost(context) {
  const { request } = context;
  let body;
  try { body = await request.json(); } catch (e) { body = {}; }
  const { keyword } = body;
  if (!keyword) return json(400, { error: '검색 키워드가 없습니다.' });

  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(keyword)}&hl=ko&gl=KR&ceid=KR:ko`;
  let res;
  try {
    res = await fetchWithRetry(url);
  } catch (e) {
    return json(502, { error: e.message || '뉴스 서버에 연결하지 못했습니다.' });
  }
  const xml = await res.text();
  const articles = parseGoogleNewsRss(xml).slice(0, 20);
  return json(200, { articles, totalArticles: articles.length });
}
