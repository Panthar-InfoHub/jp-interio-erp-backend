-- CreateEnum
CREATE TYPE "scan_fail_reason" AS ENUM ('invalid_code', 'already_scanned', 'voided');

-- CreateTable
CREATE TABLE "scans" (
    "id" UUID NOT NULL,
    "qr_code_id" UUID NOT NULL,
    "partner_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "batch_id" UUID NOT NULL,
    "points" INTEGER NOT NULL,
    "zone_id" UUID,
    "owning_asm_id" UUID,
    "device_id" VARCHAR(100),
    "ip" VARCHAR(45),
    "scanned_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "scans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scan_attempts" (
    "id" UUID NOT NULL,
    "partner_id" UUID NOT NULL,
    "input" VARCHAR(500) NOT NULL,
    "code" VARCHAR(12),
    "qr_code_id" UUID,
    "reason" "scan_fail_reason" NOT NULL,
    "device_id" VARCHAR(100),
    "ip" VARCHAR(45),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "scan_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "scans_qr_code_id_key" ON "scans"("qr_code_id");

-- CreateIndex
CREATE INDEX "scans_partner_id_scanned_at_idx" ON "scans"("partner_id", "scanned_at");

-- CreateIndex
CREATE INDEX "scans_product_id_scanned_at_idx" ON "scans"("product_id", "scanned_at");

-- CreateIndex
CREATE INDEX "scans_batch_id_idx" ON "scans"("batch_id");

-- CreateIndex
CREATE INDEX "scans_zone_id_scanned_at_idx" ON "scans"("zone_id", "scanned_at");

-- CreateIndex
CREATE INDEX "scans_owning_asm_id_scanned_at_idx" ON "scans"("owning_asm_id", "scanned_at");

-- CreateIndex
CREATE INDEX "scans_scanned_at_idx" ON "scans"("scanned_at");

-- CreateIndex
CREATE INDEX "scan_attempts_partner_id_created_at_idx" ON "scan_attempts"("partner_id", "created_at");

-- CreateIndex
CREATE INDEX "scan_attempts_reason_created_at_idx" ON "scan_attempts"("reason", "created_at");

-- CreateIndex
CREATE INDEX "scan_attempts_qr_code_id_idx" ON "scan_attempts"("qr_code_id");

-- CreateIndex
CREATE INDEX "scan_attempts_created_at_idx" ON "scan_attempts"("created_at");

-- AddForeignKey
ALTER TABLE "scans" ADD CONSTRAINT "scans_qr_code_id_fkey" FOREIGN KEY ("qr_code_id") REFERENCES "qr_codes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scans" ADD CONSTRAINT "scans_partner_id_fkey" FOREIGN KEY ("partner_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scans" ADD CONSTRAINT "scans_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scans" ADD CONSTRAINT "scans_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "qr_batches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scans" ADD CONSTRAINT "scans_zone_id_fkey" FOREIGN KEY ("zone_id") REFERENCES "zones"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scans" ADD CONSTRAINT "scans_owning_asm_id_fkey" FOREIGN KEY ("owning_asm_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scan_attempts" ADD CONSTRAINT "scan_attempts_partner_id_fkey" FOREIGN KEY ("partner_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scan_attempts" ADD CONSTRAINT "scan_attempts_qr_code_id_fkey" FOREIGN KEY ("qr_code_id") REFERENCES "qr_codes"("id") ON DELETE SET NULL ON UPDATE CASCADE;
