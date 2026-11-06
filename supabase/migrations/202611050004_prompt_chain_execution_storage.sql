-- REVIEW ONLY. Not executed. Install guards BEFORE manually creating the bucket
-- using the Storage API/Dashboard and storage/prompt-chain-execution-media.json.
-- Never INSERT/UPDATE/DELETE storage metadata directly to manage physical files.
BEGIN;

DO $preflight$
BEGIN
  IF current_user <> 'postgres' THEN RAISE EXCEPTION 'Review/install as postgres'; END IF;
  IF pg_catalog.to_regprocedure('public.prompt_chain_execution_media_access_v1(text,text)') IS NULL THEN
    RAISE EXCEPTION 'Install reviewed execution persistence first';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
                 WHERE n.nspname = 'storage' AND c.relname = 'objects' AND c.relrowsecurity) THEN
    RAISE EXCEPTION 'Storage objects RLS is unavailable';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_policies WHERE schemaname = 'storage' AND tablename = 'objects'
             AND policyname IN ('pc_execution_select_guard', 'pc_execution_insert_guard',
               'pc_execution_update_guard', 'pc_execution_delete_guard',
               'pc_execution_media_read', 'pc_execution_media_insert')) THEN
    RAISE EXCEPTION 'Storage policy collision; never overwrite existing policies';
  END IF;
  IF EXISTS (SELECT 1 FROM storage.buckets WHERE id = 'prompt-chain-execution-media' OR name = 'prompt-chain-execution-media') THEN
    RAISE EXCEPTION 'Bucket already exists: inspect before installing; expected a new, absent bucket';
  END IF;
END;
$preflight$;

-- Permissive policies combine with OR. Restrictive guards ALSO constrain any
-- pre-existing broad policies, solely for the new bucket. Other buckets pass
-- these guards unchanged; no other application's policy is replaced.
CREATE POLICY pc_execution_select_guard ON storage.objects AS RESTRICTIVE
FOR SELECT TO PUBLIC
USING (bucket_id <> 'prompt-chain-execution-media'
  OR public.prompt_chain_execution_media_access_v1(name, 'read'));

CREATE POLICY pc_execution_insert_guard ON storage.objects AS RESTRICTIVE
FOR INSERT TO PUBLIC
WITH CHECK (bucket_id <> 'prompt-chain-execution-media'
  OR public.prompt_chain_execution_media_access_v1(name, 'insert'));

CREATE POLICY pc_execution_update_guard ON storage.objects AS RESTRICTIVE
FOR UPDATE TO PUBLIC
USING (bucket_id <> 'prompt-chain-execution-media')
WITH CHECK (bucket_id <> 'prompt-chain-execution-media');

CREATE POLICY pc_execution_delete_guard ON storage.objects AS RESTRICTIVE
FOR DELETE TO PUBLIC USING (bucket_id <> 'prompt-chain-execution-media');

CREATE POLICY pc_execution_media_read ON storage.objects
FOR SELECT TO authenticated
USING (bucket_id = 'prompt-chain-execution-media'
  AND public.prompt_chain_execution_media_access_v1(name, 'read'));

CREATE POLICY pc_execution_media_insert ON storage.objects
FOR INSERT TO authenticated
WITH CHECK (bucket_id = 'prompt-chain-execution-media'
  AND public.prompt_chain_execution_media_access_v1(name, 'insert'));

-- No UPDATE/DELETE allow policy, table grant changes, public bucket, signed URL,
-- source-bucket change, Storage ownership trigger or metadata write is installed.
COMMIT;
