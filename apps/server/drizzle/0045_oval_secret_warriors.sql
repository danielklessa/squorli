CREATE TABLE "plugin_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"plugin_id" text NOT NULL,
	"key" text,
	"name" text NOT NULL,
	"payload" jsonb,
	"due_at" timestamp with time zone NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"claimed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "plugin_log" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"plugin_id" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"level" text NOT NULL,
	"source" text NOT NULL,
	"message" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "plugin_storage" (
	"plugin_id" text NOT NULL,
	"key" text NOT NULL,
	"value" jsonb NOT NULL,
	"bytes" integer NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "plugin_storage_plugin_id_key_pk" PRIMARY KEY("plugin_id","key")
);
--> statement-breakpoint
CREATE TABLE "plugins" (
	"id" text PRIMARY KEY NOT NULL,
	"manifest" jsonb NOT NULL,
	"source" text NOT NULL,
	"code" text NOT NULL,
	"language" text NOT NULL,
	"source_hash" text NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"state" text DEFAULT 'ok' NOT NULL,
	"granted" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"scope" jsonb DEFAULT '{"roles":{},"channels":[]}'::jsonb NOT NULL,
	"user_id" uuid,
	"last_error" text,
	"last_error_at" timestamp with time zone,
	"installed_by" uuid,
	"installed_by_name" text,
	"installed_via" text NOT NULL,
	"installed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "plugin" jsonb;--> statement-breakpoint
ALTER TABLE "plugin_jobs" ADD CONSTRAINT "plugin_jobs_plugin_id_plugins_id_fk" FOREIGN KEY ("plugin_id") REFERENCES "public"."plugins"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plugin_log" ADD CONSTRAINT "plugin_log_plugin_id_plugins_id_fk" FOREIGN KEY ("plugin_id") REFERENCES "public"."plugins"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plugin_storage" ADD CONSTRAINT "plugin_storage_plugin_id_plugins_id_fk" FOREIGN KEY ("plugin_id") REFERENCES "public"."plugins"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plugins" ADD CONSTRAINT "plugins_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plugins" ADD CONSTRAINT "plugins_installed_by_users_id_fk" FOREIGN KEY ("installed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "plugin_jobs_due_idx" ON "plugin_jobs" USING btree ("due_at");--> statement-breakpoint
CREATE UNIQUE INDEX "plugin_jobs_plugin_key_uq" ON "plugin_jobs" USING btree ("plugin_id","key");--> statement-breakpoint
CREATE INDEX "plugin_log_plugin_id_idx" ON "plugin_log" USING btree ("plugin_id","id");