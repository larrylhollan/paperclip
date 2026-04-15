DO $$ BEGIN
  CREATE TYPE "public"."jit_pre_approval_status" AS ENUM('pending', 'approved', 'rejected', 'expired', 'exchanged');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE TABLE "jit_pre_approvals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"issue_id" uuid NOT NULL,
	"target" text NOT NULL,
	"role" text NOT NULL,
	"reason" text NOT NULL,
	"status" "jit_pre_approval_status" DEFAULT 'pending' NOT NULL,
	"approved_by_user_id" text,
	"approved_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"exchanged_at" timestamp with time zone,
	"exchanged_by_run_id" uuid,
	"renewal_count" integer DEFAULT 0 NOT NULL,
	"credential_expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "jit_pre_approvals" ADD CONSTRAINT "jit_pre_approvals_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "jit_pre_approvals_issue_id_idx" ON "jit_pre_approvals" USING btree ("issue_id");
--> statement-breakpoint
CREATE INDEX "jit_pre_approvals_status_idx" ON "jit_pre_approvals" USING btree ("status");
--> statement-breakpoint
CREATE INDEX "jit_pre_approvals_expires_at_idx" ON "jit_pre_approvals" USING btree ("expires_at");
