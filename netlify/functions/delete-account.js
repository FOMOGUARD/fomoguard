const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// 회원탈퇴 - 계정과 클라우드에 저장된 모든 데이터를 영구히 삭제한다.
exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SERVICE_KEY) {
    return { statusCode: 500, body: JSON.stringify({ error: '서버에 회원탈퇴 설정이 아직 안 되어 있습니다.' }) };
  }
  const authHeader = event.headers.authorization || event.headers.Authorization;
  if (!authHeader) return { statusCode: 401, body: JSON.stringify({ error: '로그인이 필요합니다.' }) };

  let userId;
  try {
    const userRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: SUPABASE_ANON_KEY, Authorization: authHeader }
    });
    if (!userRes.ok) return { statusCode: 401, body: JSON.stringify({ error: '로그인 확인에 실패했습니다. 다시 로그인해주세요.' }) };
    const userData = await userRes.json();
    userId = userData.id;
    if (!userId) return { statusCode: 401, body: JSON.stringify({ error: '사용자 정보를 확인하지 못했습니다.' }) };
  } catch (e) {
    return { statusCode: 502, body: JSON.stringify({ error: '인증 서버에 연결하지 못했습니다.' }) };
  }

  const tables = ['fomoguard_data', 'fomoguard_growth', 'fomoguard_ai_usage'];
  for (const t of tables) {
    try {
      await fetch(`${SUPABASE_URL}/rest/v1/${t}?user_id=eq.${encodeURIComponent(userId)}`, {
        method: 'DELETE',
        headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` }
      });
    } catch (e) {}
  }

  try {
    const delRes = await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${encodeURIComponent(userId)}`, {
      method: 'DELETE',
      headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` }
    });
    if (!delRes.ok) {
      const t = await delRes.text();
      return { statusCode: 502, body: JSON.stringify({ error: `계정 삭제 실패: ${t.slice(0, 200)}` }) };
    }
  } catch (e) {
    return { statusCode: 502, body: JSON.stringify({ error: '계정 삭제 중 서버 오류가 발생했습니다.' }) };
  }

  return { statusCode: 200, body: JSON.stringify({ ok: true }) };
};
