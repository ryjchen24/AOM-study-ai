-- AlterTable
ALTER TABLE "Message" ADD COLUMN     "edited" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "editedAt" TIMESTAMP(3),
ADD COLUMN     "kind" TEXT NOT NULL DEFAULT 'chat';
