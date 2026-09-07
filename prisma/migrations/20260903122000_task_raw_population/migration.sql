BEGIN;
ALTER TABLE "task_scores" ADD COLUMN "raw_n" INTEGER NOT NULL DEFAULT 0;
UPDATE "task_scores" SET "raw_n" = "n";
COMMIT;
