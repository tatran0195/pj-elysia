-- Clean break from better-auth.
--
-- The session token format changed (the database now stores only a SHA-256 hash),
-- API keys are hashed the same way, and passwords move from account.password
-- (scrypt) to user.password_hash (argon2id). None of those can be converted, so
-- the rows that carry them are dropped: everyone signs in again, and existing
-- accounts go through a password reset. Provider links and passkeys are re-created
-- by the user.
DELETE FROM "session";--> statement-breakpoint
DELETE FROM "apikey";--> statement-breakpoint
DELETE FROM "passkey";--> statement-breakpoint
DELETE FROM "account";--> statement-breakpoint
CREATE TABLE "auth_activity" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text,
	"event" text NOT NULL,
	"identifier" text,
	"ip_address" text,
	"user_agent" text,
	"device_label" text,
	"detail" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auth_token" (
	"id" text PRIMARY KEY NOT NULL,
	"purpose" text NOT NULL,
	"token_hash" text NOT NULL,
	"identifier" text NOT NULL,
	"user_id" text,
	"expires_at" timestamp NOT NULL,
	"consumed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "auth_token_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "oauth_state" (
	"state" text PRIMARY KEY NOT NULL,
	"provider_id" text NOT NULL,
	"code_verifier" text NOT NULL,
	"nonce" text,
	"redirect_to" text,
	"link_user_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"expires_at" timestamp NOT NULL
);
--> statement-breakpoint
ALTER TABLE "verification" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "verification" CASCADE;--> statement-breakpoint
ALTER TABLE "session" DROP CONSTRAINT "session_token_unique";--> statement-breakpoint
DROP INDEX "account_userId_idx";--> statement-breakpoint
DROP INDEX "apikey_configId_idx";--> statement-breakpoint
DROP INDEX "apikey_referenceId_idx";--> statement-breakpoint
DROP INDEX "apikey_key_idx";--> statement-breakpoint
DROP INDEX "passkey_userId_idx";--> statement-breakpoint
DROP INDEX "passkey_credentialID_idx";--> statement-breakpoint
DROP INDEX "session_userId_idx";--> statement-breakpoint
ALTER TABLE "account" ALTER COLUMN "updated_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "apikey" ALTER COLUMN "enabled" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "apikey" ALTER COLUMN "request_count" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "apikey" ALTER COLUMN "created_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "apikey" ALTER COLUMN "updated_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "passkey" ALTER COLUMN "counter" SET DEFAULT 0;--> statement-breakpoint
ALTER TABLE "passkey" ALTER COLUMN "device_type" SET DEFAULT '';--> statement-breakpoint
ALTER TABLE "passkey" ALTER COLUMN "backed_up" SET DEFAULT false;--> statement-breakpoint
ALTER TABLE "passkey" ALTER COLUMN "created_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "passkey" ALTER COLUMN "created_at" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "apikey" ADD COLUMN "key_hash" text NOT NULL;--> statement-breakpoint
ALTER TABLE "apikey" ADD COLUMN "last_request_at" timestamp;--> statement-breakpoint
ALTER TABLE "passkey" ADD COLUMN "last_used_at" timestamp;--> statement-breakpoint
ALTER TABLE "session" ADD COLUMN "id_hash" text NOT NULL;--> statement-breakpoint
ALTER TABLE "session" ADD COLUMN "last_seen_at" timestamp DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "session" ADD COLUMN "device_label" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "session" ADD COLUMN "revoked_at" timestamp;--> statement-breakpoint
ALTER TABLE "session" ADD COLUMN "mfa_passed_at" timestamp;--> statement-breakpoint
ALTER TABLE "session" ADD COLUMN "step_up_expires_at" timestamp;--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "password_hash" text;--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "password_changed_at" timestamp;--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "failed_login_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "locked_until" timestamp;--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "mfa_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "mfa_enabled_at" timestamp;--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "mfa_secret_ciphertext" text;--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "mfa_secret_iv" text;--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "mfa_secret_auth_tag" text;--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "mfa_secret_key_fingerprint" text;--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "mfa_recovery_code_hashes" jsonb;--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "step_up_mode" text DEFAULT 'sensitive' NOT NULL;--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "step_up_window_minutes" integer DEFAULT 15 NOT NULL;--> statement-breakpoint
ALTER TABLE "auth_activity" ADD CONSTRAINT "auth_activity_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_token" ADD CONSTRAINT "auth_token_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_state" ADD CONSTRAINT "oauth_state_link_user_id_user_id_fk" FOREIGN KEY ("link_user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "auth_activity_user_id_idx" ON "auth_activity" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "auth_activity_created_at_idx" ON "auth_activity" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "auth_token_identifier_idx" ON "auth_token" USING btree ("identifier");--> statement-breakpoint
CREATE INDEX "auth_token_expires_at_idx" ON "auth_token" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "oauth_state_expires_at_idx" ON "oauth_state" USING btree ("expires_at");--> statement-breakpoint
ALTER TABLE "apikey" ADD CONSTRAINT "apikey_reference_id_user_id_fk" FOREIGN KEY ("reference_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "account_user_id_idx" ON "account" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "account_provider_idx" ON "account" USING btree ("provider_id","account_id");--> statement-breakpoint
CREATE INDEX "apikey_reference_id_idx" ON "apikey" USING btree ("reference_id");--> statement-breakpoint
CREATE INDEX "passkey_user_id_idx" ON "passkey" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "session_user_id_idx" ON "session" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "session_last_seen_at_idx" ON "session" USING btree ("last_seen_at");--> statement-breakpoint
ALTER TABLE "account" DROP COLUMN "password";--> statement-breakpoint
ALTER TABLE "apikey" DROP COLUMN "config_id";--> statement-breakpoint
ALTER TABLE "apikey" DROP COLUMN "prefix";--> statement-breakpoint
ALTER TABLE "apikey" DROP COLUMN "key";--> statement-breakpoint
ALTER TABLE "apikey" DROP COLUMN "refill_interval";--> statement-breakpoint
ALTER TABLE "apikey" DROP COLUMN "refill_amount";--> statement-breakpoint
ALTER TABLE "apikey" DROP COLUMN "last_refill_at";--> statement-breakpoint
ALTER TABLE "apikey" DROP COLUMN "rate_limit_enabled";--> statement-breakpoint
ALTER TABLE "apikey" DROP COLUMN "rate_limit_time_window";--> statement-breakpoint
ALTER TABLE "apikey" DROP COLUMN "rate_limit_max";--> statement-breakpoint
ALTER TABLE "apikey" DROP COLUMN "remaining";--> statement-breakpoint
ALTER TABLE "apikey" DROP COLUMN "last_request";--> statement-breakpoint
ALTER TABLE "session" DROP COLUMN "token";--> statement-breakpoint
ALTER TABLE "session" DROP COLUMN "updated_at";--> statement-breakpoint
ALTER TABLE "apikey" ADD CONSTRAINT "apikey_key_hash_unique" UNIQUE("key_hash");--> statement-breakpoint
ALTER TABLE "passkey" ADD CONSTRAINT "passkey_credential_id_unique" UNIQUE("credential_id");--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_id_hash_unique" UNIQUE("id_hash");