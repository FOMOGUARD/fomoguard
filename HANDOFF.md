# 투자워워 (구 포모가드) — 인수인계 메모

마지막 업데이트: 2026-08-20
새 컴퓨터/새 Claude Code 세션에서 이 프로젝트를 이어가려면 이 파일부터 읽으세요.

---

## 1. 프로젝트가 뭔가

- **무엇**: 개인 투자자를 위한 "투자 원칙 지킴이" 웹앱. 충동 매수를 AI가 냉철하게 검증해주는 포모체크, 포트폴리오/현금 관리, 실시간 뉴스, 투자 격언 등을 제공.
- **형태**: 프레임워크 없는 순수 HTML/JS 단일 파일(`index.html`, ~150KB+) + Cloudflare Pages Functions(서버 프록시) 몇 개. 빌드 스텝 없음.
- **타겟**: 투자를 무겁게 느끼는 2030 세대. 톤앤매너는 "쉽고 편하게" + 냉철한 팩트 + 투자 커뮤니티 밈 유머.
- **서비스명**: 아직 확정 안 됨. 현재 코드 전체에 **"투자워워"(가칭)**로 반영되어 있음. 후보: 투자워워(1순위 추천), 포모레이더, 포모스캐너. 결정되면 `grep -n "투자워워" index.html`로 전체 치환하면 됨(전부 화면 텍스트, 로직에 영향 없음).

## 2. 저장소 / 배포

- **GitHub**: https://github.com/FOMOGUARD/fomoguard (브랜치: `main`)
- **현재 운영 도메인**: `https://fomoguard.pages.dev` (Cloudflare Pages, GitHub 연동 → `main` push할 때마다 자동 배포, 보통 15~30초 소요)
- **레거시**: `https://fomoguard.netlify.app` — Netlify는 빌드 크레딧 소진으로 더 이상 신규 배포 안 됨. 롤백 대비용으로 `netlify.toml` / `netlify/functions/`는 코드에 남겨둠 (Cloudflare Functions와 거의 동일한 로직을 이 폴더에도 미러링해서 유지 중).
- **Cloudflare Pages 빌드 설정**: Build output directory = `/` (루트). Functions는 `functions/*.js` 파일 기반 라우팅(파일명 = 경로, 예: `functions/ai-free.js` → `/ai-free`).
- **Cloudflare 환경변수** (대시보드 → 프로젝트 → Settings → Environment variables에 등록되어 있어야 함, Production+Preview 둘 다):
  - `GEMINI_SHARED_KEY` — 무료 AI 티어용 공유 Gemini API 키
  - `SUPABASE_URL`, `SUPABASE_ANON_KEY` — `/ai-free`에서 사용자 로그인 세션 검증용 (index.html에도 동일 값이 하드코딩되어 있음, anon key라 공개되어도 무방)

## 3. 백엔드 / 데이터

- **Supabase** 프로젝트 하나로 인증 + DB 겸용. `index.html` 상단에 `SUPABASE_URL`/`SUPABASE_ANON_KEY` 하드코딩되어 있음(공개 anon key, 문제 없음).
- **로그인**: Google OAuth (Supabase Auth). 로그인 안 해도 전 기능 브라우저 로컬에서 사용 가능.
- **클라우드 동기화 테이블**: `fomoguard_data` (컬럼: `user_id`, `data` jsonb, `updated_at`). RLS로 `auth.uid() = user_id`만 접근 가능 — 실제 익명 접근 테스트로 검증 완료(다른 유저 데이터 절대 안 보임).
  - 동기화 대상(`SYNCABLE_KEYS`): principles, portfolio, journal, transactions, factchecks, snapshots, newsKeywords, cashFlows, **settings**(API 키 포함, 최근에 추가함 — 캐시 삭제/기기 변경해도 로그인만 하면 복원되게 하기 위함).
- **AI 사용량 제한 테이블**: `fomoguard_ai_usage` + RPC `increment_ai_usage(p_cap)` — 하루 3회 무료 AI 사용량 카운트. SQL은 `supabase-ai-usage.sql` 참고.
- **AI 프로바이더**: 기본은 Claude/Gemini/OpenAI/Grok 중 사용자가 본인 키 등록(무제한). 로그인만 한 사용자는 `/ai-free` 프록시를 통해 하루 3회 무료(Gemini, 서버 공유 키 사용, 클라이언트에 키 노출 안 됨).

## 4. 이번 세션에서 한 작업 (최신순, 커밋 기준)

1. **Netlify → Cloudflare Pages 이관**: 크레딧 소진 대응. GitHub 연동으로 자동 배포 세팅, Supabase Redirect URL에 새 도메인 추가 필요했음(사용자가 직접 처리).
2. **현금 입력 USD/KRW 통화 선택 + 실시간 환율 환산 저장**, **투자 격언 113→184개로 확대**, **날짜 고정 로테이션 → 새로고침마다 랜덤**.
3. **뉴스 기능 대수술**:
   - GNews 무료 플랜이 배포 도메인에서 CORS로 직접 호출을 막는 걸 발견 → `/news-proxy` 서버 프록시로 우회.
   - 한글 키워드는 서버에서 영문 번역 후 **국내(한국어 제한) + 해외(번역어, 무제한 언어) 이중 검색**, 결과 병합·중복제거, 비한국어 기사는 제목/요약을 Google Translate 공개 엔드포인트(`translate.googleapis.com`)로 한국어 번역해서 반환.
   - 이중 검색 때문에 GNews 순간 요청제한(429)에 걸리는 문제 발생 → 순차 실행 + 재시도로 해결.
   - "전체 모아보기"(키워드 통합 top10) / "키워드별"(아코디언 접기·펼치기) 두 가지 보기 모드 추가.
   - 헤드라인 호재/악재 자동 배지(키워드 사전 기반 로컬 판정, AI 비용 없음).
   - 캐시 스키마 버전(`NEWS_CACHE_VERSION`) 도입 — 기능 추가 후 예전 캐시가 자동으로 무효화되게.
4. **API 키/설정도 Supabase에 클라우드 동기화** — 브라우저 캐시 삭제해도 로그인만 하면 복원.
5. **마스코트 캐릭터(개미) 도입**:
   - 원본 디자인 시안(그리드 이미지, 개별 PNG 여러 장)을 `sharp`로 배경 제거(플러드필 방식 — 캐릭터 얼굴색이 배경색과 거의 같아서 단순 색상거리 방식은 못 씀, 테두리에서부터 flood fill해서 외곽 배경만 제거)한 뒤 `fomoguard/mascot/`에 개별 스프라이트로 정리.
   - 표정 9종(face-A~I) + 포즈(wave/coin/chart-up/chart-down/lying/point/detective) + 앱 아이콘(icon-192/512).
   - 로그인 화면(인사 포즈), 헤더 미니아이콘, 투자 격언 카드, 포모체크 결과(위배/주의/양호별 표정), 포모체크 로딩(돋보기+레이더 핑 CSS 애니메이션), 투자원칙 빈 화면(가리키는 포즈)에 배치.
   - **대시보드 총 평가자산 카드의 마스코트는 사용자 요청으로 삭제함** (너무 자주 보여서). 재추가하지 말 것.
   - 남은 요청 자산: **엄지척/활짝 웃는 표정** 하나 아직 안 받음(사용자가 만들어서 공유하기로 함) — 받으면 좋은 실적/목표 달성 상황에 쓸 것.
6. **서비스명 전체 리브랜딩**: 포모가드 → 투자워워(가칭), title/헤더/인사말/AI 페르소나/푸터 전부.
7. **대시보드 개선**: "총 손익금액"(실현+평가손익, 입금액 제외) 항목 추가, 코어/알파 수익률 같은 줄 배치.
8. **명대사 패러디 14개** 추가(영화/드라마 유명 대사를 투자 상황으로 각색 — 원본 그대로 인용 아님, 저작권 고려해서 핵심 단어만 바꾼 패러디). 오늘의 격언 풀에 포함 + 포모체크 결과에 판정별(위배/주의→경고톤, 양호→다짐톤)로 노출.
9. **포모체크 기록 다시보기**: 예전엔 "최근 기록" 목록이 클릭 안 되는 정적 목록이었음(버그) → 클릭하면 과거 검증 결과 전체를 다시 열람 가능하도록 수정.
10. **코어/위성 → 코어/알파 명칭 변경**: 표시 텍스트만 변경, 내부 데이터 값(`type: 'satellite'`)은 하위호환 위해 그대로 유지. 새 종목 추가 시 종목명/티커 기반으로 코어/알파를 **로컬 키워드 매칭으로 자동 추천**(AI 호출 없음, 사용자가 직접 select를 바꾸면 그 다음부턴 추천이 끼어들지 않음).

## 5. 알아두면 좋은 함정들

- **캐시 무효화**: `_headers` 파일에서 `/`, `/index.html`은 `Cache-Control: no-cache`. 그런데도 iOS Safari가 예전 버전을 계속 보여주는 경우가 있었음(실제 배포는 최신인데 클라이언트가 옛날 캐시를 서빙) → 사용자에게 Safari 사이트 데이터 삭제를 안내해서 해결. 근본 원인은 명확히 못 찾음, 재발 시 참고.
- **GNews 무료 플랜**: 배포 도메인 직접 CORS 호출 불가(로컬호스트만 허용), 순간 요청 제한 있음 → 반드시 서버 프록시 + 순차 요청 유지할 것.
- **로컬 개발 서버**: `.claude/launch.json`에 `fomoguard` 설정 있음 (`npx serve fomoguard -l 5544`). `/ai-free`, `/news-proxy` 같은 Functions는 로컬 static 서버에서는 404남(정상, Cloudflare에만 존재) — 실제 동작 확인은 배포 후 `curl`로 검증하는 방식으로 진행함.
- **이미지 처리**: 프로젝트 루트 `node_modules`에 `sharp` 설치되어 있어서 마스코트 자산 가공에 사용함(`NODE_PATH`를 프로젝트 node_modules로 지정하고 스크립트 실행). sharp의 raw buffer 체이닝에서 `extract().trim()`을 한 파이프라인에 묶으면 에러 나는 경우가 있었음 → 두 단계로 분리(encode 후 재로드)하면 해결됨.
- **JS 코드 문법 검사**: `index.html`의 `<script>` 블록만 추출해서 `node --check`로 검증하는 방식을 계속 사용함(별도 빌드 도구 없음).

## 6. 다음에 하면 좋을 것들 (미결 아이디어, 확정 아님)

- 서비스명 최종 확정 → 전체 치환 + 도메인/GitHub repo 이름도 바꿀지 결정
- 엄지척 표정 마스코트 받으면 실적 달성 등 긍정 상황에 배치
- 파비콘/PWA 아이콘이 `icon-192.png` 하나뿐 — apple-touch-icon 별도 사이즈, manifest.json(PWA 설치 지원) 아직 없음
- 커스텀 도메인 연결(현재 `pages.dev` 서브도메인만 사용 중)

## 7. 새 세션 시작 명령어 참고

```bash
git clone https://github.com/FOMOGUARD/fomoguard.git
cd fomoguard
git log --oneline -20   # 최근 작업 확인
```
그 다음 Claude Code에게 "이 HANDOFF.md 읽고 투자워워 프로젝트 이어서 진행할게" 라고 말하면 됨.
