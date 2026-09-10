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
  quiz_picked_0 int,
  quiz_correct_0 boolean,
  quiz_picked_1 int,
  quiz_correct_1 boolean,
  quiz_picked_2 int,
  quiz_correct_2 boolean,
  updated_at timestamptz not null default now()
);
alter table public.fomoguard_growth enable row level security;
create policy "select own growth" on public.fomoguard_growth for select using (auth.uid() = user_id);
-- insert/update 정책은 의도적으로 만들지 않습니다 (클라이언트가 테이블에 직접 쓸 수 없게).
-- 값 변경은 아래 security definer 함수를 통해서만 가능합니다.

-- 퀴즈가 "하루 1문제"에서 "하루 최대 3문제(슬롯 0~1~2)"로 바뀌면서 기존 단일 컬럼
-- (quiz_correct/quiz_picked_idx)을 슬롯별 3쌍으로 교체한다. 이미 이 테이블을 만들어 쓰고
-- 있는 기존 배포에도 안전하게 적용되도록 add/drop을 idempotent하게 작성했다 — 이 파일을
-- 다시 통째로 실행해도 에러 없이 최신 스키마로 맞춰진다.
alter table public.fomoguard_growth add column if not exists quiz_picked_0 int;
alter table public.fomoguard_growth add column if not exists quiz_correct_0 boolean;
alter table public.fomoguard_growth add column if not exists quiz_picked_1 int;
alter table public.fomoguard_growth add column if not exists quiz_correct_1 boolean;
alter table public.fomoguard_growth add column if not exists quiz_picked_2 int;
alter table public.fomoguard_growth add column if not exists quiz_correct_2 boolean;
alter table public.fomoguard_growth drop column if exists quiz_correct;
alter table public.fomoguard_growth drop column if exists quiz_picked_idx;

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

-- 오늘의 퀴즈 정답은 서버가 직접 판정합니다 (클라이언트가 "정답이었다"고 우겨도
-- 서버가 자체 정답표와 비교해서 아니면 지급하지 않습니다).
-- 이 answers 배열은 "그날 화면에 섞여서 표시되는 보기 중 몇 번째가 정답인가"만 담고
-- 있습니다 — index.html의 모든 퀴즈 문항이 answer:0(정답이 원본 데이터의 0번)으로
-- 작성돼 있다는 규칙 덕분에, 이 배열은 QUIZ_BANK_*의 문항 내용과 무관하게 오직
-- QUIZ_PERM_TABLE(4개 항목의 24가지 순열 고정 테이블)에서 값 0이 섞인 뒤 몇 번째
-- 자리로 이동하는지만 담으면 됩니다(index.html에서 그대로 옮겨온 것 — 변경되지 않음).
-- p_slot(0~2)은 "하루 3문제 중 몇 번째 슬롯인지"이며, 순열 선택 인덱스는
-- index.html의 dailyQuizSet()과 동일하게 (날짜*3+슬롯) 공식을 그대로 써야 합니다
-- (QUIZ_PERM_TABLE이나 이 공식을 바꾸면 서버·클라이언트 정답 판정이 어긋나는 버그가
-- 재발합니다 - 실제로 한 번 이 문제가 있었음).
drop function if exists public.submit_quiz_xp(int);
create or replace function public.submit_quiz_xp(p_slot int, p_picked_idx int)
returns public.fomoguard_growth
language plpgsql
security definer
set search_path = public
as $$
declare
  row_ public.fomoguard_growth;
  answers int[] := array[0,0,0,0,0,0,1,1,2,3,2,3,1,1,2,3,2,3,1,1,2,3,2,3];
  day_idx bigint := extract(epoch from now())::bigint / 86400;
  perm_idx int := ((day_idx * 3 + p_slot) % array_length(answers,1))::int;
  is_correct boolean := (p_picked_idx = answers[perm_idx+1]);
  already_done boolean;
begin
  if p_slot not in (0,1,2) then
    raise exception 'invalid quiz slot: %', p_slot;
  end if;
  perform public._ensure_growth_row();

  -- 날짜가 바뀌었으면 오늘 몫의 3개 슬롯 상태를 초기화
  update public.fomoguard_growth
    set quiz_picked_0 = null, quiz_correct_0 = null,
        quiz_picked_1 = null, quiz_correct_1 = null,
        quiz_picked_2 = null, quiz_correct_2 = null,
        quiz_answered_date = current_date
    where user_id = auth.uid() and quiz_answered_date is distinct from current_date;

  select case p_slot
    when 0 then quiz_picked_0 is not null
    when 1 then quiz_picked_1 is not null
    else quiz_picked_2 is not null
  end into already_done
  from public.fomoguard_growth where user_id = auth.uid();

  if not already_done then
    update public.fomoguard_growth
      set quiz_picked_0 = case when p_slot = 0 then p_picked_idx else quiz_picked_0 end,
          quiz_correct_0 = case when p_slot = 0 then is_correct else quiz_correct_0 end,
          quiz_picked_1 = case when p_slot = 1 then p_picked_idx else quiz_picked_1 end,
          quiz_correct_1 = case when p_slot = 1 then is_correct else quiz_correct_1 end,
          quiz_picked_2 = case when p_slot = 2 then p_picked_idx else quiz_picked_2 end,
          quiz_correct_2 = case when p_slot = 2 then is_correct else quiz_correct_2 end,
          xp = xp + case when is_correct then 15 else 0 end,
          updated_at = now()
      where user_id = auth.uid();
  end if;

  select * into row_ from public.fomoguard_growth where user_id = auth.uid();
  return row_;
end;
$$;
grant execute on function public.submit_quiz_xp(int, int) to authenticated;
