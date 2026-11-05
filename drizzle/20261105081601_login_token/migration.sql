CREATE TABLE "login_token" (
	"id" smallint PRIMARY KEY,
	"token_hash" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"rotated_at" timestamp with time zone,
	CONSTRAINT "login_token_singleton" CHECK ("id" = 1),
	CONSTRAINT "login_token_hash_check" CHECK (starts_with("token_hash", 'pbkdf2-sha256$'))
);
