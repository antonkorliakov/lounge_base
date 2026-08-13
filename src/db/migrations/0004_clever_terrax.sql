ALTER TABLE "team_members" ADD COLUMN "password_hash" text;--> statement-breakpoint
ALTER TABLE "team_members" ADD COLUMN "failed_password_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "team_members" ADD COLUMN "password_locked_until" timestamp with time zone;