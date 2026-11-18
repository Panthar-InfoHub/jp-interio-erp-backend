-- CreateEnum
CREATE TYPE "onboarding_step" AS ENUM ('basic_info', 'partner_type', 'firm_details', 'payout_account', 'kyc_documents', 'submitted');

-- CreateEnum
CREATE TYPE "kyc_doc_type" AS ENUM ('pan', 'aadhaar', 'gst');

-- CreateEnum
CREATE TYPE "payout_method" AS ENUM ('bank', 'upi');

-- CreateEnum
CREATE TYPE "kyc_review_action" AS ENUM ('submitted', 'approved', 'rejected', 'rejection_undone');

-- AlterTable
ALTER TABLE "partner_profiles" ADD COLUMN     "onboarding_started_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "onboarding_step" "onboarding_step" NOT NULL DEFAULT 'basic_info',
ADD COLUMN     "owner_anniversary_date" DATE,
ADD COLUMN     "owner_dob" DATE,
ADD COLUMN     "owner_spouse_name" VARCHAR(100),
ADD COLUMN     "rejection_reason" VARCHAR(1000),
ADD COLUMN     "reviewed_at" TIMESTAMPTZ(3),
ADD COLUMN     "submitted_at" TIMESTAMPTZ(3);

-- CreateTable
CREATE TABLE "kyc_documents" (
    "id" UUID NOT NULL,
    "partner_id" UUID NOT NULL,
    "doc_type" "kyc_doc_type" NOT NULL,
    "number_encrypted" TEXT NOT NULL,
    "number_hash" VARCHAR(64) NOT NULL,
    "number_last4" VARCHAR(4) NOT NULL,
    "file_key" VARCHAR(500) NOT NULL,
    "file_mime_type" VARCHAR(100) NOT NULL,
    "file_size_bytes" INTEGER NOT NULL,
    "uploaded_by" UUID NOT NULL,
    "replaced_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "kyc_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payout_accounts" (
    "id" UUID NOT NULL,
    "partner_id" UUID NOT NULL,
    "method" "payout_method" NOT NULL,
    "holder_name" VARCHAR(150),
    "value_encrypted" TEXT NOT NULL,
    "value_hash" VARCHAR(64) NOT NULL,
    "value_last4" VARCHAR(4) NOT NULL,
    "ifsc" VARCHAR(11),
    "bank_name" VARCHAR(150),
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "added_by" UUID NOT NULL,
    "updated_by" UUID,
    "removed_at" TIMESTAMPTZ(3),
    "removed_by" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "payout_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "kyc_reviews" (
    "id" UUID NOT NULL,
    "partner_id" UUID NOT NULL,
    "action" "kyc_review_action" NOT NULL,
    "reason" VARCHAR(1000),
    "actor_id" UUID NOT NULL,
    "assigned_asm_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "kyc_reviews_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "kyc_documents_partner_id_doc_type_idx" ON "kyc_documents"("partner_id", "doc_type");

-- CreateIndex
CREATE INDEX "kyc_documents_doc_type_number_hash_idx" ON "kyc_documents"("doc_type", "number_hash");

-- CreateIndex
CREATE INDEX "payout_accounts_partner_id_removed_at_idx" ON "payout_accounts"("partner_id", "removed_at");

-- CreateIndex
CREATE INDEX "payout_accounts_method_value_hash_idx" ON "payout_accounts"("method", "value_hash");

-- CreateIndex
CREATE INDEX "kyc_reviews_partner_id_created_at_idx" ON "kyc_reviews"("partner_id", "created_at");

-- CreateIndex
CREATE INDEX "partner_profiles_onboarded_by_onboarding_step_idx" ON "partner_profiles"("onboarded_by", "onboarding_step");

-- CreateIndex
CREATE INDEX "partner_profiles_onboarding_step_onboarding_started_at_idx" ON "partner_profiles"("onboarding_step", "onboarding_started_at");

-- AddForeignKey
ALTER TABLE "kyc_documents" ADD CONSTRAINT "kyc_documents_partner_id_fkey" FOREIGN KEY ("partner_id") REFERENCES "partner_profiles"("user_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kyc_documents" ADD CONSTRAINT "kyc_documents_uploaded_by_fkey" FOREIGN KEY ("uploaded_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payout_accounts" ADD CONSTRAINT "payout_accounts_partner_id_fkey" FOREIGN KEY ("partner_id") REFERENCES "partner_profiles"("user_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payout_accounts" ADD CONSTRAINT "payout_accounts_added_by_fkey" FOREIGN KEY ("added_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payout_accounts" ADD CONSTRAINT "payout_accounts_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payout_accounts" ADD CONSTRAINT "payout_accounts_removed_by_fkey" FOREIGN KEY ("removed_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kyc_reviews" ADD CONSTRAINT "kyc_reviews_partner_id_fkey" FOREIGN KEY ("partner_id") REFERENCES "partner_profiles"("user_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kyc_reviews" ADD CONSTRAINT "kyc_reviews_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kyc_reviews" ADD CONSTRAINT "kyc_reviews_assigned_asm_id_fkey" FOREIGN KEY ("assigned_asm_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
