function json(status, obj) {
  return new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
}

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

// 우리 앱 화면에서 온 요청인지 확인한다.
// 이 경로는 비용이 드는 공유 키를 쓰지 않아서(야후 무료 시세) 로그인까지 요구하면
// 둘러보기 사용자만 불편해지므로, 로그인 대신 출처 검사로 외부 스크립트·크롤러의
// 무단 사용만 걸러낸다. 브라우저는 교차 출처 위조가 불가능한 Origin을 붙여주고,
// 헤더가 아예 없는 요청(curl·봇)은 여기서 막힌다.
function isAllowedOrigin(request) {
  const origin = request.headers.get('origin') || '';
  const referer = request.headers.get('referer') || '';
  const source = origin || referer;
  if (!source) return false;
  try {
    const host = new URL(source).hostname;
    return host === 'localhost' || host === '127.0.0.1' ||
           host === 'fomoguard.pages.dev' || host.endsWith('.fomoguard.pages.dev');
  } catch (e) {
    return false;
  }
}

// 무료 시세 조회 - API 키 등록 없이도 종목·지수 시세를 볼 수 있도록 하는 기본(free) 경로.
// Twelve Data 키를 등록한 사용자는 클라이언트에서 Twelve Data를 직접 호출하고, 이 엔드포인트는 그 경우 쓰이지 않는다.
export async function onRequestPost(context) {
  const { request } = context;
  if (!isAllowedOrigin(request)) {
    return json(403, { error: '허용되지 않은 요청입니다.' });
  }
  let body;
  try { body = await request.json(); } catch (e) { body = {}; }
  const { ticker, market } = body;
  if (!ticker && !market) return json(400, { error: '종목 정보가 없습니다.' });

  let candidates;
  if (market === 'index-kospi') candidates = ['^KS11'];
  else if (market === 'index-sp500') candidates = ['SPY'];
  else if (market === 'index-nasdaq') candidates = ['QQQ'];
  else if (market === 'KRX') candidates = [`${ticker}.KS`, `${ticker}.KQ`];
  else candidates = [ticker];

  for (const sym of candidates) {
    try {
      const q = await fetchYahooQuote(sym);
      if (q) return json(200, q);
    } catch (e) {}
  }
  return json(404, { error: '해당 종목의 시세를 찾지 못했습니다.' });
}
