CREATE TABLE "github_credential" (
	"id" text PRIMARY KEY,
	"ciphertext" text NOT NULL,
	"iv" text NOT NULL,
	"auth_tag" text NOT NULL,
	"key_version" integer NOT NULL,
	"login" text NOT NULL,
	"avatar_url" text NOT NULL,
	"last4" text NOT NULL,
	"permissions" jsonb NOT NULL,
	"saved_at" timestamp with time zone NOT NULL,
	"saved_by_user_id" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "github_credential_singleton" CHECK ("id" = 'github')
);
--> statement-breakpoint
CREATE TABLE "github_repo" (
	"canonical" text PRIMARY KEY,
	"owner" text NOT NULL,
	"repo" text NOT NULL,
	"access" text NOT NULL,
	"permissions" jsonb,
	"checked_at" timestamp with time zone,
	"added_at" timestamp with time zone NOT NULL,
	"added_by" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "review_event" (
	"id" text PRIMARY KEY,
	"type" text NOT NULL,
	"actor_kind" text NOT NULL,
	"actor_id" text NOT NULL,
	"pr_url" text,
	"review_id" text,
	"job_id" text,
	"sha" text,
	"reason" text,
	"source" text,
	"detail" jsonb,
	"at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "github_repo_canonical_lower_idx" ON "github_repo" (lower("canonical"));--> statement-breakpoint
CREATE INDEX "github_repo_added_at_idx" ON "github_repo" ("added_at");--> statement-breakpoint
CREATE INDEX "review_event_at_idx" ON "review_event" ("at");--> statement-breakpoint
CREATE INDEX "review_event_pr_url_at_idx" ON "review_event" ("pr_url","at");--> statement-breakpoint
CREATE UNIQUE INDEX "review_event_step_idx" ON "review_event" ("job_id",coalesce("pr_url", ''),"type") WHERE "job_id" IS NOT NULL;--> statement-breakpoint
-- Hand-written (drizzle-kit does not model triggers): review_event is append-only (FR-REVIEW-06).
-- TRUNCATE is not a row event, so test fixtures can still empty the table.
CREATE FUNCTION "review_event_append_only"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'review_event is append-only' USING ERRCODE = 'insufficient_privilege';
END;
$$;--> statement-breakpoint
CREATE TRIGGER "review_event_append_only" BEFORE UPDATE OR DELETE ON "review_event"
  FOR EACH ROW EXECUTE FUNCTION "review_event_append_only"();
