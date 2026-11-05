CREATE TABLE "reaction_outbox" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "reaction_outbox_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"channel" text NOT NULL,
	"ts" text NOT NULL,
	"pr_url" text NOT NULL,
	"review_id" text,
	"seq" integer NOT NULL,
	"op" text NOT NULL,
	"emoji" text NOT NULL,
	"state" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone NOT NULL,
	"lease_owner" text,
	"lease_until" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "reaction_outbox_op_check" CHECK ("op" IN ('add', 'remove')),
	CONSTRAINT "reaction_outbox_state_check" CHECK ("state" IN ('pending', 'running', 'done', 'failed', 'superseded')),
	CONSTRAINT "reaction_outbox_seq_check" CHECK ("seq" >= 0)
);
--> statement-breakpoint
CREATE TABLE "review_result" (
	"id" text PRIMARY KEY,
	"job_id" text NOT NULL,
	"run" integer NOT NULL,
	"pr_url" text NOT NULL,
	"owner" text NOT NULL,
	"repo" text NOT NULL,
	"number" integer NOT NULL,
	"head_sha" text,
	"base_sha" text,
	"source" text NOT NULL,
	"requester_kind" text NOT NULL,
	"requester_id" text NOT NULL,
	"provider" text,
	"model" text,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone NOT NULL,
	"status" text NOT NULL,
	"verdict" text,
	"error_category" text,
	"summary" text,
	"findings" jsonb NOT NULL,
	CONSTRAINT "review_result_status_check" CHECK ("status" IN ('completed', 'failed')),
	CONSTRAINT "review_result_source_check" CHECK ("source" IN ('slack', 'web')),
	CONSTRAINT "review_result_verdict_check" CHECK (("status" = 'completed' AND "verdict" IN ('pass', 'changes_requested') AND "error_category" IS NULL)
        OR ("status" = 'failed' AND "verdict" IS NULL AND "error_category" IS NOT NULL)),
	CONSTRAINT "review_result_run_check" CHECK ("run" >= 1),
	CONSTRAINT "review_result_number_check" CHECK ("number" >= 1),
	CONSTRAINT "review_result_time_check" CHECK ("finished_at" >= "started_at")
);
--> statement-breakpoint
CREATE TABLE "slack_reaction" (
	"channel" text,
	"ts" text,
	"emoji" text,
	"state" text NOT NULL,
	"pr_url" text NOT NULL,
	"review_id" text,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "slack_reaction_pkey" PRIMARY KEY("channel","ts","emoji"),
	CONSTRAINT "slack_reaction_state_check" CHECK ("state" IN ('placed', 'removed'))
);
--> statement-breakpoint
CREATE TABLE "slack_review_thread" (
	"channel" text,
	"thread_ts" text,
	"pr_urls" jsonb NOT NULL,
	"requester_slack_id" text NOT NULL,
	"latest_review_id" text NOT NULL,
	"review_seq" integer NOT NULL,
	"status_message_ts" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "slack_review_thread_pkey" PRIMARY KEY("channel","thread_ts"),
	CONSTRAINT "slack_review_thread_seq_check" CHECK ("review_seq" >= 1)
);
--> statement-breakpoint
ALTER TABLE "review_job" ADD COLUMN "run_started_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "reaction_outbox_message_idx" ON "reaction_outbox" ("channel","ts","id");--> statement-breakpoint
CREATE INDEX "reaction_outbox_due_idx" ON "reaction_outbox" ("next_attempt_at","id") WHERE "state" IN ('pending', 'running');--> statement-breakpoint
CREATE UNIQUE INDEX "review_result_run_idx" ON "review_result" ("job_id","pr_url","run");--> statement-breakpoint
CREATE INDEX "review_result_finished_idx" ON "review_result" ("finished_at","id");--> statement-breakpoint
CREATE INDEX "review_result_pr_url_idx" ON "review_result" ("pr_url","finished_at");--> statement-breakpoint
CREATE INDEX "review_result_repo_idx" ON "review_result" (lower("owner"),lower("repo"),"number");--> statement-breakpoint
-- Hand-written data step (stage 3w): the `reaction_pending` state is gone; reactions now go
-- through `reaction_outbox`. Those jobs' reviews already finished, so they become `done`
-- (no retry time, no lease, as for any terminal job). `updated_at` is kept so retention ages
-- them from when they finished; `version` is bumped so a worker holding the old row is fenced out.
UPDATE "review_job"
SET "state" = 'done',
    "next_attempt_at" = NULL,
    "lease_owner" = NULL,
    "lease_until" = NULL,
    "version" = "version" + 1
WHERE "state" = 'reaction_pending';
