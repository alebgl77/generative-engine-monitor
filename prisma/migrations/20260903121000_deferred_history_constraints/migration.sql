BEGIN;
-- Direct catalog deletion remains forbidden at commit. Whole-project/user
-- purges can finish their cascades before these history constraints are checked.
ALTER TABLE "run_tasks" ALTER CONSTRAINT "run_tasks_query_id_fkey" DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "brand_mentions" ALTER CONSTRAINT "brand_mentions_brand_id_fkey" DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "competitor_mentions" ALTER CONSTRAINT "competitor_mentions_competitor_id_fkey" DEFERRABLE INITIALLY DEFERRED;
COMMIT;
