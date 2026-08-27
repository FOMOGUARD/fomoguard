-- 성장 시스템(레벨/경험치) 서버 검증용 테이블 + RPC
-- Supabase 대시보드 → SQL Editor에서 실행하세요.
--
-- 목적: 지금까지는 클라이언트(브라우저)가 계산한 경험치 값을 그대로 신뢰하고
-- 저장해서, 개발자도구 콘솔로 누구나 자기 경험치를 조작할 수 있었습니다.
-- 이 스크립트를 실행하면 경험치 지급은 오직 아래 서버 함수(RPC)를 통해서만
-- 가능해지고, 하루 지급 횟수도 서버에서 직접 검증합니다.

create table if not exists public.fomoguard_growth (
  user_id uuid primary key references auth.users(id) on delete cascade,
  xp int not null default 0,
  last_login_xp_date date,
  fc_xp_date date,
  fc_xp_count int not null default 0,
  journal_xp_date date,
  journal_xp_count int not null default 0,
  quiz_answered_date date,
  quiz_correct boolean,
  quiz_picked_idx int,
  updated_at timestamptz not null default now()
);
alter table public.fomoguard_growth enable row level security;
create policy "select own growth" on public.fomoguard_growth for select using (auth.uid() = user_id);
-- insert/update 정책은 의도적으로 만들지 않습니다 (클라이언트가 테이블에 직접 쓸 수 없게).
-- 값 변경은 아래 security definer 함수를 통해서만 가능합니다.

create or replace function public._ensure_growth_row()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.fomoguard_growth (user_id) values (auth.uid())
    on conflict (user_id) do nothing;
end;
$$;

create or replace function public.grant_login_xp()
returns public.fomoguard_growth
language plpgsql
security definer
set search_path = public
as $$
declare
  row_ public.fomoguard_growth;
begin
  perform public._ensure_growth_row();
  update public.fomoguard_growth
    set xp = xp + 10, last_login_xp_date = current_date, updated_at = now()
    where user_id = auth.uid() and last_login_xp_date is distinct from current_date;
  select * into row_ from public.fomoguard_growth where user_id = auth.uid();
  return row_;
end;
$$;
grant execute on function public.grant_login_xp() to authenticated;

create or replace function public.grant_factcheck_xp()
returns public.fomoguard_growth
language plpgsql
security definer
set search_path = public
as $$
declare
  row_ public.fomoguard_growth;
begin
  perform public._ensure_growth_row();
  update public.fomoguard_growth
    set fc_xp_count = case when fc_xp_date = current_date then fc_xp_count else 0 end,
        fc_xp_date = current_date
    where user_id = auth.uid();
  update public.fomoguard_growth
    set xp = xp + 15, fc_xp_count = fc_xp_count + 1, updated_at = now()
    where user_id = auth.uid() and fc_xp_count < 3;
  select * into row_ from public.fomoguard_growth where user_id = auth.uid();
  return row_;
end;
$$;
grant execute on function public.grant_factcheck_xp() to authenticated;

create or replace function public.grant_journal_xp()
returns public.fomoguard_growth
language plpgsql
security definer
set search_path = public
as $$
declare
  row_ public.fomoguard_growth;
begin
  perform public._ensure_growth_row();
  update public.fomoguard_growth
    set journal_xp_count = case when journal_xp_date = current_date then journal_xp_count else 0 end,
        journal_xp_date = current_date
    where user_id = auth.uid();
  update public.fomoguard_growth
    set xp = xp + 15, journal_xp_count = journal_xp_count + 1, updated_at = now()
    where user_id = auth.uid() and journal_xp_count < 3;
  select * into row_ from public.fomoguard_growth where user_id = auth.uid();
  return row_;
end;
$$;
grant execute on function public.grant_journal_xp() to authenticated;

-- 오늘의 퀴즈 정답 인덱스는 서버가 직접 판정합니다 (클라이언트가 "정답이었다"고
-- 우겨도 서버가 자체 정답표와 비교해서 아니면 지급하지 않습니다).
-- QUIZ_BANK의 24문항과 같은 순서 유지, 문항이 바뀌면 아래 배열도 함께 수정하세요.
-- 이 배열은 "그날 화면에 섞여서 표시되는 보기 중 몇 번째가 정답인가"를 담고 있습니다.
-- index.html의 QUIZ_PERM_TABLE(4개 항목의 24가지 순열 고정 테이블)에서
-- 매일 값 0(=QUIZ_BANK 원본 정답 위치)이 섞인 뒤 몇 번째 자리로 이동하는지를 그대로 옮긴 것입니다.
-- QUIZ_PERM_TABLE을 바꾸면 이 배열도 반드시 같이 재계산해서 맞춰야 합니다(안 그러면
-- 서버·클라이언트 정답 판정이 어긋나는 버그가 재발합니다 - 실제로 한 번 이 문제가 있었음).
create or replace function public.submit_quiz_xp(p_picked_idx int)
returns public.fomoguard_growth
language plpgsql
security definer
set search_path = public
as $$
declare
  row_ public.fomoguard_growth;
  answers int[] := array[0,0,0,0,0,0,1,1,2,3,2,3,1,1,2,3,2,3,1,1,2,3,2,3];
  today_idx int := (extract(epoch from now())::bigint / 86400) % array_length(answers,1);
  is_correct boolean := (p_picked_idx = answers[today_idx+1]);
begin
  perform public._ensure_growth_row();
  update public.fomoguard_growth
    set quiz_picked_idx = p_picked_idx,
        quiz_correct = is_correct,
        quiz_answered_date = current_date,
        xp = xp + case when is_correct and quiz_answered_date is distinct from current_date then 25 else 0 end,
        updated_at = now()
    where user_id = auth.uid() and quiz_answered_date is distinct from current_date;
  select * into row_ from public.fomoguard_growth where user_id = auth.uid();
  return row_;
end;
$$;
grant execute on function public.submit_quiz_xp(int) to authenticated;
