# CLAUDE.md

이 저장소에서 작업하는 Claude Code(또는 다른 AI 에이전트)가 매번 따라야 하는 검증 절차입니다.
사람이 다시 요청하지 않아도 아래 규칙을 스스로 적용하세요.

## 기능 추가/수정 시 필수 검증

### 1. 코드를 변경했다면 — 항상, 커밋 전에

`index.html`, `searchmodify.html`, `product-ledger.html`, `src/**/*.js` 중 하나라도 수정했다면
커밋하기 전에 반드시 실행하고 통과를 확인하세요:

```bash
npm run verify
```

오프라인 정적 분석이라 빠르고, 아래 4가지를 검사합니다:
- 구문 오류 (Syntax Error)
- `callServer(...)` / `google.script.run.x()` 브릿지 호출과 `supabaseAdapter.js`의 서버 메서드 매핑 누락
- HTML `onclick` 등 인라인 이벤트가 참조하는데 실제로는 정의되지 않은 유령 함수
- 같은 스코프(같은 HTML 페이지, 또는 같은 모듈 파일) 안에서 최상위 함수가 이름이 겹치게 두 번 선언되는 경우 (나중 선언이 이전 것을 조용히 덮어쓰는 회귀 — 실제로 이런 버그가 있었음)

새 JS 파일을 추가했다면 `scripts/verify_integrity.mjs`의 `jsFiles` 목록에도 등록하세요. 등록하지 않으면
그 파일의 `window.x = x` 노출이 인식되지 않아 관련 `onclick` 참조가 전부 "유령 함수"로 오탐됩니다.

### 2. 입고 / 출고 / 이동 / 재고조정 로직(RPC, 재고 계산)을 건드렸다면 — 추가로

이 프로젝트는 로컬/스테이징 Supabase가 없고 프로덕션 DB 하나만 존재합니다. 아래 스크립트로
실제 프로덕션을 상대로 핵심 흐름(입고 → 이동 → 이동복귀 → 출고 → 재고부족 가드 → 재고조정)을
실제 RPC 호출로 검증하세요:

```bash
npm run smoke
```

- 전용 테스트 창고(`SMOKETEST`, UI에는 비노출)와 전용 테스트 품목(`__SMOKETEST_ITEM__`)만 사용하며,
  실제 상품/창고에는 절대 쓰지 않습니다.
- 매 실행이 재고를 정확히 0으로 되돌리는 왕복 구조라 반복 실행해도 상태가 누적되지 않습니다.
- 실행 전 잔여 재고가 0이 아니면(이전 실행이 비정상 종료된 경우) 스스로 즉시 중단합니다 —
  이 경우 말없이 넘어가지 말고 원인을 먼저 확인하세요.
- `.env.local`의 `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY`가 필요합니다.
- `npm run verify`와 달리 네트워크로 실제 프로덕션에 쓰기 작업을 하므로, 매번 자동으로 돌리는
  게 아니라 입출고/이동/조정 로직을 건드렸을 때만 수동으로 실행합니다.

### 3. UI를 변경했다면

가능하면 dev 서버(`preview_start` / `npm run dev`)를 열어 실제로 클릭해서 확인하세요.
타입체크나 `npm run verify` 통과가 "기능이 실제로 동작한다"를 보증하지는 않습니다.

## 하지 말아야 할 것

- 위 검증을 건너뛰고 커밋하지 마세요.
- `npm run smoke`가 실행 전 잔여 재고를 이유로 스스로 중단했다면, 강제로 재실행하거나 데이터를
  임의로 덮어쓰지 말고 먼저 원인을 확인하세요.
- Supabase 마이그레이션은 `supabase db push` 전에 반드시 `npx supabase migration list`로
  로컬/원격 목록이 정확히 일치하는지 확인하세요. 과거 옛 마이그레이션이 재실행되어 함수/정책이
  퇴행한 사고가 있었습니다 (로컬/스테이징 DB가 없어 이 프로젝트의 Supabase는 항상 프로덕션입니다).
- 테스트 중 임시로 만든 거래처/창고/작업자/품목은 정리하세요. `partners`/`warehouses`/`app_members`/
  `items` 등은 anon 키로 하드 삭제가 막혀 있으므로(RLS가 SELECT만 허용), 비활성화(`is_active=false`)로
  충분하거나, 완전히 지워야 한다면 `npx supabase db query --linked`로 직접 처리하세요.
