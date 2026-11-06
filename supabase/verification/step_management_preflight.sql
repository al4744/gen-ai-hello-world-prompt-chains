-- READ ONLY. Review these results before manually applying the migration.
SELECT c.conname, c.contype, c.condeferrable, c.condeferred,
       pg_catalog.pg_get_constraintdef(c.oid) AS definition
FROM pg_catalog.pg_constraint AS c
WHERE c.conrelid IN ('public.prompt_chains'::regclass, 'public.prompt_chain_steps'::regclass)
   OR c.confrelid = 'public.prompt_chain_steps'::regclass
ORDER BY c.conrelid, c.conname;

SELECT indexname, indexdef FROM pg_catalog.pg_indexes
WHERE schemaname = 'public' AND tablename = 'prompt_chain_steps';

SELECT column_name, data_type, is_nullable, column_default, character_maximum_length
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'prompt_chain_steps' ORDER BY ordinal_position;

SELECT table_name, grantee, privilege_type, column_name
FROM information_schema.column_privileges
WHERE table_schema = 'public' AND table_name IN ('profiles', 'prompt_chains', 'prompt_chain_steps')
  AND grantee = 'authenticated' ORDER BY table_name, privilege_type, column_name;

SELECT tablename, policyname, roles, cmd, qual, with_check
FROM pg_catalog.pg_policies
WHERE schemaname = 'public' AND tablename IN ('profiles', 'prompt_chains', 'prompt_chain_steps');

SELECT t.tgrelid::regclass AS relation, t.tgname, pg_catalog.pg_get_triggerdef(t.oid) AS definition
FROM pg_catalog.pg_trigger AS t
WHERE t.tgrelid IN ('public.prompt_chains'::regclass, 'public.prompt_chain_steps'::regclass) AND NOT t.tgisinternal;

-- No prompt contents or mutations: identify existing gaps requiring normalization.
SELECT chain_id, count(*) AS steps, min(step_order) AS first_position, max(step_order) AS last_position
FROM public.prompt_chain_steps GROUP BY chain_id
HAVING min(step_order) <> 1 OR max(step_order) <> count(*);

-- After installation: inspect security and function-specific grants only.
SELECT p.oid::regprocedure AS function, p.prosecdef AS security_definer, p.proconfig, p.proacl
FROM pg_catalog.pg_proc AS p JOIN pg_catalog.pg_namespace AS n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND p.proname = 'manage_prompt_chain_steps_v1';
