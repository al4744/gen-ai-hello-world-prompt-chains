-- REVIEW ONLY: additive migration; DO NOT execute automatically.
-- Leaves the installed manage_prompt_chain_steps_v1 and all existing objects intact.
BEGIN;

DO $preflight$
BEGIN
  IF pg_catalog.to_regprocedure('public.manage_prompt_chain_steps_v1(uuid,text,jsonb,uuid,text,text,text,text)') IS NULL THEN
    RAISE EXCEPTION 'The working v1 step-management function must be installed first';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint AS c
    WHERE c.conrelid = 'public.prompt_chain_steps'::pg_catalog.regclass AND c.contype = 'u'
      AND (SELECT pg_catalog.array_agg(a.attname::text ORDER BY a.attname)
           FROM pg_catalog.unnest(c.conkey) AS k(attnum)
           JOIN pg_catalog.pg_attribute AS a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
          ) = ARRAY['chain_id', 'step_order']::text[]
  ) THEN RAISE EXCEPTION 'Required unique (chain_id, step_order) constraint is missing'; END IF;
END;
$preflight$;

CREATE FUNCTION public.reorder_prompt_chain_step_v2(
  p_chain_id uuid,
  p_step_id uuid,
  p_destination integer,
  p_expected_order jsonb
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
  v_desired uuid[];
  v_final uuid[];
  v_snapshot jsonb;
  v_temporary integer[];
  v_count integer;
  v_index integer;
  v_i integer;
  v_rows integer;
BEGIN
  IF auth.uid() IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.profiles AS p WHERE p.id = auth.uid() AND p.is_superadmin IS TRUE
  ) THEN RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'superadmin_required'; END IF;
  IF p_chain_id IS NULL OR p_step_id IS NULL OR p_destination IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'chain_step_and_destination_required';
  END IF;

  -- Exact same parent-first/UUID-child locking protocol as v1. Never call v1
  -- repeatedly to simulate a long move: this single function owns the transaction.
  SELECT c.slug INTO v_slug FROM public.prompt_chains AS c WHERE c.id = p_chain_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'chain_unavailable'; END IF;
  IF v_slug = 'caption-arena-default' THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'system_chain_read_only';
  END IF;
  PERFORM s.id FROM public.prompt_chain_steps AS s WHERE s.chain_id = p_chain_id ORDER BY s.id FOR UPDATE;

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
  ) OR (SELECT pg_catalog.count(DISTINCT e.value ->> 'id') FROM pg_catalog.jsonb_array_elements(p_expected_order) AS e(value)) <> pg_catalog.jsonb_array_length(p_expected_order)
    OR (SELECT pg_catalog.count(DISTINCT e.value ->> 'step_order') FROM pg_catalog.jsonb_array_elements(p_expected_order) AS e(value)) <> pg_catalog.jsonb_array_length(p_expected_order) THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid_or_duplicate_step_identifiers';
  END IF;

  SELECT COALESCE(pg_catalog.array_agg(s.id ORDER BY s.step_order, s.id), ARRAY[]::uuid[]),
         COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('id', s.id, 'step_order', s.step_order) ORDER BY s.step_order, s.id), '[]'::jsonb)
    INTO v_ids, v_snapshot FROM public.prompt_chain_steps AS s WHERE s.chain_id = p_chain_id;
  IF p_expected_order IS DISTINCT FROM v_snapshot THEN
    RAISE EXCEPTION USING ERRCODE = '40001', MESSAGE = 'step_order_conflict';
  END IF;
  v_count := pg_catalog.cardinality(v_ids);
  v_index := pg_catalog.array_position(v_ids, p_step_id);
  IF v_index IS NULL THEN RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'step_not_in_chain'; END IF;
  IF p_destination < 1 OR p_destination > v_count THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid_destination';
  END IF;
  IF p_destination = v_index THEN RETURN p_step_id; END IF;
  IF v_count > 715827882 THEN RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'step_order_integer_capacity'; END IF;

  v_desired := pg_catalog.array_remove(v_ids, p_step_id);
  v_desired := COALESCE(v_desired[1:p_destination - 1], ARRAY[]::uuid[])
    || ARRAY[p_step_id]::uuid[] || COALESCE(v_desired[p_destination:v_count], ARRAY[]::uuid[]);

  -- Find N unused slots among 2N candidates, disjoint from final positions.
  -- No max(position)+N assumption, even when old positions contain gaps/INT_MAX.
  SELECT pg_catalog.array_agg(t.position ORDER BY t.position) INTO v_temporary FROM (
    SELECT g.position FROM pg_catalog.generate_series(v_count + 1, v_count * 3) AS g(position)
    WHERE NOT EXISTS (SELECT 1 FROM public.prompt_chain_steps AS s WHERE s.chain_id = p_chain_id AND s.step_order = g.position)
    ORDER BY g.position LIMIT v_count
  ) AS t;
  IF pg_catalog.cardinality(v_temporary) IS DISTINCT FROM v_count THEN
    RAISE EXCEPTION USING ERRCODE = '40001', MESSAGE = 'temporary_positions_unavailable';
  END IF;
  FOR v_i IN 1..v_count LOOP
    UPDATE public.prompt_chain_steps SET step_order = v_temporary[v_i]
    WHERE chain_id = p_chain_id AND id = v_desired[v_i];
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    IF v_rows <> 1 THEN RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'step_write_denied'; END IF;
  END LOOP;
  FOR v_i IN 1..v_count LOOP
    UPDATE public.prompt_chain_steps SET step_order = v_i
    WHERE chain_id = p_chain_id AND id = v_desired[v_i];
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    IF v_rows <> 1 THEN RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'step_write_denied'; END IF;
  END LOOP;
  SELECT pg_catalog.array_agg(s.id ORDER BY s.step_order, s.id) INTO v_final
  FROM public.prompt_chain_steps AS s WHERE s.chain_id = p_chain_id;
  IF v_final IS DISTINCT FROM v_desired OR EXISTS (
    SELECT 1 FROM (
      SELECT s.step_order, pg_catalog.row_number() OVER (ORDER BY s.step_order, s.id) AS expected
      FROM public.prompt_chain_steps AS s WHERE s.chain_id = p_chain_id
    ) AS ordered WHERE ordered.step_order <> ordered.expected
  ) THEN RAISE EXCEPTION USING ERRCODE = '40001', MESSAGE = 'step_order_postcondition_failed'; END IF;
  -- Any exception aborts the entire RPC transaction. Content/IDs are never updated.
  RETURN p_step_id;
END;
$function$;

REVOKE ALL ON FUNCTION public.reorder_prompt_chain_step_v2(uuid, uuid, integer, jsonb) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.reorder_prompt_chain_step_v2(uuid, uuid, integer, jsonb) TO authenticated;
COMMENT ON FUNCTION public.reorder_prompt_chain_step_v2(uuid, uuid, integer, jsonb)
IS 'Additive arbitrary-position custom-step reorder. Invoker RLS; v1-compatible parent/child locks; expected order; positive temporary positions.';
COMMIT;
