const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ADMIN_EMAIL = process.env.ADMIN_EMAIL;

// 백오피스 통계 - 관리자 1명(ADMIN_EMAIL)만 볼 수 있다. functions/admin-stats.js와 동일 로직
// (Cloudflare Functions와 항상 쌍으로 유지 - 이 저장소 관례). 상세 주석은 그쪽 파일 참고.
exports.handler = async (event) => {
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SERVICE_KEY || !ADMIN_EMAIL) {
    return { statusCode: 500, body: JSON.stringify({ error: '서버에 백오피스 설정이 아직 안 되어 있습니다. (ADMIN_EMAIL / SUPABASE_SERVICE_ROLE_KEY 환경변수 확인)' }) };
  }
  const authHeader = event.headers.authorization || event.headers.Authorization;
  if (!authHeader) return { statusCode: 401, body: JSON.stringify({ error: '로그인이 필요합니다.' }) };

  let email;
  try {
    const userRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: SUPABASE_ANON_KEY, Authorization: authHeader }
    });
    if (!userRes.ok) return { statusCode: 401, body: JSON.stringify({ error: '로그인 확인에 실패했습니다. 다시 로그인해주세요.' }) };
    const userData = await userRes.json();
    email = userData.email;
  } catch (e) {
    return { statusCode: 502, body: JSON.stringify({ error: '인증 서버에 연결하지 못했습니다.' }) };
  }
  if (!email || email.toLowerCase() !== ADMIN_EMAIL.toLowerCase()) {
    return { statusCode: 403, body: JSON.stringify({ error: '관리자 계정이 아닙니다.' }) };
  }

  const svcHeaders = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` };

  let users = [];
  try {
    const usersRes = await fetch(`${SUPABASE_URL}/auth/v1/admin/users?page=1&per_page=1000`, { headers: svcHeaders });
    if (!usersRes.ok) return { statusCode: 502, body: JSON.stringify({ error: `가입자 목록 조회 실패 (${usersRes.status})` }) };
    const usersData = await usersRes.json();
    users = usersData.users || usersData || [];
  } catch (e) {
    return { statusCode: 502, body: JSON.stringify({ error: '가입자 목록 조회 중 오류가 발생했습니다.' }) };
  }

  const todayStr = new Date().toISOString().slice(0, 10);
  const signupsByDate = {};
  users.forEach(u => {
    const d = (u.created_at || '').slice(0, 10);
    if (d) signupsByDate[d] = (signupsByDate[d] || 0) + 1;
  });

  let growthRows = [];
  try {
    const growthRes = await fetch(`${SUPABASE_URL}/rest/v1/fomoguard_growth?select=user_id,xp,last_login_xp_date,fc_xp_count,journal_xp_count`, { headers: svcHeaders });
    if (growthRes.ok) growthRows = await growthRes.json();
  } catch (e) {}

  const sevenDaysAgo = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
  const activeToday = growthRows.filter(g => g.last_login_xp_date === todayStr).length;
  const activeLast7Days = growthRows.filter(g => g.last_login_xp_date && g.last_login_xp_date >= sevenDaysAgo).length;

  const recentSignups = users
    .slice()
    .sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''))
    .slice(0, 20)
    .map(u => ({ email: u.email, createdAt: u.created_at, lastSignInAt: u.last_sign_in_at }));

  return {
    statusCode: 200,
    body: JSON.stringify({
      totalUsers: users.length,
      activeToday,
      activeLast7Days,
      signupsByDate,
      recentSignups,
      generatedAt: new Date().toISOString()
    })
  };
};
