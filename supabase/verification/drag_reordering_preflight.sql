-- READ ONLY. Do not call either mutation RPC during schema inspection.
SELECT p.oid::regprocedure AS function, p.prosecdef AS security_definer,
       p.provolatile, p.proconfig, p.proacl, pg_catalog.pg_get_functiondef(p.oid) AS definition
FROM pg_catalog.pg_proc AS p JOIN pg_catalog.pg_namespace AS n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND p.proname IN ('manage_prompt_chain_steps_v1', 'reorder_prompt_chain_step_v2');

SELECT c.conname, c.contype, c.condeferrable, c.condeferred,
       pg_catalog.pg_get_constraintdef(c.oid) AS definition
FROM pg_catalog.pg_constraint AS c WHERE c.conrelid = 'public.prompt_chain_steps'::regclass;

SELECT table_name, column_name, grantee, privilege_type
FROM information_schema.column_privileges
WHERE table_schema = 'public' AND table_name IN ('profiles', 'prompt_chains', 'prompt_chain_steps') AND grantee = 'authenticated';

SELECT tablename, policyname, roles, cmd, qual, with_check FROM pg_catalog.pg_policies
WHERE schemaname = 'public' AND tablename IN ('profiles', 'prompt_chains', 'prompt_chain_steps');

SELECT t.tgname, pg_catalog.pg_get_triggerdef(t.oid) AS definition FROM pg_catalog.pg_trigger AS t
WHERE t.tgrelid = 'public.prompt_chain_steps'::regclass AND NOT t.tgisinternal;
