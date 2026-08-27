-- 메인 사용자 데이터 테이블 (원칙·포트폴리오·거래내역·일지·설정 등 전부)
-- Supabase 대시보드 → SQL Editor에서 실행하세요.
--
-- 이 파일이 왜 있는가:
--   이 테이블은 서비스의 모든 사용자 데이터가 들어가는 가장 중요한 테이블인데,
--   정작 정의와 RLS 정책이 저장소에 없어서 재생성·마이그레이션 시 보호막을 복원할
--   근거가 남아있지 않았습니다(QA 감사에서 발견). 현재 운영 중인 상태를 그대로 기록해둡니다.
--
-- 안전하게 재실행 가능:
--   테이블은 if not exists, 정책은 drop 후 재생성이라 여러 번 돌려도 데이터가 지워지지 않습니다.

create table if not exists public.fomoguard_data (
  user_id uuid primary key references auth.users(id) on delete cascade,
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.fomoguard_data enable row level security;

-- 핵심 보호막: 본인 행에만 접근 가능.
-- 이 정책이 없으면 익명 키만으로 전 사용자의 포트폴리오와 등록된 API 키까지 읽힙니다.
-- (익명 조회 시 빈 배열, 타인 행 삽입 시 42501로 거부되는 것을 실제로 확인함)
drop policy if exists "select own data" on public.fomoguard_data;
create policy "select own data" on public.fomoguard_data
  for select using (auth.uid() = user_id);

drop policy if exists "insert own data" on public.fomoguard_data;
create policy "insert own data" on public.fomoguard_data
  for insert with check (auth.uid() = user_id);

drop policy if exists "update own data" on public.fomoguard_data;
create policy "update own data" on public.fomoguard_data
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "delete own data" on public.fomoguard_data;
create policy "delete own data" on public.fomoguard_data
  for delete using (auth.uid() = user_id);

-- 참고: 회원탈퇴(/delete-account)는 service_role 키로 이 테이블의 행을 지운 뒤
--   auth.users에서 계정 자체를 삭제합니다. on delete cascade가 걸려 있어
--   계정이 지워지면 남은 행도 함께 정리됩니다.
