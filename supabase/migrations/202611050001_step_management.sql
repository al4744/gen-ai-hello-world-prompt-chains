-- REVIEW ONLY: this migration has NOT been executed.
-- Installs one SECURITY INVOKER RPC; changes no tables, constraints, or RLS.
-- Run verification/step_management_preflight.sql and read README.md first.
BEGIN;

DO $preflight$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint AS c
    WHERE c.conrelid = 'public.prompt_chain_steps'::pg_catalog.regclass
      AND c.contype = 'u'
      AND (
        SELECT pg_catalog.array_agg(a.attname::text ORDER BY a.attname)
        FROM pg_catalog.unnest(c.conkey) AS k(attnum)
        JOIN pg_catalog.pg_attribute AS a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
      ) = ARRAY['chain_id', 'step_order']::text[]
  ) THEN
    RAISE EXCEPTION 'Required unique (chain_id, step_order) constraint is missing';
  END IF;
  -- The algorithm below works with both immediate and deferrable uniqueness.
  -- It never changes constraint timing or relies on a specific constraint name.
END;
$preflight$;

CREATE FUNCTION public.manage_prompt_chain_steps_v1(
  p_chain_id uuid,
  p_operation text,
  p_expected_order jsonb,
  p_step_id uuid DEFAULT NULL,
  p_name text DEFAULT NULL,
  p_prompt_template text DEFAULT NULL,
  p_expected_name text DEFAULT NULL,
  p_expected_template text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = pg_catalog
SET row_security = on
SET lock_timeout = '5s'
AS $function$
DECLARE
  v_slug text;
  v_ids uuid[];
  v_snapshot jsonb;
  v_temporary integer[];
  v_count integer;
  v_final_count integer;
  v_index integer;
  v_other integer;
  v_i integer;
  v_rows integer;
  v_result uuid;
  v_swap uuid;
  v_name text;
  v_template text;
  v_final_ids uuid[];
BEGIN
  IF auth.uid() IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.profiles AS p
    WHERE p.id = auth.uid() AND p.is_superadmin IS TRUE
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'superadmin_required';
  END IF;
  IF p_chain_id IS NULL OR p_operation IS NULL OR p_operation NOT IN ('create', 'update', 'delete', 'move_up', 'move_down') THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid_step_operation';
  END IF;

  -- All new step operations acquire the same parent lock FIRST. Parent chain
  -- edits/deletes naturally conflict with it. FOR UPDATE also conflicts with
  -- the FK key-share lock taken by concurrent inserts referencing this parent.
  SELECT c.slug INTO v_slug FROM public.prompt_chains AS c
  WHERE c.id = p_chain_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'chain_unavailable';
  END IF;
  IF v_slug = 'caption-arena-default' THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'system_chain_read_only';
  END IF;
  PERFORM s.id FROM public.prompt_chain_steps AS s
  WHERE s.chain_id = p_chain_id ORDER BY s.id FOR UPDATE;

  IF p_expected_order IS NULL OR pg_catalog.jsonb_typeof(p_expected_order) <> 'array' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid_expected_order';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_catalog.jsonb_array_elements(p_expected_order) AS e(value)
    WHERE pg_catalog.jsonb_typeof(e.value) IS DISTINCT FROM 'object'
      OR pg_catalog.jsonb_typeof(e.value -> 'id') IS DISTINCT FROM 'string'
      OR (e.value ->> 'id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      OR pg_catalog.jsonb_typeof(e.value -> 'step_order') IS DISTINCT FROM 'number'
      OR (e.value ->> 'step_order') !~ '^[1-9][0-9]*$'
  ) OR (
    SELECT pg_catalog.count(DISTINCT e.value ->> 'id') FROM pg_catalog.jsonb_array_elements(p_expected_order) AS e(value)
  ) <> pg_catalog.jsonb_array_length(p_expected_order) OR (
    SELECT pg_catalog.count(DISTINCT e.value ->> 'step_order') FROM pg_catalog.jsonb_array_elements(p_expected_order) AS e(value)
  ) <> pg_catalog.jsonb_array_length(p_expected_order) THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid_or_duplicate_step_identifiers';
  END IF;

  SELECT COALESCE(pg_catalog.array_agg(s.id ORDER BY s.step_order, s.id), ARRAY[]::uuid[]),
         COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('id', s.id, 'step_order', s.step_order) ORDER BY s.step_order, s.id), '[]'::jsonb)
    INTO v_ids, v_snapshot
  FROM public.prompt_chain_steps AS s WHERE s.chain_id = p_chain_id;
  IF p_expected_order IS DISTINCT FROM v_snapshot THEN
    RAISE EXCEPTION USING ERRCODE = '40001', MESSAGE = 'step_order_conflict';
  END IF;
  v_count := pg_catalog.cardinality(v_ids);
  v_result := p_step_id;

  IF p_operation IN ('create', 'update') THEN
    IF p_name IS NULL OR p_name !~ '[^[:space:]]' OR p_prompt_template IS NULL OR p_prompt_template !~ '[^[:space:]]' THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'step_name_and_template_required';
    END IF;
  END IF;
  IF p_operation = 'create' THEN
    IF p_step_id IS NOT NULL THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'new_step_id_is_database_generated';
    END IF;
  ELSE
    v_index := pg_catalog.array_position(v_ids, p_step_id);
    IF p_step_id IS NULL OR v_index IS NULL THEN
      RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'step_not_in_chain';
    END IF;
    IF p_operation IN ('update', 'delete') THEN
      SELECT s.name, s.prompt_template INTO v_name, v_template
      FROM public.prompt_chain_steps AS s WHERE s.id = p_step_id AND s.chain_id = p_chain_id;
      IF v_name IS DISTINCT FROM p_expected_name OR v_template IS DISTINCT FROM p_expected_template THEN
        RAISE EXCEPTION USING ERRCODE = '40001', MESSAGE = 'step_content_conflict';
      END IF;
    END IF;
  END IF;

  IF p_operation = 'update' THEN
    -- Metadata edits preserve every step's current position and other content.
    UPDATE public.prompt_chain_steps SET name = pg_catalog.btrim(p_name), prompt_template = p_prompt_template
    WHERE id = p_step_id AND chain_id = p_chain_id;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    IF v_rows <> 1 THEN RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'step_write_denied'; END IF;
    RETURN p_step_id;
  ELSIF p_operation = 'delete' THEN
    DELETE FROM public.prompt_chain_steps WHERE id = p_step_id AND chain_id = p_chain_id;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    IF v_rows <> 1 THEN RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'step_write_denied'; END IF;
    v_ids := pg_catalog.array_remove(v_ids, p_step_id);
  ELSIF p_operation IN ('move_up', 'move_down') THEN
    v_other := v_index + CASE WHEN p_operation = 'move_up' THEN -1 ELSE 1 END;
    IF v_other < 1 OR v_other > v_count THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'step_move_boundary';
    END IF;
    v_swap := v_ids[v_index]; v_ids[v_index] := v_ids[v_other]; v_ids[v_other] := v_swap;
  END IF;

  v_final_count := pg_catalog.cardinality(v_ids) + CASE WHEN p_operation = 'create' THEN 1 ELSE 0 END;
  IF v_final_count > 715827882 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'step_order_integer_capacity';
  END IF;
  IF v_final_count > 0 THEN
    -- Among 2N slots in [N+1, 3N], at most N are occupied: N free slots
    -- always exist. They are disjoint from final positions [1,N] AND current
    -- rows. This also handles gaps and an existing position of 2147483647.
    SELECT pg_catalog.array_agg(t.position ORDER BY t.position) INTO v_temporary
    FROM (
      SELECT g.position FROM pg_catalog.generate_series(v_final_count + 1, v_final_count * 3) AS g(position)
      WHERE NOT EXISTS (SELECT 1 FROM public.prompt_chain_steps AS s WHERE s.chain_id = p_chain_id AND s.step_order = g.position)
      ORDER BY g.position LIMIT v_final_count
    ) AS t;
    IF pg_catalog.cardinality(v_temporary) IS DISTINCT FROM v_final_count THEN
      RAISE EXCEPTION USING ERRCODE = '40001', MESSAGE = 'temporary_positions_unavailable';
    END IF;
    IF p_operation = 'create' THEN
      INSERT INTO public.prompt_chain_steps (chain_id, step_order, name, prompt_template)
      VALUES (p_chain_id, v_temporary[v_final_count], pg_catalog.btrim(p_name), p_prompt_template)
      RETURNING id INTO v_result;
      IF v_result IS NULL THEN RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'step_write_denied'; END IF;
      v_ids := pg_catalog.array_append(v_ids, v_result);
    END IF;
    FOR v_i IN 1..v_final_count LOOP
      UPDATE public.prompt_chain_steps SET step_order = v_temporary[v_i]
      WHERE id = v_ids[v_i] AND chain_id = p_chain_id;
      GET DIAGNOSTICS v_rows = ROW_COUNT;
      IF v_rows <> 1 THEN RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'step_write_denied'; END IF;
    END LOOP;
    FOR v_i IN 1..v_final_count LOOP
      UPDATE public.prompt_chain_steps SET step_order = v_i
      WHERE id = v_ids[v_i] AND chain_id = p_chain_id;
      GET DIAGNOSTICS v_rows = ROW_COUNT;
      IF v_rows <> 1 THEN RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'step_write_denied'; END IF;
    END LOOP;
  END IF;

  SELECT COALESCE(pg_catalog.array_agg(s.id ORDER BY s.step_order, s.id), ARRAY[]::uuid[]) INTO v_final_ids
  FROM public.prompt_chain_steps AS s WHERE s.chain_id = p_chain_id;
  IF v_final_ids IS DISTINCT FROM v_ids OR EXISTS (
    SELECT 1 FROM (
      SELECT s.step_order, pg_catalog.row_number() OVER (ORDER BY s.step_order, s.id) AS expected
      FROM public.prompt_chain_steps AS s WHERE s.chain_id = p_chain_id
    ) AS ordered WHERE ordered.step_order <> ordered.expected
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '40001', MESSAGE = 'step_order_postcondition_failed';
  END IF;
  -- Any exception above aborts the RPC transaction, including both temporary
  -- phases and DELETE/INSERT. There is deliberately no catch-and-continue.
  RETURN v_result;
END;
$function$;

REVOKE ALL ON FUNCTION public.manage_prompt_chain_steps_v1(uuid, text, jsonb, uuid, text, text, text, text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.manage_prompt_chain_steps_v1(uuid, text, jsonb, uuid, text, text, text, text) TO authenticated;
COMMENT ON FUNCTION public.manage_prompt_chain_steps_v1(uuid, text, jsonb, uuid, text, text, text, text)
IS 'Superadmin custom-chain step mutations. Invoker RLS; parent/child locks; optimistic order/content checks; collision-free transactional positions.';
COMMIT;
