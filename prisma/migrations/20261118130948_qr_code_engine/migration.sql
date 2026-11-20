-- CreateEnum
CREATE TYPE "qr_batch_status" AS ENUM ('generated', 'exported', 'voided');

-- CreateEnum
CREATE TYPE "qr_code_status" AS ENUM ('active', 'scanned', 'void');

-- CreateTable
CREATE TABLE "qr_batches" (
    "id" UUID NOT NULL,
    "batch_no" VARCHAR(20) NOT NULL,
    "year" SMALLINT NOT NULL,
    "seq" INTEGER NOT NULL,
    "product_id" UUID NOT NULL,
    "quantity" INTEGER NOT NULL,
    "points_per_code" INTEGER NOT NULL,
    "status" "qr_batch_status" NOT NULL DEFAULT 'generated',
    "notes" VARCHAR(500),
    "created_by_id" UUID NOT NULL,
    "first_exported_at" TIMESTAMPTZ(3),
    "voided_at" TIMESTAMPTZ(3),
    "voided_by_id" UUID,
    "void_reason" VARCHAR(500),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "qr_batches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "qr_codes" (
    "id" UUID NOT NULL,
    "code" VARCHAR(12) NOT NULL,
    "batch_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "status" "qr_code_status" NOT NULL DEFAULT 'active',
    "scanned_by_id" UUID,
    "scanned_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "qr_codes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "qr_batch_exports" (
    "id" UUID NOT NULL,
    "batch_id" UUID NOT NULL,
    "exported_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "qr_batch_exports_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "qr_batches_batch_no_key" ON "qr_batches"("batch_no");

-- CreateIndex
CREATE INDEX "qr_batches_product_id_idx" ON "qr_batches"("product_id");

-- CreateIndex
CREATE INDEX "qr_batches_status_idx" ON "qr_batches"("status");

-- CreateIndex
CREATE INDEX "qr_batches_created_at_idx" ON "qr_batches"("created_at");

-- CreateIndex
CREATE UNIQUE INDEX "qr_batches_year_seq_key" ON "qr_batches"("year", "seq");

-- CreateIndex
CREATE UNIQUE INDEX "qr_codes_code_key" ON "qr_codes"("code");

-- CreateIndex
CREATE INDEX "qr_codes_batch_id_status_idx" ON "qr_codes"("batch_id", "status");

-- CreateIndex
CREATE INDEX "qr_codes_product_id_idx" ON "qr_codes"("product_id");

-- CreateIndex
CREATE INDEX "qr_codes_scanned_by_id_idx" ON "qr_codes"("scanned_by_id");

-- CreateIndex
CREATE INDEX "qr_batch_exports_batch_id_created_at_idx" ON "qr_batch_exports"("batch_id", "created_at");

-- AddForeignKey
ALTER TABLE "qr_batches" ADD CONSTRAINT "qr_batches_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "qr_batches" ADD CONSTRAINT "qr_batches_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "qr_batches" ADD CONSTRAINT "qr_batches_voided_by_id_fkey" FOREIGN KEY ("voided_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "qr_codes" ADD CONSTRAINT "qr_codes_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "qr_batches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "qr_codes" ADD CONSTRAINT "qr_codes_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "qr_codes" ADD CONSTRAINT "qr_codes_scanned_by_id_fkey" FOREIGN KEY ("scanned_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "qr_batch_exports" ADD CONSTRAINT "qr_batch_exports_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "qr_batches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "qr_batch_exports" ADD CONSTRAINT "qr_batch_exports_exported_by_id_fkey" FOREIGN KEY ("exported_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
