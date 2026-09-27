ALTER TABLE "server_settings" ADD COLUMN "refuse_suspended" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "suspended_until" timestamp with time zone;