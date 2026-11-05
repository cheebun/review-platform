CREATE TABLE "setting_secret" (
	"kind" text PRIMARY KEY,
	"ciphertext" text NOT NULL,
	"iv" text NOT NULL,
	"auth_tag" text NOT NULL,
	"key_version" integer NOT NULL,
	"last4" text NOT NULL,
	"saved_at" timestamp with time zone NOT NULL,
	"saved_by_user_id" text NOT NULL,
	"verified_at" timestamp with time zone,
	"test_result" jsonb,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "setting_secret_kind_check" CHECK ("kind" IN ('slack_user_token', 'slack_signing_secret', 'slack_app_token', 'jira_api_token', 'anthropic_api_key', 'anthropic_auth_token', 'openai_api_key')),
	CONSTRAINT "setting_secret_version_check" CHECK ("version" >= 1)
);
--> statement-breakpoint
CREATE TABLE "slack_review_channel" (
	"channel_id" text PRIMARY KEY,
	"name" text NOT NULL,
	"missing" boolean DEFAULT false NOT NULL,
	"checked_at" timestamp with time zone,
	"added_at" timestamp with time zone NOT NULL,
	"added_by" text NOT NULL,
	CONSTRAINT "slack_review_channel_id_check" CHECK ("channel_id" ~ '^[CG][A-Z0-9]+$')
);
--> statement-breakpoint
ALTER TABLE "review_job" DROP COLUMN "github_account";--> statement-breakpoint
CREATE INDEX "slack_review_channel_name_idx" ON "slack_review_channel" ("name","channel_id");