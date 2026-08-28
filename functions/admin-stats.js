function json(status, obj) {
  return new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
}

// 백오피스 통계 - 관리자 1명(ADMIN_EMAIL)만 볼 수 있다.
// RLS가 "본인 데이터만 본인이" 보게 잠가둔 걸 정상적으로 우회하려면 service_role 키가
// 필요한데, 그 키는 클라이언트에 절대 노출하면 안 되므로 이 서버 함수 안에서만 쓴다.
// 회원탈퇴(delete-account.js)와 동일한 패턴: 클라이언트가 "나 관리자임" 이라고 주장하는 걸
// 믿지 않고, Authorization 토큰으로 실제 로그인된 이메일을 서버가 직접 재확인한 뒤 대조한다.
export async function onRequestGet(context) {
  const { request, env } = context;
  const SUPABASE_URL = env.SUPABASE_URL;
  const SUPABASE_ANON_KEY = env.SUPABASE_ANON_KEY;
  const SERVICE_KEY = env.SUPABASE_SERVICE_ROLE_KEY;
  const ADMIN_EMAIL = env.ADMIN_EMAIL;
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SERVICE_KEY || !ADMIN_EMAIL) {
    return json(500, { error: '서버에 백오피스 설정이 아직 안 되어 있습니다. (ADMIN_EMAIL / SUPABASE_SERVICE_ROLE_KEY 환경변수 확인)' });
  }
  const authHeader = request.headers.get('authorization');
  if (!authHeader) return json(401, { error: '로그인이 필요합니다.' });

  let email;
  try {
    const userRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: SUPABASE_ANON_KEY, Authorization: authHeader }
    });
    if (!userRes.ok) return json(401, { error: '로그인 확인에 실패했습니다. 다시 로그인해주세요.' });
    const userData = await userRes.json();
    email = userData.email;
  } catch (e) {
    return json(502, { error: '인증 서버에 연결하지 못했습니다.' });
  }
  if (!email || email.toLowerCase() !== ADMIN_EMAIL.toLowerCase()) {
    return json(403, { error: '관리자 계정이 아닙니다.' });
  }

  const svcHeaders = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` };

  // 전체 가입자 목록 (베타 규모라 한 페이지로 충분 - 사용자가 수천 명 단위로 늘어나면
  // page 파라미터로 페이지네이션 처리가 필요해진다).
  let users = [];
  try {
    const usersRes = await fetch(`${SUPABASE_URL}/auth/v1/admin/users?page=1&per_page=1000`, { headers: svcHeaders });
    if (!usersRes.ok) return json(502, { error: `가입자 목록 조회 실패 (${usersRes.status})` });
    const usersData = await usersRes.json();
    users = usersData.users || usersData || [];
  } catch (e) {
    return json(502, { error: '가입자 목록 조회 중 오류가 발생했습니다.' });
  }

  // 최근 30일 가입 추이 (날짜별 카운트)
  const todayStr = new Date().toISOString().slice(0, 10);
  const signupsByDate = {};
  users.forEach(u => {
    const d = (u.created_at || '').slice(0, 10);
    if (d) signupsByDate[d] = (signupsByDate[d] || 0) + 1;
  });

  // 활성 사용자 - fomoguard_growth.last_login_xp_date를 하루 1회 로그인 접속 신호로 재사용.
  // (성장 시스템이 이미 "오늘 로그인했는지"를 서버에서 검증해 기록해두던 컬럼이라 새 테이블 없이 재사용)
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

  return json(200, {
    totalUsers: users.length,
    activeToday,
    activeLast7Days,
    signupsByDate,
    recentSignups,
    generatedAt: new Date().toISOString()
  });
}
