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

// 무료 시세 조회 - API 키 등록 없이도 종목·지수 시세를 볼 수 있도록 하는 기본(free) 경로.
// Twelve Data 키를 등록한 사용자는 클라이언트에서 Twelve Data를 직접 호출하고, 이 엔드포인트는 그 경우 쓰이지 않는다.
export async function onRequestPost(context) {
  const { request } = context;
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
