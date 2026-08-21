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
exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method Not Allowed' }) };
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
