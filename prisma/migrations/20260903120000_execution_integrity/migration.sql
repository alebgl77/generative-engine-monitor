-- Deploy with workers stopped: old workers do not understand lease generations.
BEGIN;
-- Additive evidence preservation: no historical sample, response or score is deleted.
ALTER TABLE "jobs" ADD COLUMN "lease_version" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "jobs" ADD COLUMN "dedupe_key" TEXT;
ALTER TABLE "ai_responses" ADD COLUMN "provider_sources" JSONB;
ALTER TABLE "runs" ADD COLUMN "config_snapshot" JSONB NOT NULL DEFAULT '{}';
ALTER TABLE "run_tasks" ADD COLUMN "query_text_snapshot" TEXT NOT NULL DEFAULT '';
ALTER TABLE "run_tasks" ADD COLUMN "locale_snapshot" JSONB NOT NULL DEFAULT '{}';
ALTER TABLE "brands" ADD COLUMN "archived_at" TIMESTAMP(3);
ALTER TABLE "competitors" ADD COLUMN "archived_at" TIMESTAMP(3);
ALTER TABLE "queries" ADD COLUMN "archived_at" TIMESTAMP(3);

-- Payloads preserve the original prompt where available. Catalog entities do
-- not: explicitly mark all pre-migration configurations as reconstructed.
UPDATE "run_tasks" t SET
  "query_text_snapshot" = COALESCE((SELECT j.payload->>'queryText' FROM jobs j WHERE j.task_id = t.id AND j.kind = 'RUN_SAMPLE' AND j.payload ? 'queryText' ORDER BY j.created_at, j.id LIMIT 1), q.text),
  "locale_snapshot" = COALESCE((SELECT j.payload->'locale' FROM jobs j WHERE j.task_id = t.id AND j.kind = 'RUN_SAMPLE' AND jsonb_typeof(j.payload->'locale') = 'object' ORDER BY j.created_at, j.id LIMIT 1), jsonb_build_object('country', p.target_country, 'language', p.target_language))
FROM "queries" q, "projects" p WHERE q.id = t.query_id AND p.id = t.project_id;

UPDATE "runs" r SET "config_snapshot" = jsonb_build_object(
  'version', 1, 'reconstructed', true,
  'provenance', 'catalog-at-migration; original entity configuration unavailable',
  'requestTemplateVersion', 'legacy-unknown',
  'locale', jsonb_build_object('country', p.target_country, 'language', p.target_language),
  'entities', COALESCE((SELECT jsonb_agg(e.value ORDER BY e.value->>'id') FROM (
    SELECT jsonb_build_object('id', b.id, 'name', b.name, 'domain', b.domain, 'aliases', b.aliases, 'kind', 'BRAND') AS value FROM brands b WHERE b.project_id = p.id
    UNION ALL
    SELECT jsonb_build_object('id', c.id, 'name', c.name, 'domain', c.domain, 'aliases', c.aliases, 'kind', 'COMPETITOR') FROM competitors c WHERE c.project_id = p.id
  ) e), '[]'::jsonb),
  'providers', COALESCE((SELECT jsonb_agg(jsonb_build_object('id', v.id, 'code', v.code, 'model', v.default_model, 'modes', array_remove(ARRAY[CASE WHEN v.supports_parametric THEN 'PARAMETRIC' END, CASE WHEN v.supports_grounded THEN 'GROUNDED' END], NULL)) ORDER BY v.id)
    FROM providers v WHERE EXISTS (SELECT 1 FROM run_tasks t WHERE t.run_id = r.id AND t.provider_id = v.id)), '[]'::jsonb)
) FROM projects p WHERE p.id = r.project_id;

-- No invented prompt hashes or native sources for historical responses.
-- Recognized raw provider payloads can be parsed on replay; unknown provenance
-- remains explicitly unavailable rather than being silently treated as empty.

ALTER TABLE "run_tasks" DROP CONSTRAINT "run_tasks_query_id_fkey";
ALTER TABLE "run_tasks" ADD CONSTRAINT "run_tasks_query_id_fkey" FOREIGN KEY ("query_id") REFERENCES "queries"("id") ON DELETE NO ACTION ON UPDATE CASCADE;
ALTER TABLE "brand_mentions" DROP CONSTRAINT "brand_mentions_brand_id_fkey";
ALTER TABLE "brand_mentions" ADD CONSTRAINT "brand_mentions_brand_id_fkey" FOREIGN KEY ("brand_id") REFERENCES "brands"("id") ON DELETE NO ACTION ON UPDATE CASCADE;
ALTER TABLE "competitor_mentions" DROP CONSTRAINT "competitor_mentions_competitor_id_fkey";
ALTER TABLE "competitor_mentions" ADD CONSTRAINT "competitor_mentions_competitor_id_fkey" FOREIGN KEY ("competitor_id") REFERENCES "competitors"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

ALTER TABLE "task_scores" ALTER COLUMN "ci_low" DROP NOT NULL;
ALTER TABLE "task_scores" ALTER COLUMN "ci_high" DROP NOT NULL;
ALTER TABLE "run_scores" ALTER COLUMN "ci_low" DROP NOT NULL;
ALTER TABLE "run_scores" ALTER COLUMN "ci_high" DROP NOT NULL;
ALTER TABLE "run_scores" ADD COLUMN "raw_n" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "run_scores" ADD COLUMN "cell_n" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "run_scores" ADD COLUMN "ci_method" TEXT NOT NULL DEFAULT 'legacy-pooled-bootstrap';
UPDATE "run_scores" SET "raw_n" = "n";

-- Preserve old duplicate rows for audit; only one generation remains runnable.
WITH keyed AS (
  SELECT id, CASE kind
    WHEN 'RESCORE_SAMPLE' THEN 'rescore:' || (payload->>'sampleId') || ':' || (payload->>'targetScoringVersion')
    WHEN 'AGGREGATE_TASK' THEN 'aggregate-task:' || task_id || ':' || (payload->>'scoringVersion')
    WHEN 'AGGREGATE_RUN' THEN 'aggregate-run:' || run_id || ':' || (payload->>'scoringVersion')
  END AS key FROM jobs WHERE kind <> 'RUN_SAMPLE'
), ranked AS (
  SELECT k.*, row_number() OVER (PARTITION BY k.key ORDER BY CASE WHEN j.status IN ('RUNNING','QUEUED') THEN 0 ELSE 1 END, j.created_at, j.id) AS ordinal
  FROM keyed k JOIN jobs j ON j.id = k.id WHERE k.key IS NOT NULL
)
UPDATE jobs j SET
  dedupe_key = CASE WHEN r.ordinal = 1 THEN r.key ELSE NULL END,
  status = CASE WHEN r.ordinal > 1 AND j.status IN ('RUNNING','QUEUED') THEN 'CANCELLED'::"JobStatus" ELSE j.status END,
  locked_by = CASE WHEN r.ordinal > 1 THEN NULL ELSE j.locked_by END,
  lease_expires_at = CASE WHEN r.ordinal > 1 THEN NULL ELSE j.lease_expires_at END
FROM ranked r WHERE r.id = j.id;
CREATE UNIQUE INDEX "jobs_dedupe_key_key" ON "jobs"("dedupe_key");
COMMIT;
