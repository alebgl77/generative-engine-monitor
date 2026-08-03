-- CreateEnum
CREATE TYPE "SamplingMode" AS ENUM ('PARAMETRIC', 'GROUNDED');

-- CreateEnum
CREATE TYPE "RunStatus" AS ENUM ('PENDING', 'RUNNING', 'COMPLETED', 'PARTIAL', 'FAILED', 'CANCELLING', 'CANCELLED');

-- CreateEnum
CREATE TYPE "TaskStatus" AS ENUM ('PENDING', 'RUNNING', 'COMPLETED', 'PARTIAL', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "SampleStatus" AS ENUM ('PENDING', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "CitationSource" AS ENUM ('NATIVE', 'INLINE_MARKDOWN', 'BARE_URL');

-- CreateEnum
CREATE TYPE "MentionType" AS ENUM ('EXACT', 'ALIAS', 'DOMAIN', 'APPROXIMATE');

-- CreateEnum
CREATE TYPE "Sentiment" AS ENUM ('POSITIVE', 'NEUTRAL', 'NEGATIVE', 'MIXED');

-- CreateEnum
CREATE TYPE "EntityKind" AS ENUM ('BRAND', 'COMPETITOR');

-- CreateEnum
CREATE TYPE "JobStatus" AS ENUM ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'DEAD');

-- CreateEnum
CREATE TYPE "JobKind" AS ENUM ('RUN_SAMPLE', 'AGGREGATE_TASK', 'AGGREGATE_RUN', 'RESCORE_SAMPLE');

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT,
    "password_hash" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "projects" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "domain" TEXT,
    "target_country" TEXT NOT NULL DEFAULT 'FR',
    "target_language" TEXT NOT NULL DEFAULT 'fr',
    "repetitions" INTEGER NOT NULL DEFAULT 3,
    "samplingModes" "SamplingMode"[] DEFAULT ARRAY['PARAMETRIC', 'GROUNDED']::"SamplingMode"[],
    "active_scoring_version" TEXT NOT NULL DEFAULT 'v2',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "projects_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "brands" (
    "id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "domain" TEXT,
    "aliases" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "brands_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "competitors" (
    "id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "domain" TEXT,
    "aliases" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "competitors_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "queries" (
    "id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "queries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "providers" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "is_active_global" BOOLEAN NOT NULL DEFAULT true,
    "supports_parametric" BOOLEAN NOT NULL DEFAULT true,
    "supports_grounded" BOOLEAN NOT NULL DEFAULT false,
    "default_model" TEXT NOT NULL DEFAULT '',
    "rpm_limit" INTEGER NOT NULL DEFAULT 60,
    "max_concurrency" INTEGER NOT NULL DEFAULT 4,

    CONSTRAINT "providers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "provider_credentials" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "provider_id" TEXT NOT NULL,
    "cipher_text" BYTEA NOT NULL,
    "iv" BYTEA NOT NULL,
    "auth_tag" BYTEA NOT NULL,
    "key_version" INTEGER NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "last_four" TEXT NOT NULL,
    "is_valid" BOOLEAN NOT NULL DEFAULT false,
    "last_validated_at" TIMESTAMP(3),
    "validation_error" TEXT,
    "rotated_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "provider_credentials_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "runs" (
    "id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "status" "RunStatus" NOT NULL DEFAULT 'PENDING',
    "scoring_version" TEXT NOT NULL,
    "extraction_version" TEXT NOT NULL,
    "repetitions" INTEGER NOT NULL,
    "modes" "SamplingMode"[],
    "total_tasks" INTEGER NOT NULL DEFAULT 0,
    "pending_tasks" INTEGER NOT NULL DEFAULT 0,
    "total_samples" INTEGER NOT NULL DEFAULT 0,
    "done_samples" INTEGER NOT NULL DEFAULT 0,
    "failed_samples" INTEGER NOT NULL DEFAULT 0,
    "cancel_requested_at" TIMESTAMP(3),
    "started_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "run_tasks" (
    "id" TEXT NOT NULL,
    "run_id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "query_id" TEXT NOT NULL,
    "provider_id" TEXT NOT NULL,
    "mode" "SamplingMode" NOT NULL,
    "status" "TaskStatus" NOT NULL DEFAULT 'PENDING',
    "planned_samples" INTEGER NOT NULL,
    "pending_samples" INTEGER NOT NULL,
    "done_samples" INTEGER NOT NULL DEFAULT 0,
    "failed_samples" INTEGER NOT NULL DEFAULT 0,
    "error_message" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMP(3),

    CONSTRAINT "run_tasks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "run_samples" (
    "id" TEXT NOT NULL,
    "task_id" TEXT NOT NULL,
    "run_id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "sample_index" INTEGER NOT NULL,
    "status" "SampleStatus" NOT NULL DEFAULT 'PENDING',
    "attempt" INTEGER NOT NULL DEFAULT 0,
    "model" TEXT,
    "prompt_hash" TEXT,
    "latency_ms" INTEGER,
    "tokens_in" INTEGER,
    "tokens_out" INTEGER,
    "cost_micros" INTEGER,
    "error_code" TEXT,
    "error_message" TEXT,
    "started_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "run_samples_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_responses" (
    "id" TEXT NOT NULL,
    "sample_id" TEXT NOT NULL,
    "raw_text" TEXT NOT NULL,
    "raw_json" JSONB NOT NULL,
    "finish_reason" TEXT,
    "truncated" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_responses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "citations" (
    "id" TEXT NOT NULL,
    "sample_id" TEXT NOT NULL,
    "run_id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "normalized_url" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "title" TEXT,
    "position" INTEGER,
    "is_brand_domain" BOOLEAN NOT NULL DEFAULT false,
    "source_kind" "CitationSource" NOT NULL,
    "extraction_version" TEXT NOT NULL,

    CONSTRAINT "citations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "brand_mentions" (
    "id" TEXT NOT NULL,
    "sample_id" TEXT NOT NULL,
    "run_id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "brand_id" TEXT NOT NULL,
    "extraction_version" TEXT NOT NULL,
    "mention_type" "MentionType" NOT NULL,
    "occurrence_index" INTEGER NOT NULL,
    "char_offset" INTEGER NOT NULL,
    "sentence_index" INTEGER NOT NULL,
    "normalized_position" DOUBLE PRECISION NOT NULL,
    "in_first_sentence" BOOLEAN NOT NULL,
    "order_rank" INTEGER NOT NULL,
    "occurrences_total" INTEGER NOT NULL,
    "context" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 1.0,
    "sentiment" "Sentiment",
    "sentiment_score" DOUBLE PRECISION,
    "sentiment_judge_version" TEXT,

    CONSTRAINT "brand_mentions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "competitor_mentions" (
    "id" TEXT NOT NULL,
    "sample_id" TEXT NOT NULL,
    "run_id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "competitor_id" TEXT NOT NULL,
    "extraction_version" TEXT NOT NULL,
    "mention_type" "MentionType" NOT NULL,
    "occurrence_index" INTEGER NOT NULL,
    "char_offset" INTEGER NOT NULL,
    "sentence_index" INTEGER NOT NULL,
    "normalized_position" DOUBLE PRECISION NOT NULL,
    "in_first_sentence" BOOLEAN NOT NULL,
    "order_rank" INTEGER NOT NULL,
    "occurrences_total" INTEGER NOT NULL,
    "context" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 1.0,
    "sentiment" "Sentiment",
    "sentiment_score" DOUBLE PRECISION,
    "sentiment_judge_version" TEXT,

    CONSTRAINT "competitor_mentions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sample_scores" (
    "id" TEXT NOT NULL,
    "sample_id" TEXT NOT NULL,
    "task_id" TEXT NOT NULL,
    "run_id" TEXT NOT NULL,
    "scoring_version" TEXT NOT NULL,
    "extraction_version" TEXT NOT NULL,
    "score" DOUBLE PRECISION NOT NULL,
    "brand_present" BOOLEAN NOT NULL,
    "brand_order_rank" INTEGER,
    "brand_occurrences" INTEGER NOT NULL DEFAULT 0,
    "competitor_count" INTEGER NOT NULL DEFAULT 0,
    "citation_count" INTEGER NOT NULL DEFAULT 0,
    "brand_domain_cited" BOOLEAN NOT NULL DEFAULT false,
    "share_of_voice" DOUBLE PRECISION NOT NULL,
    "contributions" JSONB NOT NULL,
    "computed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sample_scores_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "task_scores" (
    "id" TEXT NOT NULL,
    "task_id" TEXT NOT NULL,
    "run_id" TEXT NOT NULL,
    "scoring_version" TEXT NOT NULL,
    "n" INTEGER NOT NULL,
    "n_failed" INTEGER NOT NULL DEFAULT 0,
    "median" DOUBLE PRECISION NOT NULL,
    "mean" DOUBLE PRECISION NOT NULL,
    "ci_low" DOUBLE PRECISION NOT NULL,
    "ci_high" DOUBLE PRECISION NOT NULL,
    "ci_method" TEXT NOT NULL DEFAULT 'percentile_bootstrap_b2000',
    "mad" DOUBLE PRECISION NOT NULL,
    "iqr" DOUBLE PRECISION NOT NULL,
    "stability" DOUBLE PRECISION NOT NULL,
    "low_n" BOOLEAN NOT NULL,
    "brand_presence_rate" DOUBLE PRECISION NOT NULL,
    "bootstrap_seed" TEXT NOT NULL,
    "computed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "task_scores_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "run_scores" (
    "id" TEXT NOT NULL,
    "run_id" TEXT NOT NULL,
    "mode" "SamplingMode" NOT NULL,
    "scoring_version" TEXT NOT NULL,
    "n" INTEGER NOT NULL,
    "median" DOUBLE PRECISION NOT NULL,
    "mean" DOUBLE PRECISION NOT NULL,
    "ci_low" DOUBLE PRECISION NOT NULL,
    "ci_high" DOUBLE PRECISION NOT NULL,
    "mad" DOUBLE PRECISION NOT NULL,
    "iqr" DOUBLE PRECISION NOT NULL,
    "stability" DOUBLE PRECISION NOT NULL,
    "low_n" BOOLEAN NOT NULL,
    "brand_presence_rate" DOUBLE PRECISION NOT NULL,
    "bootstrap_seed" TEXT NOT NULL,
    "computed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "run_scores_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "voice_shares" (
    "id" TEXT NOT NULL,
    "run_id" TEXT NOT NULL,
    "task_id" TEXT,
    "mode" "SamplingMode" NOT NULL,
    "scoring_version" TEXT NOT NULL,
    "entity_kind" "EntityKind" NOT NULL,
    "entity_id" TEXT NOT NULL,
    "entity_name" TEXT NOT NULL,
    "mention_share" DOUBLE PRECISION NOT NULL,
    "presence_rate" DOUBLE PRECISION NOT NULL,
    "citation_share" DOUBLE PRECISION NOT NULL,
    "avg_order_rank" DOUBLE PRECISION,
    "sample_count" INTEGER NOT NULL,

    CONSTRAINT "voice_shares_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sentiment_judgments" (
    "id" TEXT NOT NULL,
    "cache_key" TEXT NOT NULL,
    "judge_version" TEXT NOT NULL,
    "sentiment" "Sentiment" NOT NULL,
    "score" DOUBLE PRECISION NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "rationale" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sentiment_judgments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "jobs" (
    "id" TEXT NOT NULL,
    "kind" "JobKind" NOT NULL,
    "status" "JobStatus" NOT NULL DEFAULT 'QUEUED',
    "run_id" TEXT,
    "project_id" TEXT NOT NULL,
    "task_id" TEXT,
    "sample_id" TEXT,
    "provider_code" TEXT NOT NULL,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "available_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "max_attempts" INTEGER NOT NULL DEFAULT 4,
    "locked_by" TEXT,
    "lease_expires_at" TIMESTAMP(3),
    "heartbeat_at" TIMESTAMP(3),
    "last_error" TEXT,
    "last_error_code" TEXT,
    "payload" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "completed_at" TIMESTAMP(3),

    CONSTRAINT "jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rate_limit_buckets" (
    "key" TEXT NOT NULL,
    "capacity" DOUBLE PRECISION NOT NULL,
    "tokens" DOUBLE PRECISION NOT NULL,
    "refill_per_sec" DOUBLE PRECISION NOT NULL,
    "refilled_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "rate_limit_buckets_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" TEXT NOT NULL,
    "user_id" TEXT,
    "project_id" TEXT,
    "action" TEXT NOT NULL,
    "target_type" TEXT NOT NULL,
    "target_id" TEXT,
    "metadata" JSONB,
    "ip" TEXT,
    "user_agent" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "projects_user_id_created_at_idx" ON "projects"("user_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "brands_project_id_idx" ON "brands"("project_id");

-- CreateIndex
CREATE INDEX "competitors_project_id_idx" ON "competitors"("project_id");

-- CreateIndex
CREATE INDEX "queries_project_id_is_active_idx" ON "queries"("project_id", "is_active");

-- CreateIndex
CREATE UNIQUE INDEX "providers_code_key" ON "providers"("code");

-- CreateIndex
CREATE INDEX "provider_credentials_key_version_idx" ON "provider_credentials"("key_version");

-- CreateIndex
CREATE UNIQUE INDEX "provider_credentials_user_id_provider_id_key" ON "provider_credentials"("user_id", "provider_id");

-- CreateIndex
CREATE INDEX "runs_project_id_status_created_at_idx" ON "runs"("project_id", "status", "created_at" DESC);

-- CreateIndex
CREATE INDEX "run_tasks_run_id_status_idx" ON "run_tasks"("run_id", "status");

-- CreateIndex
CREATE INDEX "run_tasks_project_id_query_id_mode_created_at_idx" ON "run_tasks"("project_id", "query_id", "mode", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "run_tasks_run_id_query_id_provider_id_mode_key" ON "run_tasks"("run_id", "query_id", "provider_id", "mode");

-- CreateIndex
CREATE INDEX "run_samples_run_id_status_idx" ON "run_samples"("run_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "run_samples_task_id_sample_index_key" ON "run_samples"("task_id", "sample_index");

-- CreateIndex
CREATE UNIQUE INDEX "ai_responses_sample_id_key" ON "ai_responses"("sample_id");

-- CreateIndex
CREATE INDEX "citations_run_id_domain_idx" ON "citations"("run_id", "domain");

-- CreateIndex
CREATE INDEX "citations_project_id_domain_idx" ON "citations"("project_id", "domain");

-- CreateIndex
CREATE UNIQUE INDEX "citations_sample_id_normalized_url_extraction_version_key" ON "citations"("sample_id", "normalized_url", "extraction_version");

-- CreateIndex
CREATE INDEX "brand_mentions_run_id_brand_id_idx" ON "brand_mentions"("run_id", "brand_id");

-- CreateIndex
CREATE INDEX "brand_mentions_project_id_brand_id_idx" ON "brand_mentions"("project_id", "brand_id");

-- CreateIndex
CREATE UNIQUE INDEX "brand_mentions_sample_id_brand_id_extraction_version_occurr_key" ON "brand_mentions"("sample_id", "brand_id", "extraction_version", "occurrence_index");

-- CreateIndex
CREATE INDEX "competitor_mentions_run_id_competitor_id_idx" ON "competitor_mentions"("run_id", "competitor_id");

-- CreateIndex
CREATE INDEX "competitor_mentions_project_id_competitor_id_idx" ON "competitor_mentions"("project_id", "competitor_id");

-- CreateIndex
CREATE UNIQUE INDEX "competitor_mentions_sample_id_competitor_id_extraction_vers_key" ON "competitor_mentions"("sample_id", "competitor_id", "extraction_version", "occurrence_index");

-- CreateIndex
CREATE INDEX "sample_scores_run_id_scoring_version_idx" ON "sample_scores"("run_id", "scoring_version");

-- CreateIndex
CREATE INDEX "sample_scores_task_id_scoring_version_idx" ON "sample_scores"("task_id", "scoring_version");

-- CreateIndex
CREATE UNIQUE INDEX "sample_scores_sample_id_scoring_version_key" ON "sample_scores"("sample_id", "scoring_version");

-- CreateIndex
CREATE INDEX "task_scores_run_id_scoring_version_idx" ON "task_scores"("run_id", "scoring_version");

-- CreateIndex
CREATE UNIQUE INDEX "task_scores_task_id_scoring_version_key" ON "task_scores"("task_id", "scoring_version");

-- CreateIndex
CREATE UNIQUE INDEX "run_scores_run_id_mode_scoring_version_key" ON "run_scores"("run_id", "mode", "scoring_version");

-- CreateIndex
CREATE INDEX "voice_shares_run_id_mode_scoring_version_idx" ON "voice_shares"("run_id", "mode", "scoring_version");

-- CreateIndex
CREATE UNIQUE INDEX "voice_shares_run_id_task_id_mode_entity_kind_entity_id_scor_key" ON "voice_shares"("run_id", "task_id", "mode", "entity_kind", "entity_id", "scoring_version");

-- CreateIndex
CREATE UNIQUE INDEX "sentiment_judgments_cache_key_key" ON "sentiment_judgments"("cache_key");

-- CreateIndex
CREATE UNIQUE INDEX "jobs_sample_id_key" ON "jobs"("sample_id");

-- CreateIndex
CREATE INDEX "jobs_status_provider_code_available_at_priority_idx" ON "jobs"("status", "provider_code", "available_at", "priority");

-- CreateIndex
CREATE INDEX "jobs_status_lease_expires_at_idx" ON "jobs"("status", "lease_expires_at");

-- CreateIndex
CREATE INDEX "jobs_run_id_status_idx" ON "jobs"("run_id", "status");

-- CreateIndex
CREATE INDEX "audit_logs_project_id_created_at_idx" ON "audit_logs"("project_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "audit_logs_user_id_action_created_at_idx" ON "audit_logs"("user_id", "action", "created_at" DESC);

-- AddForeignKey
ALTER TABLE "projects" ADD CONSTRAINT "projects_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "brands" ADD CONSTRAINT "brands_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "competitors" ADD CONSTRAINT "competitors_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "queries" ADD CONSTRAINT "queries_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "provider_credentials" ADD CONSTRAINT "provider_credentials_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "provider_credentials" ADD CONSTRAINT "provider_credentials_provider_id_fkey" FOREIGN KEY ("provider_id") REFERENCES "providers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "runs" ADD CONSTRAINT "runs_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "run_tasks" ADD CONSTRAINT "run_tasks_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "run_tasks" ADD CONSTRAINT "run_tasks_query_id_fkey" FOREIGN KEY ("query_id") REFERENCES "queries"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "run_tasks" ADD CONSTRAINT "run_tasks_provider_id_fkey" FOREIGN KEY ("provider_id") REFERENCES "providers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "run_samples" ADD CONSTRAINT "run_samples_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "run_tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_responses" ADD CONSTRAINT "ai_responses_sample_id_fkey" FOREIGN KEY ("sample_id") REFERENCES "run_samples"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "citations" ADD CONSTRAINT "citations_sample_id_fkey" FOREIGN KEY ("sample_id") REFERENCES "run_samples"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "brand_mentions" ADD CONSTRAINT "brand_mentions_sample_id_fkey" FOREIGN KEY ("sample_id") REFERENCES "run_samples"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "brand_mentions" ADD CONSTRAINT "brand_mentions_brand_id_fkey" FOREIGN KEY ("brand_id") REFERENCES "brands"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "competitor_mentions" ADD CONSTRAINT "competitor_mentions_sample_id_fkey" FOREIGN KEY ("sample_id") REFERENCES "run_samples"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "competitor_mentions" ADD CONSTRAINT "competitor_mentions_competitor_id_fkey" FOREIGN KEY ("competitor_id") REFERENCES "competitors"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sample_scores" ADD CONSTRAINT "sample_scores_sample_id_fkey" FOREIGN KEY ("sample_id") REFERENCES "run_samples"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_scores" ADD CONSTRAINT "task_scores_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "run_tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "run_scores" ADD CONSTRAINT "run_scores_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "voice_shares" ADD CONSTRAINT "voice_shares_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "voice_shares" ADD CONSTRAINT "voice_shares_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "run_tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_sample_id_fkey" FOREIGN KEY ("sample_id") REFERENCES "run_samples"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Partial indexes for the job queue. Prisma's schema language cannot express a
-- WHERE clause on an index, and without these the claim query degrades to a
-- sequential scan over every terminal job once the table grows.
CREATE INDEX "jobs_claim_idx" ON "jobs" ("provider_code", "priority" DESC, "available_at", "id") WHERE "status" = 'QUEUED';
CREATE INDEX "jobs_lease_idx" ON "jobs" ("lease_expires_at") WHERE "status" = 'RUNNING';
