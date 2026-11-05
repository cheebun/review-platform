CREATE TABLE "app_state" (
	"key" text PRIMARY KEY,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "digest" (
	"id" text PRIMARY KEY,
	"window_start" timestamp with time zone NOT NULL,
	"window_end" timestamp with time zone NOT NULL,
	"generated_at" timestamp with time zone NOT NULL,
	"item_count" integer NOT NULL,
	"body" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "digest_message" (
	"channel" text,
	"ts" text,
	"ts_ms" bigint NOT NULL,
	"day" text NOT NULL,
	"source" text NOT NULL,
	"payload" jsonb NOT NULL,
	"captured_at" timestamp with time zone NOT NULL,
	CONSTRAINT "digest_message_pkey" PRIMARY KEY("channel","ts")
);
--> statement-breakpoint
CREATE TABLE "digest_read" (
	"user_id" text,
	"digest_id" text,
	"item_key" text,
	"read_at" timestamp with time zone NOT NULL,
	CONSTRAINT "digest_read_pkey" PRIMARY KEY("user_id","digest_id","item_key")
);
--> statement-breakpoint
CREATE TABLE "read_cursor" (
	"user_id" text,
	"kind" text,
	"read_before" timestamp with time zone NOT NULL,
	CONSTRAINT "read_cursor_pkey" PRIMARY KEY("user_id","kind")
);
--> statement-breakpoint
CREATE TABLE "review_job" (
	"id" text PRIMARY KEY,
	"source" text NOT NULL,
	"state" text NOT NULL,
	"urls" jsonb NOT NULL,
	"progress" jsonb NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"lease_owner" text,
	"lease_until" timestamp with time zone,
	"slack" jsonb,
	"actor_user_id" text,
	"github_account" text NOT NULL,
	"last_error" text,
	"result_reply_sent" boolean,
	"interruptions" integer,
	"expires_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "review_job_read" (
	"user_id" text,
	"job_id" text,
	"read_at" timestamp with time zone NOT NULL,
	CONSTRAINT "review_job_read_pkey" PRIMARY KEY("user_id","job_id")
);
--> statement-breakpoint
CREATE INDEX "digest_generated_at_idx" ON "digest" ("generated_at");--> statement-breakpoint
CREATE INDEX "digest_message_ts_ms_idx" ON "digest_message" ("ts_ms");--> statement-breakpoint
CREATE INDEX "review_job_claim_idx" ON "review_job" ("state","next_attempt_at","created_at");--> statement-breakpoint
CREATE INDEX "review_job_lease_idx" ON "review_job" ("lease_until") WHERE "state" = 'running';--> statement-breakpoint
CREATE INDEX "review_job_created_idx" ON "review_job" ("created_at");