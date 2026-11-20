/*
  Warnings:

  - The values [leads_requests] on the enum `sub_admin_area` will be removed. If these variants are still used in the database, this will fail.

*/
-- CreateEnum
CREATE TYPE "request_category" AS ENUM ('shipment', 'sample');

-- CreateEnum
CREATE TYPE "request_status" AS ENUM ('requested', 'accepted', 'rejected', 'payment_received', 'processing', 'dispatched', 'delivered', 'completed', 'cancelled', 'refund_initiated', 'refunded');

-- CreateEnum
CREATE TYPE "request_payment_mode" AS ENUM ('cash', 'upi', 'cheque', 'bank');

-- CreateEnum
CREATE TYPE "request_event_type" AS ENUM ('created', 'status_change', 'handler_change');

-- AlterEnum
BEGIN;
CREATE TYPE "sub_admin_area_new" AS ENUM ('products', 'qr', 'rewards', 'partners', 'tasks', 'requests');
ALTER TABLE "sub_admin_areas" ALTER COLUMN "area" TYPE "sub_admin_area_new" USING ("area"::text::"sub_admin_area_new");
ALTER TYPE "sub_admin_area" RENAME TO "sub_admin_area_old";
ALTER TYPE "sub_admin_area_new" RENAME TO "sub_admin_area";
DROP TYPE "public"."sub_admin_area_old";
COMMIT;

-- CreateTable
CREATE TABLE "partner_requests" (
    "id" UUID NOT NULL,
    "request_no" VARCHAR(20) NOT NULL,
    "year" SMALLINT NOT NULL,
    "seq" INTEGER NOT NULL,
    "partner_id" UUID NOT NULL,
    "category" "request_category" NOT NULL,
    "status" "request_status" NOT NULL DEFAULT 'requested',
    "handler_id" UUID NOT NULL,
    "zone_id" UUID,
    "owning_asm_id" UUID,
    "delivery_address" VARCHAR(500) NOT NULL,
    "preferred_delivery_date" DATE NOT NULL,
    "notes" VARCHAR(500),
    "agreed_amount" DECIMAL(12,2),
    "idempotency_key" VARCHAR(100) NOT NULL,
    "payment_date" DATE,
    "payment_mode" "request_payment_mode",
    "payment_reference" VARCHAR(100),
    "payment_receipt_url" VARCHAR(1000),
    "payment_recorded_by" UUID,
    "payment_recorded_at" TIMESTAMPTZ(3),
    "refund_date" DATE,
    "refund_mode" "request_payment_mode",
    "refund_reference" VARCHAR(100),
    "refund_receipt_url" VARCHAR(1000),
    "refund_recorded_by" UUID,
    "refund_recorded_at" TIMESTAMPTZ(3),
    "reject_reason" VARCHAR(500),
    "cancel_reason" VARCHAR(500),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "partner_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "partner_request_items" (
    "id" UUID NOT NULL,
    "request_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "quantity" INTEGER NOT NULL,
    "product_name" VARCHAR(200) NOT NULL,
    "product_sku" VARCHAR(50) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "partner_request_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "partner_request_events" (
    "id" UUID NOT NULL,
    "request_id" UUID NOT NULL,
    "type" "request_event_type" NOT NULL,
    "from_status" "request_status",
    "to_status" "request_status",
    "from_handler_id" UUID,
    "to_handler_id" UUID,
    "reason" VARCHAR(500),
    "actor_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "partner_request_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "partner_requests_request_no_key" ON "partner_requests"("request_no");

-- CreateIndex
CREATE INDEX "partner_requests_partner_id_status_idx" ON "partner_requests"("partner_id", "status");

-- CreateIndex
CREATE INDEX "partner_requests_partner_id_created_at_idx" ON "partner_requests"("partner_id", "created_at");

-- CreateIndex
CREATE INDEX "partner_requests_handler_id_status_idx" ON "partner_requests"("handler_id", "status");

-- CreateIndex
CREATE INDEX "partner_requests_owning_asm_id_status_idx" ON "partner_requests"("owning_asm_id", "status");

-- CreateIndex
CREATE INDEX "partner_requests_zone_id_status_idx" ON "partner_requests"("zone_id", "status");

-- CreateIndex
CREATE INDEX "partner_requests_created_at_idx" ON "partner_requests"("created_at");

-- CreateIndex
CREATE UNIQUE INDEX "partner_requests_year_seq_key" ON "partner_requests"("year", "seq");

-- CreateIndex
CREATE UNIQUE INDEX "partner_requests_partner_id_idempotency_key_key" ON "partner_requests"("partner_id", "idempotency_key");

-- CreateIndex
CREATE INDEX "partner_request_items_product_id_idx" ON "partner_request_items"("product_id");

-- CreateIndex
CREATE UNIQUE INDEX "partner_request_items_request_id_product_id_key" ON "partner_request_items"("request_id", "product_id");

-- CreateIndex
CREATE INDEX "partner_request_events_request_id_created_at_idx" ON "partner_request_events"("request_id", "created_at");

-- CreateIndex
CREATE INDEX "partner_request_events_actor_id_idx" ON "partner_request_events"("actor_id");

-- AddForeignKey
ALTER TABLE "partner_requests" ADD CONSTRAINT "partner_requests_partner_id_fkey" FOREIGN KEY ("partner_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "partner_requests" ADD CONSTRAINT "partner_requests_handler_id_fkey" FOREIGN KEY ("handler_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "partner_requests" ADD CONSTRAINT "partner_requests_zone_id_fkey" FOREIGN KEY ("zone_id") REFERENCES "zones"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "partner_requests" ADD CONSTRAINT "partner_requests_owning_asm_id_fkey" FOREIGN KEY ("owning_asm_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "partner_requests" ADD CONSTRAINT "partner_requests_payment_recorded_by_fkey" FOREIGN KEY ("payment_recorded_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "partner_requests" ADD CONSTRAINT "partner_requests_refund_recorded_by_fkey" FOREIGN KEY ("refund_recorded_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "partner_request_items" ADD CONSTRAINT "partner_request_items_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "partner_requests"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "partner_request_items" ADD CONSTRAINT "partner_request_items_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "partner_request_events" ADD CONSTRAINT "partner_request_events_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "partner_requests"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "partner_request_events" ADD CONSTRAINT "partner_request_events_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "partner_request_events" ADD CONSTRAINT "partner_request_events_from_handler_id_fkey" FOREIGN KEY ("from_handler_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "partner_request_events" ADD CONSTRAINT "partner_request_events_to_handler_id_fkey" FOREIGN KEY ("to_handler_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
