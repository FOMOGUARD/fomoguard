function json(status, obj) {
  return new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
}

// 회원탈퇴 - 계정과 클라우드에 저장된 모든 데이터를 영구히 삭제한다.
// SUPABASE_SERVICE_ROLE_KEY(관리자 권한)가 있어야 auth.users를 직접 삭제할 수 있어서,
// 이 엔드포인트는 서버(Cloudflare Function)에서만 실행되고 클라이언트에는 절대 그 키를 넘기지 않는다.
// 클라이언트가 보낸 사용자 id를 그대로 믿지 않고, Authorization 토큰으로 본인 확인부터 한다.
export async function onRequestPost(context) {
  const { request, env } = context;
  const SUPABASE_URL = env.SUPABASE_URL;
  const SUPABASE_ANON_KEY = env.SUPABASE_ANON_KEY;
  const SERVICE_KEY = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SERVICE_KEY) {
    return json(500, { error: '서버에 회원탈퇴 설정이 아직 안 되어 있습니다.' });
  }
  const authHeader = request.headers.get('authorization');
  if (!authHeader) return json(401, { error: '로그인이 필요합니다.' });

  let userId;
  try {
    const userRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: SUPABASE_ANON_KEY, Authorization: authHeader }
    });
    if (!userRes.ok) return json(401, { error: '로그인 확인에 실패했습니다. 다시 로그인해주세요.' });
    const userData = await userRes.json();
    userId = userData.id;
    if (!userId) return json(401, { error: '사용자 정보를 확인하지 못했습니다.' });
  } catch (e) {
    return json(502, { error: '인증 서버에 연결하지 못했습니다.' });
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
      return json(502, { error: `계정 삭제 실패: ${t.slice(0, 200)}` });
    }
  } catch (e) {
    return json(502, { error: '계정 삭제 중 서버 오류가 발생했습니다.' });
  }

  return json(200, { ok: true });
}
