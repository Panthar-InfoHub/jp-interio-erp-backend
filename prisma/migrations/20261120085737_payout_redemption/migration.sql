-- CreateEnum
CREATE TYPE "payout_status" AS ENUM ('requested', 'approved', 'paid', 'declined', 'failed');

-- CreateEnum
CREATE TYPE "payout_paid_method" AS ENUM ('cash', 'upi', 'bank_transfer');

-- CreateTable
CREATE TABLE "payouts" (
    "id" UUID NOT NULL,
    "payout_no" VARCHAR(20) NOT NULL,
    "year" SMALLINT NOT NULL,
    "seq" INTEGER NOT NULL,
    "partner_id" UUID NOT NULL,
    "points" INTEGER NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "status" "payout_status" NOT NULL DEFAULT 'requested',
    "partner_note" VARCHAR(500),
    "payout_account_id" UUID NOT NULL,
    "account_method" "payout_method" NOT NULL,
    "account_holder_name" VARCHAR(150),
    "account_value_encrypted" TEXT NOT NULL,
    "account_last4" VARCHAR(4) NOT NULL,
    "account_ifsc" VARCHAR(11),
    "account_bank_name" VARCHAR(150),
    "zone_id" UUID,
    "owning_asm_id" UUID,
    "idempotency_key" VARCHAR(100) NOT NULL,
    "approved_by" UUID,
    "approved_at" TIMESTAMPTZ(3),
    "declined_by" UUID,
    "declined_at" TIMESTAMPTZ(3),
    "decline_reason" VARCHAR(500),
    "paid_by" UUID,
    "paid_at" TIMESTAMPTZ(3),
    "paid_method" "payout_paid_method",
    "transaction_id" VARCHAR(100),
    "proof_url" VARCHAR(1000),
    "failed_by" UUID,
    "failed_at" TIMESTAMPTZ(3),
    "failure_reason" VARCHAR(500),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "payouts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "payouts_payout_no_key" ON "payouts"("payout_no");

-- CreateIndex
CREATE INDEX "payouts_partner_id_created_at_idx" ON "payouts"("partner_id", "created_at");

-- CreateIndex
CREATE INDEX "payouts_status_created_at_idx" ON "payouts"("status", "created_at");

-- CreateIndex
CREATE INDEX "payouts_zone_id_status_idx" ON "payouts"("zone_id", "status");

-- CreateIndex
CREATE INDEX "payouts_owning_asm_id_status_idx" ON "payouts"("owning_asm_id", "status");

-- CreateIndex
CREATE INDEX "payouts_created_at_idx" ON "payouts"("created_at");

-- CreateIndex
CREATE UNIQUE INDEX "payouts_year_seq_key" ON "payouts"("year", "seq");

-- CreateIndex
CREATE UNIQUE INDEX "payouts_partner_id_idempotency_key_key" ON "payouts"("partner_id", "idempotency_key");

-- AddForeignKey
ALTER TABLE "payouts" ADD CONSTRAINT "payouts_partner_id_fkey" FOREIGN KEY ("partner_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payouts" ADD CONSTRAINT "payouts_payout_account_id_fkey" FOREIGN KEY ("payout_account_id") REFERENCES "payout_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payouts" ADD CONSTRAINT "payouts_zone_id_fkey" FOREIGN KEY ("zone_id") REFERENCES "zones"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payouts" ADD CONSTRAINT "payouts_owning_asm_id_fkey" FOREIGN KEY ("owning_asm_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payouts" ADD CONSTRAINT "payouts_approved_by_fkey" FOREIGN KEY ("approved_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payouts" ADD CONSTRAINT "payouts_declined_by_fkey" FOREIGN KEY ("declined_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payouts" ADD CONSTRAINT "payouts_paid_by_fkey" FOREIGN KEY ("paid_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payouts" ADD CONSTRAINT "payouts_failed_by_fkey" FOREIGN KEY ("failed_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
