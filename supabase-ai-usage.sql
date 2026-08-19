-- 무료 AI 하루 사용량 추적 테이블 + RPC
-- Supabase 대시보드 → SQL Editor에서 실행하세요.

create table if not exists public.fomoguard_ai_usage (
  user_id uuid not null references auth.users(id) on delete cascade,
  usage_date date not null,
  count int not null default 0,
  primary key (user_id, usage_date)
);
alter table public.fomoguard_ai_usage enable row level security;
create policy "select own ai usage" on public.fomoguard_ai_usage for select using (auth.uid() = user_id);

create or replace function public.increment_ai_usage(p_cap int)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count int;
  v_updated int;
begin
  insert into public.fomoguard_ai_usage (user_id, usage_date, count)
  values (auth.uid(), current_date, 1)
  on conflict (user_id, usage_date) do update
    set count = fomoguard_ai_usage.count + 1
    where fomoguard_ai_usage.count < p_cap
  returning count into v_count;

  get diagnostics v_updated = row_count;

  if v_updated = 0 then
    raise exception 'AI_DAILY_CAP_EXCEEDED';
  end if;

  return v_count;
end;
$$;

grant execute on function public.increment_ai_usage(int) to authenticated;
