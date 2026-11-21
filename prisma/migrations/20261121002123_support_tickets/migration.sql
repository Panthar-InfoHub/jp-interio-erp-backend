-- CreateEnum
CREATE TYPE "ticket_status" AS ENUM ('open', 'in_progress', 'resolved', 'rejected');

-- CreateEnum
CREATE TYPE "ticket_category" AS ENUM ('damaged_qr', 'points_not_received', 'payout_issue', 'account_kyc', 'request_issue', 'other');

-- CreateTable
CREATE TABLE "support_tickets" (
    "id" UUID NOT NULL,
    "ticket_no" VARCHAR(20) NOT NULL,
    "year" SMALLINT NOT NULL,
    "seq" INTEGER NOT NULL,
    "partner_id" UUID NOT NULL,
    "category" "ticket_category" NOT NULL,
    "description" VARCHAR(2000) NOT NULL,
    "photo_urls" VARCHAR(1000)[],
    "status" "ticket_status" NOT NULL DEFAULT 'open',
    "resolution_note" VARCHAR(2000),
    "closed_at" TIMESTAMPTZ(3),
    "updated_by" UUID,
    "status_changed_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "support_tickets_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "support_tickets_ticket_no_key" ON "support_tickets"("ticket_no");

-- CreateIndex
CREATE INDEX "support_tickets_partner_id_created_at_idx" ON "support_tickets"("partner_id", "created_at");

-- CreateIndex
CREATE INDEX "support_tickets_status_created_at_idx" ON "support_tickets"("status", "created_at");

-- CreateIndex
CREATE INDEX "support_tickets_category_status_idx" ON "support_tickets"("category", "status");

-- CreateIndex
CREATE INDEX "support_tickets_created_at_idx" ON "support_tickets"("created_at");

-- CreateIndex
CREATE UNIQUE INDEX "support_tickets_year_seq_key" ON "support_tickets"("year", "seq");

-- AddForeignKey
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_partner_id_fkey" FOREIGN KEY ("partner_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
