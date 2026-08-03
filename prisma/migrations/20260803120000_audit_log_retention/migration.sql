-- DropForeignKey
ALTER TABLE "audit_logs" DROP CONSTRAINT "audit_logs_project_id_fkey";

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE SET NULL ON UPDATE CASCADE;
