CREATE TABLE "jit_issuances" (
	"id" uuid PRIMARY KEY NOT NULL,
	"issue_id" uuid NOT NULL,
	"payload" jsonb NOT NULL,
	"resolved_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "jit_issuances" ADD CONSTRAINT "jit_issuances_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "jit_issuances_issue_id_idx" ON "jit_issuances" USING btree ("issue_id");--> statement-breakpoint
CREATE INDEX "jit_issuances_expires_at_idx" ON "jit_issuances" USING btree ("expires_at");
