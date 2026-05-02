-- AlterTable
ALTER TABLE "SessionMessage" ADD COLUMN     "expiresAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "SessionMessage_expiresAt_idx" ON "SessionMessage"("expiresAt");
