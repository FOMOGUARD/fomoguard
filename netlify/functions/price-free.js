async function fetchYahooQuote(symbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}`;
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!res.ok) return null;
  const data = await res.json();
  const meta = data?.chart?.result?.[0]?.meta;
  if (!meta || meta.regularMarketPrice == null) return null;
  const price = meta.regularMarketPrice;
  const prevClose = meta.previousClose ?? meta.chartPreviousClose;
  const changePct = prevClose ? ((price - prevClose) / prevClose) * 100 : null;
  return { price, changePct, symbol };
}

// 우리 앱 화면에서 온 요청인지 확인한다 (functions/price-free.js와 동일 로직).
// 비용이 드는 공유 키를 쓰지 않는 경로라 로그인 대신 출처 검사로 외부 스크립트만 걸러낸다.
function isAllowedOrigin(headers) {
  const source = headers.origin || headers.Origin || headers.referer || headers.Referer || '';
  if (!source) return false;
  try {
    const host = new URL(source).hostname;
    return host === 'localhost' || host === '127.0.0.1' ||
           host === 'fomoguard.pages.dev' || host.endsWith('.fomoguard.pages.dev') ||
           host === 'fomoguard.netlify.app';
  } catch (e) {
    return false;
  }
}

// 무료 시세 조회 - API 키 등록 없이도 종목·지수 시세를 볼 수 있도록 하는 기본(free) 경로.
exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }
  if (!isAllowedOrigin(event.headers || {})) {
    return { statusCode: 403, body: JSON.stringify({ error: '허용되지 않은 요청입니다.' }) };
  }
  let body;
  try { body = JSON.parse(event.body || '{}'); } catch (e) { body = {}; }
  const { ticker, market } = body;
  if (!ticker && !market) return { statusCode: 400, body: JSON.stringify({ error: '종목 정보가 없습니다.' }) };

  let candidates;
  if (market === 'index-kospi') candidates = ['^KS11'];
  else if (market === 'index-sp500') candidates = ['SPY'];
  else if (market === 'index-nasdaq') candidates = ['QQQ'];
  else if (market === 'KRX') candidates = [`${ticker}.KS`, `${ticker}.KQ`];
  else candidates = [ticker];

  for (const sym of candidates) {
    try {
      const q = await fetchYahooQuote(sym);
      if (q) return { statusCode: 200, body: JSON.stringify(q) };
    } catch (e) {}
  }
  return { statusCode: 404, body: JSON.stringify({ error: '해당 종목의 시세를 찾지 못했습니다.' }) };
};
