-- A new project adopts the current scoring version. Existing projects keep the
-- version their scores were computed under: pointing them at a version no run of
-- theirs was scored with would leave their dashboards looking for rows that do
-- not exist. Moving an existing project forward is what the rescore endpoint is
-- for, and it writes the scores before it promotes the version.
ALTER TABLE "projects" ALTER COLUMN "active_scoring_version" SET DEFAULT 'v3';
