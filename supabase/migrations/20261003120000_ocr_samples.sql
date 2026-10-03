-- OCR 정답 세트 자동 수집
-- 스캔할 때 사진과 AI 판독 결과를 저장하고, 제출할 때 사람이 확정한 품목을 붙인다.
-- 개발 PC에서 `npm run ocr:pull`로 tests/ocr/private에 내려받아 `npm run test:ocr`의 정답 세트로 쓴다.
--
-- 사진에는 고객 이름이 들어 있으므로:
--  - RLS를 켜고 정책을 두지 않는다. anon/authenticated는 테이블을 직접 읽거나 쓸 수 없고,
--    로그인 세션을 확인하는 아래 RPC 두 개(저장·확정)로만 쓸 수 있다. 읽기용 RPC는 없다.
--    내려받기는 Supabase CLI(`supabase db query --linked`, 프로젝트 관리자 권한)로만 한다.
--  - 최신 200건만 남긴다(약 60MB). 제출되지 않은(확정 없는) 스캔은 3일 뒤 지운다.

CREATE TABLE IF NOT EXISTS public.ocr_samples (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  scan_type    TEXT NOT NULL CHECK (scan_type IN ('handwritten', 'cartadeporte', 'audit')),
  image        BYTEA NOT NULL,
  ocr_result   JSONB NOT NULL,
  used_model   TEXT,
  member_id    UUID,
  confirmed    JSONB,
  confirm_note TEXT,
  confirmed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS ocr_samples_created_at_idx ON public.ocr_samples (created_at DESC);

ALTER TABLE public.ocr_samples ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ocr_samples FROM anon, authenticated;

-- 스캔 직후(api/ocr.js) 호출: 사진과 AI 판독 결과를 저장하고 id를 돌려준다.
CREATE OR REPLACE FUNCTION public.rpc_ocr_sample_create(
  p_scan_type TEXT,
  p_image_b64 TEXT,
  p_ocr_result JSONB,
  p_used_model TEXT
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions
AS $$
DECLARE
  v_member public.app_members;
  v_id UUID;
BEGIN
  v_member := public.fn_require_session();

  IF p_scan_type NOT IN ('handwritten', 'cartadeporte', 'audit') THEN
    RAISE EXCEPTION '알 수 없는 스캔 종류입니다: %', p_scan_type;
  END IF;
  IF p_image_b64 IS NULL OR length(p_image_b64) = 0 OR length(p_image_b64) > 6 * 1024 * 1024 THEN
    RAISE EXCEPTION '이미지 크기가 올바르지 않습니다.';
  END IF;

  INSERT INTO public.ocr_samples (scan_type, image, ocr_result, used_model, member_id)
  VALUES (p_scan_type, decode(p_image_b64, 'base64'), COALESCE(p_ocr_result, '{}'::jsonb), p_used_model, v_member.id)
  RETURNING id INTO v_id;

  -- 보관 정리: 제출되지 않은 스캔은 3일, 전체는 최신 200건까지
  DELETE FROM public.ocr_samples
  WHERE confirmed IS NULL AND created_at < NOW() - INTERVAL '3 days';
  DELETE FROM public.ocr_samples
  WHERE id IN (SELECT id FROM public.ocr_samples ORDER BY created_at DESC OFFSET 200);

  RETURN v_id;
END;
$$;

-- 제출 성공 직후(화면) 호출: 스캔별로 사람이 확정한 품목을 붙인다.
-- p_samples: [{ "id": UUID, "items": [...], "note": TEXT|null }]
-- 최근 2일 안에 만든, 아직 확정되지 않은 스캔만 갱신한다(오래된 표본을 나중에 덮어쓰지 못하게).
CREATE OR REPLACE FUNCTION public.rpc_ocr_sample_confirm(p_samples JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions
AS $$
DECLARE
  v_count INTEGER := 0;
BEGIN
  PERFORM public.fn_require_session();
  IF p_samples IS NULL OR jsonb_typeof(p_samples) <> 'array' THEN
    RETURN jsonb_build_object('success', true, 'count', 0);
  END IF;

  UPDATE public.ocr_samples s
  SET confirmed = x.items,
      confirm_note = x.note,
      confirmed_at = NOW()
  FROM jsonb_to_recordset(p_samples) AS x(id UUID, items JSONB, note TEXT)
  WHERE s.id = x.id
    AND s.confirmed IS NULL
    AND s.created_at > NOW() - INTERVAL '2 days'
    AND jsonb_typeof(x.items) = 'array';

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN jsonb_build_object('success', true, 'count', v_count);
END;
$$;

GRANT EXECUTE ON FUNCTION public.rpc_ocr_sample_create(TEXT, TEXT, JSONB, TEXT) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.rpc_ocr_sample_confirm(JSONB) TO anon, authenticated, service_role;
