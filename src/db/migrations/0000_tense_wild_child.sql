CREATE TYPE "public"."operational_status" AS ENUM('active', 'temporarily_closed', 'under_renovation', 'closed');--> statement-breakpoint
CREATE TYPE "public"."submission_status" AS ENUM('draft', 'submitted', 'changes_requested', 'approved');--> statement-breakpoint
CREATE TABLE "block_reviews" (
	"submission_id" uuid NOT NULL,
	"block_key" text NOT NULL,
	"confirmed_by" text NOT NULL,
	"confirmed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "block_reviews_unique" UNIQUE("submission_id","block_key")
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"lounge_id" uuid,
	"submission_id" uuid,
	"actor" text NOT NULL,
	"action" text NOT NULL,
	"payload" jsonb,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "field_flags" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"submission_id" uuid NOT NULL,
	"field_key" text NOT NULL,
	"reason" text,
	"comment" text NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "field_values" (
	"submission_id" uuid NOT NULL,
	"field_key" text NOT NULL,
	"value" jsonb,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "field_values_unique" UNIQUE("submission_id","field_key")
);
--> statement-breakpoint
CREATE TABLE "lounges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"provider" text,
	"country" text NOT NULL,
	"city" text NOT NULL,
	"airport" text NOT NULL,
	"iata_code" text NOT NULL,
	"operational_status" "operational_status" DEFAULT 'active' NOT NULL,
	"status_until" date,
	"status_comment" text,
	"terminal" text,
	"terminal_type" text,
	"zone" text[],
	"airside_landside" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "photos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"submission_id" uuid NOT NULL,
	"slot" text NOT NULL,
	"blob_key" text NOT NULL,
	"url" text NOT NULL,
	"caption" text,
	"uploaded_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "service_values" (
	"submission_id" uuid NOT NULL,
	"item_key" text NOT NULL,
	"available" text,
	"charge_type" text,
	"price" numeric(12, 2),
	"currency" text,
	"slot_minutes" integer,
	"booking_required" boolean,
	"details" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "service_values_unique" UNIQUE("submission_id","item_key")
);
--> statement-breakpoint
CREATE TABLE "submissions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"lounge_id" uuid NOT NULL,
	"status" "submission_status" DEFAULT 'draft' NOT NULL,
	"reviewer_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"status_changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"submitted_at" timestamp with time zone,
	"decided_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "block_reviews" ADD CONSTRAINT "block_reviews_submission_id_submissions_id_fk" FOREIGN KEY ("submission_id") REFERENCES "public"."submissions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_lounge_id_lounges_id_fk" FOREIGN KEY ("lounge_id") REFERENCES "public"."lounges"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_submission_id_submissions_id_fk" FOREIGN KEY ("submission_id") REFERENCES "public"."submissions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "field_flags" ADD CONSTRAINT "field_flags_submission_id_submissions_id_fk" FOREIGN KEY ("submission_id") REFERENCES "public"."submissions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "field_values" ADD CONSTRAINT "field_values_submission_id_submissions_id_fk" FOREIGN KEY ("submission_id") REFERENCES "public"."submissions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "photos" ADD CONSTRAINT "photos_submission_id_submissions_id_fk" FOREIGN KEY ("submission_id") REFERENCES "public"."submissions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_values" ADD CONSTRAINT "service_values_submission_id_submissions_id_fk" FOREIGN KEY ("submission_id") REFERENCES "public"."submissions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "submissions" ADD CONSTRAINT "submissions_lounge_id_lounges_id_fk" FOREIGN KEY ("lounge_id") REFERENCES "public"."lounges"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "field_flags_submission_idx" ON "field_flags" USING btree ("submission_id");--> statement-breakpoint
CREATE INDEX "lounges_iata_idx" ON "lounges" USING btree ("iata_code");--> statement-breakpoint
CREATE INDEX "lounges_operational_status_idx" ON "lounges" USING btree ("operational_status");--> statement-breakpoint
CREATE INDEX "submissions_lounge_idx" ON "submissions" USING btree ("lounge_id","created_at");