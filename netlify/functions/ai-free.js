const GEMINI_KEY = process.env.GEMINI_SHARED_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const DAILY_CAP = 3;
const MODEL = 'gemini-3.6-flash';

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }
  if (!GEMINI_KEY || !SUPABASE_URL || !SUPABASE_ANON_KEY) {
    return { statusCode: 500, body: JSON.stringify({ error: '서버에 무료 AI 설정이 아직 안 되어 있습니다.' }) };
  }
  const authHeader = event.headers.authorization || event.headers.Authorization;
  if (!authHeader) {
    return { statusCode: 401, body: JSON.stringify({ error: '로그인이 필요합니다.' }) };
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch (e) { body = {}; }
  const { system, user, maxTokens } = body;
  if (!user) {
    return { statusCode: 400, body: JSON.stringify({ error: '요청 내용이 비어 있습니다.' }) };
  }

  let rpcRes;
  try {
    rpcRes = await fetch(`${SUPABASE_URL}/rest/v1/rpc/increment_ai_usage`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        apikey: SUPABASE_ANON_KEY,
        Authorization: authHeader
      },
      body: JSON.stringify({ p_cap: DAILY_CAP })
    });
  } catch (e) {
    return { statusCode: 502, body: JSON.stringify({ error: '사용량 확인 서버에 연결하지 못했습니다.' }) };
  }
  if (!rpcRes.ok) {
    const errText = await rpcRes.text();
    if (errText.includes('AI_DAILY_CAP_EXCEEDED')) {
      return { statusCode: 429, body: JSON.stringify({ error: `무료 AI 사용 한도(하루 ${DAILY_CAP}회)를 모두 사용했습니다. 내일 다시 이용하거나, 설정에서 본인 API 키를 등록하면 무제한으로 쓸 수 있어요.` }) };
    }
    return { statusCode: rpcRes.status === 401 ? 401 : 502, body: JSON.stringify({ error: `사용량 확인 실패 (${rpcRes.status}): ${errText.slice(0, 200)}` }) };
  }

  let geminiRes;
  try {
    geminiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${encodeURIComponent(GEMINI_KEY)}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          system_instruction: { parts: [{ text: system || '' }] },
          contents: [{ role: 'user', parts: [{ text: user }] }],
          generationConfig: { maxOutputTokens: maxTokens || 2000 }
        })
      }
    );
  } catch (e) {
    return { statusCode: 502, body: JSON.stringify({ error: 'AI 서버에 연결하지 못했습니다.' }) };
  }
  if (!geminiRes.ok) {
    const t = await geminiRes.text();
    if (geminiRes.status === 429) {
      return { statusCode: 429, body: JSON.stringify({ error: '오늘의 무료 AI 사용량이 모두 소진됐어요(전체 이용자 공통 한도). 설정에서 본인 API 키를 등록하면 제한 없이 계속 이용할 수 있어요.' }) };
    }
    return { statusCode: 502, body: JSON.stringify({ error: `AI 서버 오류: ${t.slice(0, 200)}` }) };
  }
  const data = await geminiRes.json();
  // 응답이 길이 제한(maxOutputTokens)에 걸려 중간에 잘리면 finishReason이 MAX_TOKENS로 온다.
  // 이걸 그냥 넘기면 호출부(포모체크 등)에서 JSON 파싱이 깨진 뒤에야 문제를 알게 되고,
  // 사용자에게는 "API 키·크레딧 확인하라"는 엉뚱한 안내가 나가게 된다 — 원인을 정확히 알려준다.
  if (data.candidates?.[0]?.finishReason === 'MAX_TOKENS') {
    return { statusCode: 502, body: JSON.stringify({ error: 'AI 응답이 길이 제한에 걸려 중간에 잘렸습니다. 다시 시도해보세요.' }) };
  }
  const text = (data.candidates?.[0]?.content?.parts || []).map(p=>p.text||'').join('') || '';
  return { statusCode: 200, body: JSON.stringify({ text }) };
};
