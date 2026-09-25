ALTER TABLE "doc" DROP CONSTRAINT "doc_scope_check", ADD CONSTRAINT "doc_scope_check" CHECK ("scope" IN ('project','machine','agent','job','global','stack','resume','canon','settings'));--> statement-breakpoint
ALTER TABLE "doc" DROP CONSTRAINT "doc_subject_check", ADD CONSTRAINT "doc_subject_check" CHECK ((
  ("owner_user_id" IS NOT NULL AND "scope" IN ('canon','settings') AND "subject" IS NULL) OR
  ("owner_user_id" IS NULL AND (
  ("scope" IN ('machine','global') AND "subject" IS NULL) OR
  ("scope" IN ('project','stack','agent','job','resume') AND "subject" IS NOT NULL) OR
  "scope" IN ('canon','settings')
  ))
));--> statement-breakpoint
ALTER TABLE "doc_revision" DROP CONSTRAINT "doc_revision_scope_check", ADD CONSTRAINT "doc_revision_scope_check" CHECK ("scope" IN ('project','machine','agent','job','global','stack','resume','canon','settings'));--> statement-breakpoint
ALTER TABLE "doc_revision" DROP CONSTRAINT "doc_revision_subject_check", ADD CONSTRAINT "doc_revision_subject_check" CHECK ((
  ("owner_user_id" IS NOT NULL AND "scope" IN ('canon','settings') AND "subject" IS NULL) OR
  ("owner_user_id" IS NULL AND (
  ("scope" IN ('machine','global') AND "subject" IS NULL) OR
  ("scope" IN ('project','stack','agent','job','resume') AND "subject" IS NOT NULL) OR
  "scope" IN ('canon','settings')
  ))
));