-- READ ONLY. Run with an approved metadata-reading session before installation.
-- No execution RPCs, writes, provider calls, or secret values are queried.
SELECT pg_catalog.current_setting('server_version') AS postgres_version, current_user,
  pg_catalog.to_regprocedure('pg_catalog.gen_random_uuid()') AS uuid_function,
  pg_catalog.to_regprocedure('pg_catalog.sha256(bytea)') AS sha256_function;

SELECT rolname, rolsuper, rolbypassrls, rolcreaterole
FROM pg_catalog.pg_roles WHERE rolname IN ('postgres', 'anon', 'authenticated', 'service_role');

SELECT pg_catalog.pg_get_userbyid(roleid) AS granted_role,
  pg_catalog.pg_get_userbyid(member) AS member_role, admin_option
FROM pg_catalog.pg_auth_members;

SELECT n.nspname, c.relname, c.relkind, c.relrowsecurity, c.relforcerowsecurity,
  pg_catalog.pg_get_userbyid(c.relowner) AS owner
FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
WHERE (n.nspname = 'public' AND c.relname IN ('profiles', 'prompt_chains', 'prompt_chain_steps',
  'prompt_chain_runs', 'prompt_chain_run_steps', 'prompt_chain_runs_history',
  'prompt_chain_runs_creator', 'prompt_chain_runs_one_active', 'prompt_chain_run_steps_one_active'))
  OR (n.nspname = 'storage' AND c.relname IN ('objects', 'buckets'))
  OR (n.nspname = 'auth' AND c.relname = 'users');

SELECT table_schema, table_name, column_name, data_type, udt_schema, udt_name,
  is_nullable, column_default, character_maximum_length
FROM information_schema.columns
WHERE (table_schema = 'public' AND table_name IN ('profiles', 'prompt_chains', 'prompt_chain_steps'))
  OR (table_schema = 'auth' AND table_name = 'users' AND column_name = 'id')
  OR (table_schema = 'storage' AND table_name IN ('objects', 'buckets'))
ORDER BY table_schema, table_name, ordinal_position;

SELECT n.nspname, r.relname, c.conname, c.contype, c.condeferrable, c.condeferred,
  pg_catalog.pg_get_constraintdef(c.oid) AS definition
FROM pg_catalog.pg_constraint c JOIN pg_catalog.pg_class r ON r.oid = c.conrelid
JOIN pg_catalog.pg_namespace n ON n.oid = r.relnamespace
WHERE c.conrelid IN (pg_catalog.to_regclass('public.profiles'), pg_catalog.to_regclass('public.prompt_chains'),
  pg_catalog.to_regclass('public.prompt_chain_steps'), pg_catalog.to_regclass('storage.objects'))
  OR c.confrelid IN (pg_catalog.to_regclass('public.prompt_chains'), pg_catalog.to_regclass('public.prompt_chain_steps'))
ORDER BY n.nspname, r.relname, c.conname;

SELECT table_schema, table_name, grantee, privilege_type
FROM information_schema.table_privileges
WHERE table_schema IN ('public', 'storage') AND table_name IN
  ('profiles', 'prompt_chains', 'prompt_chain_steps', 'prompt_chain_runs', 'prompt_chain_run_steps', 'objects', 'buckets')
ORDER BY table_schema, table_name, grantee, privilege_type;

SELECT table_schema, table_name, column_name, grantee, privilege_type
FROM information_schema.column_privileges
WHERE table_schema = 'public' AND table_name IN ('profiles', 'prompt_chains', 'prompt_chain_steps', 'prompt_chain_runs', 'prompt_chain_run_steps')
ORDER BY table_name, grantee, privilege_type, column_name;

SELECT schemaname, tablename, policyname, permissive, roles, cmd, qual, with_check
FROM pg_catalog.pg_policies WHERE (schemaname = 'public' AND tablename IN
  ('profiles', 'prompt_chains', 'prompt_chain_steps', 'prompt_chain_runs', 'prompt_chain_run_steps'))
  OR (schemaname = 'storage' AND tablename IN ('objects', 'buckets'))
ORDER BY schemaname, tablename, policyname;

SELECT t.tgrelid::regclass AS relation, t.tgname, pg_catalog.pg_get_triggerdef(t.oid) AS definition,
  p.oid::regprocedure AS trigger_function, p.prosecdef, p.proconfig
FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_proc p ON p.oid = t.tgfoid
WHERE NOT t.tgisinternal AND t.tgrelid IN (pg_catalog.to_regclass('public.profiles'),
  pg_catalog.to_regclass('public.prompt_chains'), pg_catalog.to_regclass('public.prompt_chain_steps'),
  pg_catalog.to_regclass('storage.objects'), pg_catalog.to_regclass('auth.users'));

SELECT p.oid::regprocedure AS function, pg_catalog.pg_get_userbyid(p.proowner) AS owner,
  p.prosecdef, p.provolatile, p.proconfig, p.proacl
FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND p.proname IN ('manage_prompt_chain_steps_v1', 'reorder_prompt_chain_step_v2',
  'prompt_chain_execution_is_superadmin_v1', 'prepare_prompt_chain_run_v1',
  'advance_prompt_chain_run_v1', 'prompt_chain_execution_media_access_v1');

SELECT p.oid::regprocedure AS function, pg_catalog.pg_get_functiondef(p.oid) AS definition
FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND p.proname IN ('manage_prompt_chain_steps_v1', 'reorder_prompt_chain_step_v2');

-- Default ACLs/event triggers might silently add grants/policies to new objects.
SELECT pg_catalog.pg_get_userbyid(defaclrole) AS owner, defaclnamespace::regnamespace,
  defaclobjtype, defaclacl FROM pg_catalog.pg_default_acl;
SELECT evtname, evtevent, evtenabled, evtfoid::regprocedure FROM pg_catalog.pg_event_trigger;

-- Bucket ID AND name must be absent. Check for existing permissive/restrictive
-- policies that could affect other buckets or inadvertently deny new access.
SELECT id, name, public, file_size_limit, allowed_mime_types FROM storage.buckets;
SELECT bucket_id, count(*) AS execution_object_count FROM storage.objects
WHERE bucket_id = 'prompt-chain-execution-media' GROUP BY bucket_id;

-- Configuration only; does not print templates or modify the four sections.
SELECT c.id, c.slug, count(s.id) AS stored_sections,
  pg_catalog.array_agg(s.step_order ORDER BY s.step_order) AS positions,
  pg_catalog.bool_or(s.step_order = 3 AND pg_catalog.strpos(s.prompt_template, '{{user_prompt}}') > 0) AS third_section_has_binding
FROM public.prompt_chains c LEFT JOIN public.prompt_chain_steps s ON s.chain_id = c.id
WHERE c.slug = 'caption-arena-default' GROUP BY c.id, c.slug;
