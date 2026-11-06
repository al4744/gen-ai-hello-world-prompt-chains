-- REVIEW ONLY. Never executed by the implementation session.
-- Read EXECUTION_PERSISTENCE.md and execution_preflight.sql before installation.
-- No existing application table, trigger, policy or step-management RPC is changed.
BEGIN;

DO $preflight$
DECLARE v_name text;
BEGIN
  -- The narrowly scoped definer functions below deliberately have an explicit,
  -- trusted installation owner. Do not install as an application/API role.
  IF current_user <> 'postgres' THEN
    RAISE EXCEPTION 'Review/install as postgres; do not silently change function ownership';
  END IF;
  IF pg_catalog.to_regprocedure('pg_catalog.gen_random_uuid()') IS NULL
     OR pg_catalog.to_regprocedure('pg_catalog.sha256(bytea)') IS NULL THEN
    RAISE EXCEPTION 'Required core UUID/SHA256 functions are unavailable';
  END IF;
  FOREACH v_name IN ARRAY ARRAY['profiles', 'prompt_chains', 'prompt_chain_steps'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
                   WHERE n.nspname = 'public' AND c.relname = v_name AND c.relrowsecurity) THEN
      RAISE EXCEPTION 'Required source table/RLS is unavailable: %', v_name;
    END IF;
  END LOOP;
  IF pg_catalog.to_regclass('public.prompt_chain_runs') IS NOT NULL
     OR pg_catalog.to_regclass('public.prompt_chain_run_steps') IS NOT NULL
     OR EXISTS (SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
                WHERE n.nspname = 'public' AND p.proname IN (
                  'prompt_chain_execution_is_superadmin_v1', 'prepare_prompt_chain_run_v1',
                  'advance_prompt_chain_run_v1', 'prompt_chain_execution_media_access_v1')) THEN
    RAISE EXCEPTION 'Execution object collision; inspect rather than replacing existing objects';
  END IF;
  IF EXISTS (SELECT 1 FROM storage.buckets WHERE id = 'prompt-chain-execution-media' OR name = 'prompt-chain-execution-media') THEN
    RAISE EXCEPTION 'Execution bucket collision; install guards before independently creating the new bucket';
  END IF;
  -- Detailed column, FK, grant, trigger and Storage checks are in the preflight.
  -- UUID FKs/type resolution below also fail atomically on incompatible schemas.
END;
$preflight$;

CREATE TABLE public.prompt_chain_runs (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  original_chain_id uuid NOT NULL,
  current_chain_id uuid REFERENCES public.prompt_chains(id) ON DELETE SET NULL,
  chain_name text NOT NULL,
  chain_slug text NOT NULL,
  step_snapshot jsonb NOT NULL CHECK (pg_catalog.jsonb_typeof(step_snapshot) = 'array'),
  snapshot_sha256 text NOT NULL CHECK (snapshot_sha256 ~ '^[a-f0-9]{64}$'),
  execution_mode text NOT NULL CHECK (execution_mode IN ('composed', 'sequential')),
  execution_version integer NOT NULL DEFAULT 1 CHECK (execution_version = 1),
  invocation_count integer NOT NULL CHECK (invocation_count BETWEEN 1 AND 5),
  creator_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  creator_id_snapshot uuid NOT NULL,
  idempotency_key uuid NOT NULL,
  request_fingerprint text NOT NULL CHECK (request_fingerprint ~ '^[a-f0-9]{64}$'),
  input_mime text NOT NULL CHECK (input_mime IN ('image/jpeg', 'image/png', 'image/webp')),
  input_size_bytes bigint NOT NULL CHECK (input_size_bytes BETWEEN 1 AND 5242880),
  input_sha256 text NOT NULL CHECK (input_sha256 ~ '^[a-f0-9]{64}$'),
  input_path text NOT NULL,
  user_context text NOT NULL DEFAULT '' CHECK (pg_catalog.char_length(user_context) <= 500),
  -- v1 deliberately pins the existing free text router. A paid/model change
  -- needs a reviewed contract, not a caller-supplied arbitrary model identifier.
  requested_model text NOT NULL DEFAULT 'openrouter/free' CHECK (requested_model = 'openrouter/free'),
  request_config jsonb NOT NULL DEFAULT '{"provider":"openrouter","max_completion_tokens":2000}',
  final_text text CHECK (pg_catalog.octet_length(final_text) <= 32768),
  artifact_path text NOT NULL,
  artifact_sha256 text CHECK (artifact_sha256 ~ '^[a-f0-9]{64}$'),
  artifact_size_bytes bigint CHECK (artifact_size_bytes BETWEEN 1 AND 5242880),
  status text NOT NULL DEFAULT 'prepared' CHECK (status IN ('prepared', 'running', 'succeeded', 'failed', 'interrupted')),
  error_code text,
  error_message text,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  started_at timestamptz,
  completed_at timestamptz,
  deadline_at timestamptz NOT NULL,
  lease_token_hash bytea,
  CONSTRAINT prompt_chain_runs_idempotency UNIQUE (creator_id_snapshot, idempotency_key),
  CHECK (current_chain_id IS NULL OR current_chain_id = original_chain_id),
  CHECK (creator_id IS NULL OR creator_id = creator_id_snapshot),
  CHECK (pg_catalog.octet_length(step_snapshot::text) <= 65536),
  CHECK ((execution_mode = 'composed' AND chain_slug = 'caption-arena-default'
          AND pg_catalog.jsonb_array_length(step_snapshot) = 4 AND invocation_count = 1)
      OR (execution_mode = 'sequential' AND chain_slug <> 'caption-arena-default'
          AND invocation_count = pg_catalog.jsonb_array_length(step_snapshot))),
  CHECK (input_path = creator_id_snapshot::text || '/' || id::text || '/input.' ||
    CASE input_mime WHEN 'image/jpeg' THEN 'jpg' WHEN 'image/png' THEN 'png' ELSE 'webp' END),
  CHECK (artifact_path = creator_id_snapshot::text || '/' || id::text || '/captioned.png'),
  CHECK ((status IN ('prepared', 'running') AND completed_at IS NULL AND error_code IS NULL AND error_message IS NULL)
      OR (status = 'succeeded' AND completed_at IS NOT NULL AND final_text IS NOT NULL
          AND artifact_sha256 IS NOT NULL AND artifact_size_bytes IS NOT NULL AND error_code IS NULL AND error_message IS NULL)
      OR (status IN ('failed', 'interrupted') AND completed_at IS NOT NULL AND error_code IS NOT NULL AND error_message IS NOT NULL)),
  CHECK (status <> 'running' OR (started_at IS NOT NULL AND lease_token_hash IS NOT NULL)),
  CHECK (status <> 'prepared' OR (started_at IS NULL AND lease_token_hash IS NULL)),
  CHECK (status NOT IN ('succeeded', 'failed', 'interrupted') OR lease_token_hash IS NULL),
  CHECK (completed_at IS NULL OR completed_at >= created_at),
  CHECK (started_at IS NULL OR started_at >= created_at)
);

CREATE INDEX prompt_chain_runs_history ON public.prompt_chain_runs (original_chain_id, created_at DESC, id DESC);
CREATE INDEX prompt_chain_runs_creator ON public.prompt_chain_runs (creator_id_snapshot, created_at DESC);
CREATE UNIQUE INDEX prompt_chain_runs_one_active ON public.prompt_chain_runs (creator_id_snapshot) WHERE status = 'running';

CREATE TABLE public.prompt_chain_run_steps (
  run_id uuid NOT NULL REFERENCES public.prompt_chain_runs(id) ON DELETE RESTRICT,
  execution_position integer NOT NULL CHECK (execution_position BETWEEN 1 AND 5),
  -- No FK to live steps: the immutable parent snapshot is authoritative.
  -- NULL for the one composed invocation, which consumes all four sections.
  source_step_id uuid,
  submitted_context jsonb CHECK (pg_catalog.jsonb_typeof(submitted_context) = 'object'
                               AND pg_catalog.octet_length(submitted_context::text) <= 1048576),
  output_text text CHECK (pg_catalog.octet_length(output_text) <= 32768),
  output_truncated boolean NOT NULL DEFAULT false,
  actual_model text CHECK (pg_catalog.char_length(actual_model) BETWEEN 1 AND 200),
  provider_response_id text CHECK (pg_catalog.char_length(provider_response_id) <= 200),
  provider_http_status integer CHECK (provider_http_status BETWEEN 100 AND 599),
  finish_reason text CHECK (finish_reason ~ '^[A-Za-z0-9_-]{1,80}$'),
  prompt_tokens bigint CHECK (prompt_tokens BETWEEN 0 AND 2147483647),
  completion_tokens bigint CHECK (completion_tokens BETWEEN 0 AND 2147483647),
  total_tokens bigint CHECK (total_tokens BETWEEN 0 AND 2147483647),
  cost_usd numeric(16,8) CHECK (cost_usd >= 0),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'succeeded', 'failed', 'skipped', 'interrupted')),
  error_code text,
  error_message text,
  started_at timestamptz,
  completed_at timestamptz,
  PRIMARY KEY (run_id, execution_position),
  CHECK (status <> 'running' OR (started_at IS NOT NULL AND submitted_context IS NOT NULL AND completed_at IS NULL)),
  CHECK (status <> 'succeeded' OR (submitted_context IS NOT NULL AND output_text IS NOT NULL
    AND output_text ~ '[^[:space:]]' AND NOT output_truncated AND actual_model IS NOT NULL
    AND started_at IS NOT NULL AND completed_at IS NOT NULL AND error_code IS NULL AND error_message IS NULL)),
  CHECK (status NOT IN ('failed', 'skipped', 'interrupted') OR (completed_at IS NOT NULL AND error_code IS NOT NULL AND error_message IS NOT NULL)),
  CHECK (status <> 'pending' OR (started_at IS NULL AND completed_at IS NULL AND submitted_context IS NULL)),
  CHECK (status NOT IN ('pending', 'running') OR (error_code IS NULL AND error_message IS NULL)),
  CHECK (completed_at IS NULL OR started_at IS NULL OR completed_at >= started_at)
);

CREATE UNIQUE INDEX prompt_chain_run_steps_one_active ON public.prompt_chain_run_steps (run_id) WHERE status = 'running';

ALTER TABLE public.prompt_chain_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.prompt_chain_runs FORCE ROW LEVEL SECURITY;
ALTER TABLE public.prompt_chain_run_steps ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.prompt_chain_run_steps FORCE ROW LEVEL SECURITY;

CREATE FUNCTION public.prompt_chain_execution_is_superadmin_v1()
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY INVOKER
SET search_path = pg_catalog SET row_security = on
AS $function$
BEGIN
  IF auth.uid() IS NULL OR auth.role() IS DISTINCT FROM 'authenticated' THEN RETURN false; END IF;
  RETURN EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.is_superadmin IS TRUE);
END;
$function$;

CREATE POLICY prompt_chain_runs_read ON public.prompt_chain_runs FOR SELECT TO authenticated
USING (public.prompt_chain_execution_is_superadmin_v1());
CREATE POLICY prompt_chain_run_steps_read ON public.prompt_chain_run_steps FOR SELECT TO authenticated
USING (public.prompt_chain_execution_is_superadmin_v1());

REVOKE ALL ON TABLE public.prompt_chain_runs, public.prompt_chain_run_steps FROM PUBLIC, anon, authenticated, service_role;
-- Do not grant table-level SELECT on runs: the lease hash is internal.
GRANT SELECT (id, original_chain_id, current_chain_id, chain_name, chain_slug,
  step_snapshot, snapshot_sha256, execution_mode, execution_version, invocation_count,
  creator_id, creator_id_snapshot, idempotency_key, request_fingerprint,
  input_mime, input_size_bytes, input_sha256, input_path, user_context,
  requested_model, request_config, final_text, artifact_path, artifact_sha256,
  artifact_size_bytes, status, error_code, error_message, created_at, started_at,
  completed_at, deadline_at) ON public.prompt_chain_runs TO authenticated;
GRANT SELECT ON TABLE public.prompt_chain_run_steps TO authenticated;

CREATE FUNCTION public.prepare_prompt_chain_run_v1(
  p_chain_id uuid, p_idempotency_key uuid, p_input_mime text,
  p_input_size_bytes bigint, p_input_sha256 text, p_user_context text DEFAULT ''
)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog SET row_security = on SET lock_timeout = '5s'
AS $function$
DECLARE
  v_user uuid := auth.uid();
  v_chain record;
  v_steps jsonb;
  v_count integer;
  v_mode text;
  v_fingerprint text;
  v_snapshot_hash text;
  v_existing public.prompt_chain_runs%ROWTYPE;
  v_id uuid := pg_catalog.gen_random_uuid();
  v_prefix text;
  v_now timestamptz;
BEGIN
  IF v_user IS NULL OR auth.role() IS DISTINCT FROM 'authenticated'
     OR NOT EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = v_user AND p.is_superadmin IS TRUE) THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'superadmin_required';
  END IF;
  IF p_chain_id IS NULL OR p_idempotency_key IS NULL OR p_input_mime IS NULL
     OR p_input_mime NOT IN ('image/jpeg', 'image/png', 'image/webp')
     OR p_input_size_bytes IS NULL OR p_input_size_bytes NOT BETWEEN 1 AND 5242880
     OR p_input_sha256 IS NULL OR p_input_sha256 !~ '^[a-f0-9]{64}$'
     OR p_user_context IS NULL OR pg_catalog.char_length(p_user_context) > 500 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid_run_input';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM storage.buckets b WHERE b.id = 'prompt-chain-execution-media'
                AND b.public IS FALSE AND b.file_size_limit = 5242880
                AND b.allowed_mime_types @> ARRAY['image/jpeg', 'image/png', 'image/webp']::text[]
                AND pg_catalog.cardinality(b.allowed_mime_types) = 3) THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'private_execution_bucket_unavailable';
  END IF;
  IF (SELECT pg_catalog.count(*) FROM pg_catalog.pg_policies WHERE schemaname = 'storage' AND tablename = 'objects'
      AND policyname IN ('pc_execution_select_guard', 'pc_execution_insert_guard', 'pc_execution_update_guard',
        'pc_execution_delete_guard', 'pc_execution_media_read', 'pc_execution_media_insert')) <> 6 THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'execution_storage_policies_unavailable';
  END IF;
  v_fingerprint := pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.jsonb_build_object(
    'chain_id', p_chain_id, 'input_mime', p_input_mime, 'input_size_bytes', p_input_size_bytes,
    'input_sha256', p_input_sha256, 'user_context', p_user_context, 'execution_version', 1)::text, 'UTF8')), 'hex');
  -- Shared with claim: concurrent preparations/claims by one creator serialize.
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('prompt-chain-execution:' || v_user::text, 0));
  SELECT * INTO v_existing FROM public.prompt_chain_runs
    WHERE creator_id_snapshot = v_user AND idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF v_existing.request_fingerprint <> v_fingerprint THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'idempotency_input_conflict';
    END IF;
    RETURN pg_catalog.jsonb_build_object('run_id', v_existing.id, 'status', v_existing.status,
      'input_path', v_existing.input_path, 'artifact_path', v_existing.artifact_path, 'created', false);
  END IF;
  SELECT id, name, slug INTO v_chain FROM public.prompt_chains WHERE id = p_chain_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'chain_unavailable'; END IF;
  SELECT pg_catalog.count(*)::integer INTO v_count FROM (
    SELECT 1 FROM public.prompt_chain_steps WHERE chain_id = p_chain_id LIMIT 6
  ) bounded_steps;
  IF v_count NOT BETWEEN 1 AND 5 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'chain_outside_execution_limits';
  END IF;
  -- Same parent-first/UUID child lock order as installed v1/v2, including edits.
  PERFORM s.id FROM public.prompt_chain_steps s WHERE s.chain_id = p_chain_id ORDER BY s.id FOR UPDATE;
  SELECT pg_catalog.count(*)::integer,
    COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('id', s.id, 'step_order', s.step_order,
      'name', s.name, 'prompt_template', s.prompt_template) ORDER BY s.step_order, s.id), '[]'::jsonb)
    INTO v_count, v_steps FROM public.prompt_chain_steps s WHERE s.chain_id = p_chain_id;
  IF v_count NOT BETWEEN 1 AND 5 OR pg_catalog.octet_length(v_steps::text) > 65536 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'chain_outside_execution_limits';
  END IF;
  v_mode := CASE WHEN v_chain.slug = 'caption-arena-default' THEN 'composed' ELSE 'sequential' END;
  IF v_mode = 'composed' AND (v_count <> 4
     OR (SELECT pg_catalog.jsonb_agg(value -> 'step_order' ORDER BY n)
         FROM pg_catalog.jsonb_array_elements(v_steps) WITH ORDINALITY e(value, n)) <> '[1,2,3,4]'::jsonb
     OR pg_catalog.strpos(v_steps -> 2 ->> 'prompt_template', '{{user_prompt}}') = 0
     OR EXISTS (SELECT 1 FROM pg_catalog.jsonb_array_elements(v_steps) WITH ORDINALITY e(value, n)
                WHERE n <> 3 AND pg_catalog.strpos(value ->> 'prompt_template', '{{user_prompt}}') > 0)) THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'default_prompt_contract_unavailable';
  END IF;
  v_snapshot_hash := pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.jsonb_build_object(
    'chain_id', v_chain.id, 'name', v_chain.name, 'slug', v_chain.slug, 'steps', v_steps)::text, 'UTF8')), 'hex');
  v_prefix := v_user::text || '/' || v_id::text;
  v_now := pg_catalog.clock_timestamp();
  INSERT INTO public.prompt_chain_runs (id, original_chain_id, current_chain_id, chain_name, chain_slug,
    step_snapshot, snapshot_sha256, execution_mode, invocation_count, creator_id, creator_id_snapshot,
    idempotency_key, request_fingerprint, input_mime, input_size_bytes, input_sha256, input_path,
    user_context, artifact_path, created_at, deadline_at)
  VALUES (v_id, v_chain.id, v_chain.id, v_chain.name, v_chain.slug, v_steps, v_snapshot_hash, v_mode,
    CASE WHEN v_mode = 'composed' THEN 1 ELSE v_count END, v_user, v_user, p_idempotency_key,
    v_fingerprint, p_input_mime, p_input_size_bytes, p_input_sha256,
    v_prefix || '/input.' || CASE p_input_mime WHEN 'image/jpeg' THEN 'jpg' WHEN 'image/png' THEN 'png' ELSE 'webp' END,
    p_user_context, v_prefix || '/captioned.png', v_now, v_now + interval '30 minutes');
  INSERT INTO public.prompt_chain_run_steps (run_id, execution_position, source_step_id)
    SELECT v_id, n, CASE WHEN v_mode = 'sequential' THEN (v_steps -> (n - 1) ->> 'id')::uuid ELSE NULL END
    FROM pg_catalog.generate_series(1, CASE WHEN v_mode = 'composed' THEN 1 ELSE v_count END) n;
  RETURN pg_catalog.jsonb_build_object('run_id', v_id, 'status', 'prepared',
    'input_path', v_prefix || '/input.' || CASE p_input_mime WHEN 'image/jpeg' THEN 'jpg' WHEN 'image/png' THEN 'png' ELSE 'webp' END,
    'artifact_path', v_prefix || '/captioned.png', 'created', true);
END;
$function$;

CREATE FUNCTION public.advance_prompt_chain_run_v1(
  p_run_id uuid, p_operation text, p_lease_token text DEFAULT NULL, p_payload jsonb DEFAULT '{}'::jsonb
)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog SET row_security = on SET lock_timeout = '5s'
AS $function$
DECLARE
  v_user uuid := auth.uid();
  v_run public.prompt_chain_runs%ROWTYPE;
  v_step public.prompt_chain_run_steps%ROWTYPE;
  v_now timestamptz;
  v_token text;
  v_position integer;
  v_allowed text[];
  v_key text;
  v_prompt text;
  v_previous jsonb;
  v_context jsonb;
  v_output text;
  v_parsed jsonb;
  v_invalid boolean := false;
  v_truncated boolean := false;
  v_code text;
  v_message text;
BEGIN
  IF v_user IS NULL OR auth.role() IS DISTINCT FROM 'authenticated'
     OR NOT EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = v_user AND p.is_superadmin IS TRUE) THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'superadmin_required';
  END IF;
  IF p_run_id IS NULL OR p_operation IS NULL OR p_operation NOT IN
    ('claim', 'start_step', 'complete_step', 'finalize', 'fail', 'expire')
    OR p_payload IS NULL OR pg_catalog.jsonb_typeof(p_payload) <> 'object'
    OR pg_catalog.octet_length(p_payload::text) > 262144 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid_run_operation';
  END IF;
  v_allowed := CASE p_operation
    WHEN 'claim' THEN ARRAY['verified_input_sha256']
    WHEN 'start_step' THEN ARRAY['position']
    WHEN 'complete_step' THEN ARRAY['position', 'output_text', 'actual_model', 'provider_response_id',
      'provider_http_status', 'finish_reason', 'prompt_tokens', 'completion_tokens', 'total_tokens', 'cost_usd']
    WHEN 'finalize' THEN ARRAY['artifact_sha256']
    WHEN 'fail' THEN ARRAY['error_code', 'output_text', 'actual_model', 'provider_response_id',
      'provider_http_status', 'finish_reason', 'prompt_tokens', 'completion_tokens', 'total_tokens', 'cost_usd']
    ELSE ARRAY[]::text[] END;
  IF EXISTS (SELECT 1 FROM pg_catalog.jsonb_object_keys(p_payload) k WHERE NOT (k = ANY(v_allowed))) THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'unexpected_run_fields';
  END IF;
  -- Same lock order in every operation; no lock spans a provider/API call.
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('prompt-chain-execution:' || v_user::text, 0));
  SELECT * INTO v_run FROM public.prompt_chain_runs WHERE id = p_run_id FOR UPDATE;
  IF NOT FOUND OR v_run.creator_id IS DISTINCT FROM v_user THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'run_unavailable';
  END IF;
  v_now := pg_catalog.clock_timestamp();
  IF v_run.status NOT IN ('prepared', 'running') THEN
    -- A retry can observe completion, but cannot mutate a terminal record.
    RETURN pg_catalog.jsonb_build_object('run_id', v_run.id, 'status', v_run.status, 'accepted', false);
  END IF;
  IF v_run.deadline_at <= v_now THEN
    UPDATE public.prompt_chain_run_steps SET status = CASE WHEN status = 'running' THEN 'interrupted' ELSE 'skipped' END,
      completed_at = v_now, error_code = 'execution_expired', error_message = 'Execution expired before completion.'
      WHERE run_id = v_run.id AND status IN ('pending', 'running');
    UPDATE public.prompt_chain_runs SET status = 'interrupted', completed_at = v_now,
      error_code = 'execution_expired', error_message = 'Execution expired before completion.', lease_token_hash = NULL
      WHERE id = v_run.id;
    RETURN pg_catalog.jsonb_build_object('run_id', v_run.id, 'status', 'interrupted', 'accepted', false);
  END IF;
  IF p_operation = 'expire' THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'run_has_not_expired';
  END IF;
  IF p_operation = 'claim' THEN
    IF v_run.status <> 'prepared' THEN
      RETURN pg_catalog.jsonb_build_object('run_id', v_run.id, 'status', v_run.status, 'accepted', false);
    END IF;
    IF v_run.current_chain_id IS NULL THEN
      RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'chain_deleted_before_execution';
    END IF;
    IF pg_catalog.jsonb_typeof(p_payload -> 'verified_input_sha256') IS DISTINCT FROM 'string'
       OR p_payload ->> 'verified_input_sha256' IS DISTINCT FROM v_run.input_sha256 THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'input_verification_required';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM storage.objects o WHERE o.bucket_id = 'prompt-chain-execution-media'
      AND o.name = v_run.input_path AND o.owner_id = v_user::text
      AND o.metadata ->> 'mimetype' = v_run.input_mime
      AND CASE WHEN o.metadata ->> 'size' ~ '^[0-9]{1,8}$' THEN (o.metadata ->> 'size')::bigint ELSE -1 END = v_run.input_size_bytes) THEN
      RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'uploaded_input_unavailable';
    END IF;
    IF EXISTS (SELECT 1 FROM public.prompt_chain_runs WHERE creator_id_snapshot = v_user AND status = 'running') THEN
      RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'another_run_is_active';
    END IF;
    v_token := pg_catalog.replace(pg_catalog.gen_random_uuid()::text || pg_catalog.gen_random_uuid()::text, '-', '');
    UPDATE public.prompt_chain_runs SET status = 'running', started_at = v_now,
      deadline_at = v_now + interval '120 seconds', lease_token_hash = pg_catalog.sha256(pg_catalog.convert_to(v_token, 'UTF8'))
      WHERE id = v_run.id;
    RETURN pg_catalog.jsonb_build_object('run_id', v_run.id, 'status', 'running', 'accepted', true,
      'lease_token', v_token, 'deadline_at', v_now + interval '120 seconds');
  END IF;
  -- A prepared upload/validation failure can be recorded without claiming it.
  IF NOT (p_operation = 'fail' AND v_run.status = 'prepared') THEN
    IF v_run.status <> 'running' OR p_lease_token IS NULL OR p_lease_token !~ '^[a-f0-9]{64}$'
       OR v_run.lease_token_hash IS DISTINCT FROM pg_catalog.sha256(pg_catalog.convert_to(p_lease_token, 'UTF8')) THEN
      RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'valid_execution_lease_required';
    END IF;
  END IF;
  IF p_operation IN ('start_step', 'complete_step') THEN
    IF pg_catalog.jsonb_typeof(p_payload -> 'position') IS DISTINCT FROM 'number'
       OR p_payload ->> 'position' !~ '^[1-5]$' THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid_execution_position';
    END IF;
    v_position := (p_payload ->> 'position')::integer;
    SELECT * INTO v_step FROM public.prompt_chain_run_steps
      WHERE run_id = v_run.id AND execution_position = v_position FOR UPDATE;
    IF NOT FOUND OR EXISTS (SELECT 1 FROM public.prompt_chain_run_steps
      WHERE run_id = v_run.id AND execution_position < v_position AND status <> 'succeeded') THEN
      RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'execution_order_conflict';
    END IF;
  END IF;
  -- The same bounded metadata can accompany a failed provider invocation.
  -- Unknown optional values must be omitted, rather than sent as JSON null.
  IF p_operation IN ('complete_step', 'fail') THEN
    IF (p_operation = 'complete_step' AND
        (pg_catalog.jsonb_typeof(p_payload -> 'output_text') IS DISTINCT FROM 'string'
         OR pg_catalog.jsonb_typeof(p_payload -> 'actual_model') IS DISTINCT FROM 'string'))
       OR (p_payload ? 'output_text' AND pg_catalog.jsonb_typeof(p_payload -> 'output_text') <> 'string')
       OR (p_payload ? 'actual_model' AND (pg_catalog.jsonb_typeof(p_payload -> 'actual_model') <> 'string'
           OR pg_catalog.char_length(p_payload ->> 'actual_model') NOT BETWEEN 1 AND 200
           OR p_payload ->> 'actual_model' !~ '[^[:space:]]'))
       OR (p_payload ? 'provider_response_id' AND (pg_catalog.jsonb_typeof(p_payload -> 'provider_response_id') <> 'string'
           OR pg_catalog.char_length(p_payload ->> 'provider_response_id') > 200))
       OR (p_payload ? 'finish_reason' AND (pg_catalog.jsonb_typeof(p_payload -> 'finish_reason') <> 'string'
           OR p_payload ->> 'finish_reason' !~ '^[A-Za-z0-9_-]{1,80}$')) THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid_provider_result_metadata';
    END IF;
    FOREACH v_key IN ARRAY ARRAY['prompt_tokens', 'completion_tokens', 'total_tokens', 'provider_http_status'] LOOP
      IF p_payload ? v_key THEN
        IF pg_catalog.jsonb_typeof(p_payload -> v_key) <> 'number' OR p_payload ->> v_key !~ '^[0-9]{1,10}$' THEN
          RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid_usage_metadata';
        END IF;
        IF (p_payload ->> v_key)::numeric > 2147483647
           OR (v_key = 'provider_http_status' AND (p_payload ->> v_key)::numeric NOT BETWEEN 100 AND 599) THEN
          RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid_usage_metadata';
        END IF;
      END IF;
    END LOOP;
    IF p_payload ? 'cost_usd' THEN
      IF pg_catalog.jsonb_typeof(p_payload -> 'cost_usd') <> 'number' THEN
        RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid_cost_metadata';
      END IF;
      IF (p_payload ->> 'cost_usd')::numeric NOT BETWEEN 0 AND 99999999.99999999 THEN
        RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid_cost_metadata';
      END IF;
    END IF;
  END IF;
  IF p_operation = 'start_step' THEN
    IF v_step.status <> 'pending' THEN
      RETURN pg_catalog.jsonb_build_object('run_id', v_run.id, 'status', 'running', 'accepted', false);
    END IF;
    IF v_run.execution_mode = 'composed' THEN
      SELECT pg_catalog.string_agg(CASE WHEN n = 3 THEN pg_catalog.replace(value ->> 'prompt_template',
        '{{user_prompt}}', CASE WHEN v_run.user_context = '' THEN 'No additional context provided.' ELSE v_run.user_context END)
        ELSE value ->> 'prompt_template' END, E'\n\n' ORDER BY n)
        INTO v_prompt FROM pg_catalog.jsonb_array_elements(v_run.step_snapshot) WITH ORDINALITY e(value, n);
    ELSE
      v_prompt := v_run.step_snapshot -> (v_position - 1) ->> 'prompt_template';
    END IF;
    SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('position', execution_position,
      'source_step_id', source_step_id, 'output_text', output_text) ORDER BY execution_position), '[]'::jsonb)
      INTO v_previous FROM public.prompt_chain_run_steps WHERE run_id = v_run.id AND execution_position < v_position;
    v_context := pg_catalog.jsonb_build_object('prompt', v_prompt, 'user_context', v_run.user_context,
      'image', pg_catalog.jsonb_build_object('bucket', 'prompt-chain-execution-media', 'path', v_run.input_path,
        'mime', v_run.input_mime, 'sha256', v_run.input_sha256), 'previous_outputs', v_previous,
      'request_config', v_run.request_config, 'requested_model', v_run.requested_model);
    UPDATE public.prompt_chain_run_steps SET status = 'running', submitted_context = v_context, started_at = v_now
      WHERE run_id = v_run.id AND execution_position = v_position;
    RETURN pg_catalog.jsonb_build_object('run_id', v_run.id, 'status', 'running', 'accepted', true, 'submitted_context', v_context);
  ELSIF p_operation = 'complete_step' THEN
    IF v_step.status <> 'running' THEN
      RETURN pg_catalog.jsonb_build_object('run_id', v_run.id, 'status', 'running', 'accepted', false);
    END IF;
    v_output := p_payload ->> 'output_text';
    v_truncated := pg_catalog.octet_length(v_output) > 32768;
    v_invalid := v_truncated OR v_output !~ '[^[:space:]]';
    IF p_payload ? 'provider_http_status' AND (p_payload ->> 'provider_http_status')::integer NOT BETWEEN 200 AND 299 THEN
      v_invalid := true;
      v_code := 'provider_error';
    END IF;
    IF NOT v_invalid AND v_run.execution_mode = 'composed' THEN
      BEGIN v_parsed := v_output::jsonb;
      EXCEPTION WHEN data_exception OR program_limit_exceeded THEN v_invalid := true;
      END;
      IF NOT v_invalid THEN
        v_invalid := pg_catalog.jsonb_typeof(v_parsed) IS DISTINCT FROM 'object'
          OR pg_catalog.jsonb_typeof(v_parsed -> 'caption_a') IS DISTINCT FROM 'string'
          OR pg_catalog.jsonb_typeof(v_parsed -> 'caption_b') IS DISTINCT FROM 'string'
          OR v_parsed ->> 'caption_a' !~ '[^[:space:]]' OR v_parsed ->> 'caption_b' !~ '[^[:space:]]'
          OR pg_catalog.regexp_replace(v_parsed ->> 'caption_a', '^[[:space:]]+|[[:space:]]+$', '', 'g')
             = pg_catalog.regexp_replace(v_parsed ->> 'caption_b', '^[[:space:]]+|[[:space:]]+$', '', 'g');
        IF NOT v_invalid THEN
          v_invalid := (SELECT pg_catalog.count(*) FROM pg_catalog.jsonb_object_keys(v_parsed)) <> 2;
        END IF;
      END IF;
    END IF;
    IF v_invalid THEN
      v_code := COALESCE(v_code, 'output_invalid');
      v_message := CASE v_code WHEN 'provider_error' THEN 'The AI provider could not complete this execution.'
        ELSE 'The model output did not meet the execution contract.' END;
    END IF;
    UPDATE public.prompt_chain_run_steps SET output_text = CASE WHEN v_truncated THEN pg_catalog.left(v_output, 8192) ELSE v_output END,
      output_truncated = v_truncated, actual_model = p_payload ->> 'actual_model',
      provider_response_id = p_payload ->> 'provider_response_id', finish_reason = p_payload ->> 'finish_reason',
      provider_http_status = (p_payload ->> 'provider_http_status')::integer,
      prompt_tokens = (p_payload ->> 'prompt_tokens')::bigint, completion_tokens = (p_payload ->> 'completion_tokens')::bigint,
      total_tokens = (p_payload ->> 'total_tokens')::bigint, cost_usd = (p_payload ->> 'cost_usd')::numeric,
      status = CASE WHEN v_invalid THEN 'failed' ELSE 'succeeded' END, completed_at = v_now,
      error_code = CASE WHEN v_invalid THEN v_code ELSE NULL END,
      error_message = CASE WHEN v_invalid THEN v_message ELSE NULL END
      WHERE run_id = v_run.id AND execution_position = v_position;
    IF NOT v_invalid THEN
      IF v_position = v_run.invocation_count THEN
        UPDATE public.prompt_chain_runs SET final_text = v_output WHERE id = v_run.id;
      END IF;
      RETURN pg_catalog.jsonb_build_object('run_id', v_run.id, 'status', 'running', 'accepted', true);
    END IF;
  ELSIF p_operation = 'finalize' THEN
    IF v_run.final_text IS NULL OR (SELECT pg_catalog.count(*) FROM public.prompt_chain_run_steps
      WHERE run_id = v_run.id) <> v_run.invocation_count OR EXISTS (SELECT 1 FROM public.prompt_chain_run_steps
      WHERE run_id = v_run.id AND status <> 'succeeded') THEN
      RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'execution_incomplete';
    END IF;
    IF pg_catalog.jsonb_typeof(p_payload -> 'artifact_sha256') IS DISTINCT FROM 'string'
       OR p_payload ->> 'artifact_sha256' !~ '^[a-f0-9]{64}$' THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'artifact_verification_required';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM storage.objects o WHERE o.bucket_id = 'prompt-chain-execution-media'
      AND o.name = v_run.artifact_path AND o.owner_id = v_user::text AND o.metadata ->> 'mimetype' = 'image/png'
      AND CASE WHEN o.metadata ->> 'size' ~ '^[0-9]{1,8}$' THEN (o.metadata ->> 'size')::bigint ELSE -1 END BETWEEN 1 AND 5242880) THEN
      RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'captioned_artifact_unavailable';
    END IF;
    UPDATE public.prompt_chain_runs SET status = 'succeeded', completed_at = v_now, lease_token_hash = NULL,
      artifact_sha256 = p_payload ->> 'artifact_sha256', artifact_size_bytes = (
        SELECT (o.metadata ->> 'size')::bigint FROM storage.objects o
        WHERE o.bucket_id = 'prompt-chain-execution-media' AND o.name = v_run.artifact_path)
      WHERE id = v_run.id;
    RETURN pg_catalog.jsonb_build_object('run_id', v_run.id, 'status', 'succeeded', 'accepted', true);
  ELSIF p_operation = 'fail' THEN
    v_code := p_payload ->> 'error_code';
    IF pg_catalog.jsonb_typeof(p_payload -> 'error_code') IS DISTINCT FROM 'string' OR v_code NOT IN
      ('input_invalid', 'provider_error', 'provider_timeout', 'output_invalid', 'artifact_error', 'persistence_error') THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid_error_code';
    END IF;
    IF v_run.status = 'prepared' AND (v_code NOT IN ('input_invalid', 'persistence_error')
       OR EXISTS (SELECT 1 FROM pg_catalog.jsonb_object_keys(p_payload) k WHERE k <> 'error_code')) THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid_preparation_failure';
    END IF;
    IF EXISTS (SELECT 1 FROM pg_catalog.jsonb_object_keys(p_payload) k WHERE k <> 'error_code')
       AND NOT EXISTS (SELECT 1 FROM public.prompt_chain_run_steps WHERE run_id = v_run.id AND status = 'running') THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'no_active_invocation_for_provider_metadata';
    END IF;
    UPDATE public.prompt_chain_run_steps SET
      output_text = CASE WHEN p_payload ? 'output_text' THEN
        CASE WHEN pg_catalog.octet_length(p_payload ->> 'output_text') > 32768
             THEN pg_catalog.left(p_payload ->> 'output_text', 8192) ELSE p_payload ->> 'output_text' END ELSE NULL END,
      output_truncated = COALESCE(pg_catalog.octet_length(p_payload ->> 'output_text') > 32768, false),
      actual_model = p_payload ->> 'actual_model', provider_response_id = p_payload ->> 'provider_response_id',
      provider_http_status = (p_payload ->> 'provider_http_status')::integer, finish_reason = p_payload ->> 'finish_reason',
      prompt_tokens = (p_payload ->> 'prompt_tokens')::bigint, completion_tokens = (p_payload ->> 'completion_tokens')::bigint,
      total_tokens = (p_payload ->> 'total_tokens')::bigint, cost_usd = (p_payload ->> 'cost_usd')::numeric
      WHERE run_id = v_run.id AND status = 'running';
  END IF;
  -- Only sanitized, fixed messages enter the failure record. All preceding
  -- succeeded steps and their outputs remain intact in this same transaction.
  v_message := CASE v_code
    WHEN 'input_invalid' THEN 'The uploaded image could not be verified.'
    WHEN 'provider_error' THEN 'The AI provider could not complete this execution.'
    WHEN 'provider_timeout' THEN 'The AI provider did not respond in time.'
    WHEN 'output_invalid' THEN 'The model output did not meet the execution contract.'
    WHEN 'artifact_error' THEN 'The captioned image could not be saved.'
    ELSE 'Execution persistence could not be completed.' END;
  UPDATE public.prompt_chain_run_steps SET status = CASE WHEN status = 'running' THEN 'failed' ELSE 'skipped' END,
    completed_at = v_now, error_code = v_code, error_message = v_message
    WHERE run_id = v_run.id AND status IN ('pending', 'running');
  UPDATE public.prompt_chain_runs SET status = 'failed', completed_at = v_now,
    error_code = v_code, error_message = v_message, lease_token_hash = NULL WHERE id = v_run.id;
  RETURN pg_catalog.jsonb_build_object('run_id', v_run.id, 'status', 'failed', 'accepted', true);
END;
$function$;

CREATE FUNCTION public.prompt_chain_execution_media_access_v1(p_name text, p_operation text)
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY INVOKER
SET search_path = pg_catalog SET row_security = on
AS $function$
BEGIN
  -- Public execute is needed by restrictive Storage policies, including queries
  -- for unrelated buckets. Signed-out/ordinary callers learn only false.
  IF NOT public.prompt_chain_execution_is_superadmin_v1() THEN RETURN false; END IF;
  IF p_operation = 'read' THEN
    RETURN EXISTS (SELECT 1 FROM public.prompt_chain_runs r WHERE p_name = r.input_path
      OR (p_name = r.artifact_path AND r.status = 'succeeded'));
  ELSIF p_operation = 'insert' THEN
    RETURN EXISTS (SELECT 1 FROM public.prompt_chain_runs r WHERE r.creator_id = auth.uid()
      AND r.deadline_at > pg_catalog.statement_timestamp()
      AND ((p_name = r.input_path AND r.status = 'prepared') OR
        (p_name = r.artifact_path AND r.status = 'running' AND r.final_text IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM public.prompt_chain_run_steps s WHERE s.run_id = r.id AND s.status <> 'succeeded'))));
  END IF;
  RETURN false;
END;
$function$;

ALTER FUNCTION public.prepare_prompt_chain_run_v1(uuid, uuid, text, bigint, text, text) OWNER TO postgres;
ALTER FUNCTION public.advance_prompt_chain_run_v1(uuid, text, text, jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.prepare_prompt_chain_run_v1(uuid, uuid, text, bigint, text, text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.advance_prompt_chain_run_v1(uuid, text, text, jsonb) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.prepare_prompt_chain_run_v1(uuid, uuid, text, bigint, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.advance_prompt_chain_run_v1(uuid, text, text, jsonb) TO authenticated;
REVOKE ALL ON FUNCTION public.prompt_chain_execution_is_superadmin_v1() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.prompt_chain_execution_media_access_v1(text, text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.prompt_chain_execution_is_superadmin_v1() TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.prompt_chain_execution_media_access_v1(text, text) TO PUBLIC;

COMMENT ON TABLE public.prompt_chain_runs IS 'Private immutable execution snapshots; lifecycle writes only through reviewed execution RPCs.';
COMMENT ON TABLE public.prompt_chain_run_steps IS 'One row per planned model invocation; default composed chain has one invocation, four snapshot sections.';
COMMENT ON FUNCTION public.advance_prompt_chain_run_v1(uuid, text, text, jsonb) IS 'Creator-only transactional lifecycle. Does not call providers, render images, verify file bytes, or attest AI provenance.';

-- Detect unexpected default/event-trigger/inherited grants before committing.
-- RLS alone is not a substitute for this privilege boundary.
DO $verify_privileges$
DECLARE v_role text; v_table text;
BEGIN
  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    FOREACH v_table IN ARRAY ARRAY['public.prompt_chain_runs', 'public.prompt_chain_run_steps'] LOOP
      IF pg_catalog.has_any_column_privilege(v_role::name, v_table, 'INSERT')
         OR pg_catalog.has_any_column_privilege(v_role::name, v_table, 'UPDATE')
         OR pg_catalog.has_table_privilege(v_role::name, v_table, 'DELETE')
         OR pg_catalog.has_table_privilege(v_role::name, v_table, 'TRUNCATE')
         OR pg_catalog.has_table_privilege(v_role::name, v_table, 'TRIGGER') THEN
        RAISE EXCEPTION 'Unexpected execution write grant for % on %', v_role, v_table;
      END IF;
    END LOOP;
    IF pg_catalog.has_column_privilege(v_role::name, 'public.prompt_chain_runs', 'lease_token_hash', 'SELECT') THEN
      RAISE EXCEPTION 'Unexpected lease hash read grant for %', v_role;
    END IF;
    IF v_role <> 'authenticated' AND (
      pg_catalog.has_function_privilege(v_role::name, 'public.prepare_prompt_chain_run_v1(uuid,uuid,text,bigint,text,text)', 'EXECUTE')
      OR pg_catalog.has_function_privilege(v_role::name, 'public.advance_prompt_chain_run_v1(uuid,text,text,jsonb)', 'EXECUTE')) THEN
      RAISE EXCEPTION 'Unexpected execution RPC grant for %', v_role;
    END IF;
  END LOOP;
  IF (SELECT pg_catalog.count(*) FROM pg_catalog.pg_policies WHERE schemaname = 'public'
      AND tablename IN ('prompt_chain_runs', 'prompt_chain_run_steps')) <> 2 THEN
    RAISE EXCEPTION 'Unexpected execution policies; review event triggers before installation';
  END IF;
END;
$verify_privileges$;
COMMIT;
