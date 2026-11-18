/*
  Warnings:

  - You are about to drop the column `file_key` on the `kyc_documents` table. All the data in the column will be lost.
  - Added the required column `file_url` to the `kyc_documents` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "kyc_documents" DROP COLUMN "file_key",
ADD COLUMN     "file_url" VARCHAR(1000) NOT NULL;
