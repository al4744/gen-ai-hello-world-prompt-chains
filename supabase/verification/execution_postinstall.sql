-- READ ONLY. Run after an independently reviewed/manual installation.
-- A metadata session may see more than an authenticated history user.
SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity, pg_catalog.pg_get_userbyid(c.relowner) AS owner
FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relname IN ('prompt_chain_runs', 'prompt_chain_run_steps');

SELECT p.oid::regprocedure AS function, p.prosecdef, p.provolatile, p.proconfig,
  pg_catalog.pg_get_userbyid(p.proowner) AS owner, p.proacl
FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND p.proname IN ('prompt_chain_execution_is_superadmin_v1',
  'prepare_prompt_chain_run_v1', 'advance_prompt_chain_run_v1', 'prompt_chain_execution_media_access_v1');

-- Expected: no app-role write privileges, no table-wide run SELECT, and no
-- authenticated lease-hash SELECT (the other run columns have explicit grants).
SELECT role_name, table_name,
  pg_catalog.has_table_privilege(role_name::name, 'public.' || table_name, 'INSERT') AS can_insert,
  pg_catalog.has_table_privilege(role_name::name, 'public.' || table_name, 'UPDATE') AS can_update,
  pg_catalog.has_any_column_privilege(role_name::name, 'public.' || table_name, 'INSERT') AS can_insert_any_column,
  pg_catalog.has_any_column_privilege(role_name::name, 'public.' || table_name, 'UPDATE') AS can_update_any_column,
  pg_catalog.has_table_privilege(role_name::name, 'public.' || table_name, 'DELETE') AS can_delete,
  pg_catalog.has_table_privilege(role_name::name, 'public.' || table_name, 'TRUNCATE') AS can_truncate
FROM (VALUES ('anon'), ('authenticated'), ('service_role')) roles(role_name)
CROSS JOIN (VALUES ('prompt_chain_runs'), ('prompt_chain_run_steps')) tables(table_name);

SELECT pg_catalog.has_column_privilege('authenticated', 'public.prompt_chain_runs', 'id', 'SELECT') AS can_read_run_id,
  pg_catalog.has_column_privilege('authenticated', 'public.prompt_chain_runs', 'lease_token_hash', 'SELECT') AS can_read_lease_hash;

SELECT role_name, signature, pg_catalog.has_function_privilege(role_name::name, signature, 'EXECUTE') AS executable
FROM (VALUES ('anon'), ('authenticated'), ('service_role')) roles(role_name)
CROSS JOIN (VALUES ('public.prepare_prompt_chain_run_v1(uuid,uuid,text,bigint,text,text)'),
                   ('public.advance_prompt_chain_run_v1(uuid,text,text,jsonb)')) functions(signature);

SELECT schemaname, tablename, policyname, permissive, roles, cmd, qual, with_check
FROM pg_catalog.pg_policies WHERE (schemaname = 'public' AND tablename IN ('prompt_chain_runs', 'prompt_chain_run_steps'))
  OR (schemaname = 'storage' AND tablename = 'objects' AND policyname LIKE 'pc_execution_%')
ORDER BY schemaname, tablename, policyname;

SELECT conrelid::regclass AS relation, conname, pg_catalog.pg_get_constraintdef(oid) AS definition
FROM pg_catalog.pg_constraint WHERE conrelid IN ('public.prompt_chain_runs'::regclass, 'public.prompt_chain_run_steps'::regclass);
SELECT indexname, indexdef FROM pg_catalog.pg_indexes WHERE schemaname = 'public'
  AND tablename IN ('prompt_chain_runs', 'prompt_chain_run_steps');

SELECT id, name, public, file_size_limit, allowed_mime_types FROM storage.buckets
WHERE id = 'prompt-chain-execution-media';

-- Guarded history query: UUID/name/slug snapshots stay useful after deletion.
-- Never SELECT * from runs as an app user: the lease hash is intentionally hidden.
SELECT r.id, r.original_chain_id, r.current_chain_id, r.chain_name, r.chain_slug,
  r.creator_id, r.execution_mode, r.status,
  CASE WHEN r.status IN ('prepared', 'running') AND r.deadline_at <= pg_catalog.statement_timestamp()
       THEN 'interrupted' ELSE r.status END AS effective_status,
  r.created_at, r.started_at, r.completed_at, r.deadline_at,
  r.final_text, r.artifact_path, r.error_code, r.error_message,
  (SELECT count(*) FROM public.prompt_chain_run_steps s WHERE s.run_id = r.id AND s.status = 'succeeded') AS completed_invocations
FROM public.prompt_chain_runs r ORDER BY r.created_at DESC, r.id DESC LIMIT 20;

-- Unknown usage/cost remains unknown; do not report NULL as zero spend.
SELECT run_id, count(*) FILTER (WHERE started_at IS NOT NULL) AS started_invocations,
  CASE WHEN count(total_tokens) = count(*) FILTER (WHERE started_at IS NOT NULL) THEN sum(total_tokens) END AS known_total_tokens,
  CASE WHEN count(cost_usd) = count(*) FILTER (WHERE started_at IS NOT NULL) THEN sum(cost_usd) END AS known_cost_usd
FROM public.prompt_chain_run_steps GROUP BY run_id;

-- Metadata consistency only; no live providers or mutation RPCs are called.
SELECT r.id AS inconsistent_run FROM public.prompt_chain_runs r
WHERE (SELECT count(*) FROM public.prompt_chain_run_steps s WHERE s.run_id = r.id) <> r.invocation_count
   OR (r.status = 'succeeded' AND EXISTS (SELECT 1 FROM public.prompt_chain_run_steps s WHERE s.run_id = r.id AND s.status <> 'succeeded'));

-- Compare existing v1/v2 owner/config/ACL results with the saved preflight.
SELECT p.oid::regprocedure, p.prosecdef, p.proconfig, p.proacl
FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND p.proname IN ('manage_prompt_chain_steps_v1', 'reorder_prompt_chain_step_v2');
