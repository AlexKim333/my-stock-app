# OCR 정답 세트

`npm run test:ocr`이 이 폴더의 케이스를 실제 Gemini로 읽혀 정답과 비교합니다.

## 폴더

| 위치 | 내용 | git |
|---|---|---|
| `cases/<이름>/` | 직접 그린 합성 샘플 | 커밋됨 |
| `private/<이름>/` | 실제 고객 주문서·송장·실사표 사진 | **커밋 안 됨** (.gitignore) |

실제 사진에는 고객 이름이 들어 있으므로 `private/`에 넣으세요. 평가 정확도는 실제 사진 20~50장이 있어야 의미가 있습니다.

## 실제 사진 자동 수집

앱에서 스캔하고 **제출까지 마친** 건은 [사진, 당시 AI 판독, 사람이 확정한 품목]이 Supabase `ocr_samples` 테이블에
자동으로 쌓입니다(최신 200건 보관, 제출 안 한 스캔은 3일 뒤 삭제). 개발 PC에서 아래 명령으로 내려받습니다.

```bash
npm run ocr:pull -- --dry-run      # 받을 대상만 확인
npm run ocr:pull                   # private/<날짜>-<종류>-<id>/ 로 내려받기 (이미 받은 건 건너뜀)
npm run ocr:pull -- --delete-pulled  # 내려받은 뒤 DB에서 삭제 (DB 용량 절약)
```

- Supabase CLI 로그인·링크(`npx supabase login`, `npx supabase link`)가 필요합니다. 앱의 anon 키로는 이 테이블을 읽을 수 없습니다.
- 내려받은 `expected.json`은 제출 결과로 만든 **초안**(`"needs_review": true`)입니다. 직접 입력한 행은 빠지고,
  다른 스캔·직접 입력과 합쳐진 행이 있으면 수량은 비교하지 않습니다. 사진과 대조해 고친 뒤 `"needs_review": false`로 바꾸세요.
  `test:ocr` 결과에는 검토 전 케이스에 "(검토 전)"이 붙습니다.
- 같은 폴더의 `ocr_result.json`은 스캔 당시 AI가 실제로 낸 답입니다.
- 수집을 끄려면 Vercel 환경변수 `OCR_SAMPLE_COLLECT=off`.

## 케이스 직접 추가

1. `private/<이름>/image.jpg`에 사진을 저장합니다. 앱이 보내는 것과 같게 긴 변 1600px 이하 JPEG가 좋습니다.
2. 같은 폴더에 `expected.json`으로 **사람이 확인한 정답**을 적습니다.

```json
{
  "type": "handwritten",
  "note": "무엇을 확인하는 케이스인지 (예: 5와 S를 헷갈리는 글씨)",
  "header": { "branch": "Fernando" },
  "items": [
    { "modelo": "CK928K", "boxes": 1, "pack_qty": 120 },
    { "modelo": "P-160", "color": "NEGRO", "boxes": 3 }
  ]
}
```

- `type`: `handwritten`(출고 주문서), `cartadeporte`(입고 송장), `audit`(재고조사표)
- `items`의 `modelo`(카탈로그 품번)는 필수입니다. `modelo_raw`(종이에 적힌 그대로), `color`, `boxes`, `piezas`,
  `pack_qty`, `uncertain`은 **적은 것만** 비교합니다.
  확실하지 않은 필드는 빼 두면 됩니다.
- 실사표에서 합계만 적힌 여러 품목 줄은 `"uncertain": true`로 적어 두면, 확인 필요 표시가 붙는지까지 검사합니다.
- `header`도 적은 필드만 비교합니다(주문서 `branch`·`requester`, 송장 `date`·`origin_warehouse`, 실사표 `warehouse` 등).

## 실행

```bash
npm run test:ocr                       # 전체 실행
npm run test:ocr -- --filter=audit     # 이름에 audit가 들어간 케이스만
npm run test:ocr -- --runs=3           # 케이스마다 3번 (결과 안정성 확인)
npm run test:ocr -- --update-baseline  # 이번 결과를 비교 기준선으로 저장
npm run test:ocr -- --min-f1=0.9       # 행 F1이 90% 미만이면 종료코드 1
npm run test:ocr -- --no-catalog       # 카탈로그 품번 힌트 없이 실행 (힌트 효과 비교용)
```

`api/ocr.js`는 활성 품목의 품번 목록을 프롬프트 맨 앞에 넣어, 애매한 손글씨를 실제 품번 쪽으로 읽게 합니다.
문제가 생기면 Vercel 환경변수 `OCR_CATALOG_HINT=off`로 재배포 없이 끌 수 있습니다.

점수는 두 가지가 나옵니다.

- **행 F1(판독)**: AI가 읽은 품번을 정답과 그대로 비교합니다. 프롬프트·모델을 바꿨을 때의 효과를 봅니다.
- **행 F1(화면)**: AI 판독을 앱 화면과 같은 매칭(별명 룰북 + 전체 카탈로그)에 통과시킨 뒤 비교합니다. 사용자가 실제로 보는 정확도입니다.
  `불일치 80%↑`는 정답과 다른 품목(또는 정답에 없는 행)이 ⚠️ 없이 표시된 경우라 **0이어야 안전**합니다. 나오면 사진과 대조하세요.
  카탈로그를 읽지 않으려면 `--no-screen`.

프롬프트나 모델을 바꾸기 전에 `--update-baseline`으로 기준선을 저장하고, 바꾼 뒤 다시 실행하면 케이스별로 ⬆️/⬇️가 표시됩니다.
