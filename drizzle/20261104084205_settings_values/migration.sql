CREATE TABLE "setting_value" (
	"key" text PRIMARY KEY,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"updated_by" text NOT NULL,
	CONSTRAINT "setting_value_key_check" CHECK ("key" IN ('jira_base_url', 'jira_email', 'anthropic_base_url', 'anthropic_model', 'anthropic_auth_header', 'anthropic_server_fallback', 'openai_base_url', 'openai_model', 'openai_reasoning_effort')),
	CONSTRAINT "setting_value_value_check" CHECK (jsonb_typeof("value") = 'boolean' OR (jsonb_typeof("value") = 'string' AND length("value" #>> '{}') BETWEEN 1 AND 2048))
);
