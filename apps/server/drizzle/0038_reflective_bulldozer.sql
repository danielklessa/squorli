CREATE TABLE IF NOT EXISTS "local_devices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"device_key" text NOT NULL,
	"label" text,
	"origin" text,
	"enrolled_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"revoked_why" text
);
--> statement-breakpoint
ALTER TABLE "local_accounts" ADD COLUMN "devices_enforced_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "device_key" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "devices_enforced" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "device_keys" jsonb;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "local_devices" ADD CONSTRAINT "local_devices_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "local_devices_user_key_idx" ON "local_devices" USING btree ("user_id","device_key");