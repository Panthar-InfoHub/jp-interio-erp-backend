-- CreateEnum
CREATE TYPE "ledger_entry_type" AS ENUM ('earn', 'hold', 'release', 'redeem', 'refund', 'adjust');

-- CreateEnum
CREATE TYPE "ledger_direction" AS ENUM ('credit', 'debit');

-- CreateEnum
CREATE TYPE "ledger_source_type" AS ENUM ('scan', 'payout', 'adjustment');

-- CreateTable
CREATE TABLE "rewards_ledger" (
    "id" UUID NOT NULL,
    "partner_id" UUID NOT NULL,
    "type" "ledger_entry_type" NOT NULL,
    "direction" "ledger_direction" NOT NULL,
    "points" INTEGER NOT NULL,
    "available_after" INTEGER NOT NULL,
    "held_after" INTEGER NOT NULL,
    "source_type" "ledger_source_type" NOT NULL,
    "source_id" UUID,
    "reason" VARCHAR(500),
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "rewards_ledger_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wallets" (
    "partner_id" UUID NOT NULL,
    "available" INTEGER NOT NULL DEFAULT 0,
    "held" INTEGER NOT NULL DEFAULT 0,
    "lifetime_earned" INTEGER NOT NULL DEFAULT 0,
    "lifetime_redeemed" INTEGER NOT NULL DEFAULT 0,
    "net_adjusted" INTEGER NOT NULL DEFAULT 0,
    "scan_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "wallets_pkey" PRIMARY KEY ("partner_id")
);

-- CreateIndex
CREATE INDEX "rewards_ledger_partner_id_created_at_idx" ON "rewards_ledger"("partner_id", "created_at");

-- CreateIndex
CREATE INDEX "rewards_ledger_type_created_at_idx" ON "rewards_ledger"("type", "created_at");

-- CreateIndex
CREATE INDEX "rewards_ledger_created_at_idx" ON "rewards_ledger"("created_at");

-- CreateIndex
CREATE UNIQUE INDEX "rewards_ledger_source_type_source_id_type_key" ON "rewards_ledger"("source_type", "source_id", "type");

-- AddForeignKey
ALTER TABLE "rewards_ledger" ADD CONSTRAINT "rewards_ledger_partner_id_fkey" FOREIGN KEY ("partner_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rewards_ledger" ADD CONSTRAINT "rewards_ledger_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wallets" ADD CONSTRAINT "wallets_partner_id_fkey" FOREIGN KEY ("partner_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ===== Module 8: hand-written rules (DEC-130) =====

-- The ledger is insert-only: refuse UPDATE, DELETE and TRUNCATE.
CREATE FUNCTION rewards_ledger_block_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'rewards_ledger is insert-only: % is not allowed', TG_OP
    USING ERRCODE = 'P0001';
END;
$$;

CREATE TRIGGER rewards_ledger_no_update_delete
  BEFORE UPDATE OR DELETE ON "rewards_ledger"
  FOR EACH ROW EXECUTE FUNCTION rewards_ledger_block_change();

CREATE TRIGGER rewards_ledger_no_truncate
  BEFORE TRUNCATE ON "rewards_ledger"
  FOR EACH STATEMENT EXECUTE FUNCTION rewards_ledger_block_change();

-- Ledger numbers must make sense.
ALTER TABLE "rewards_ledger"
  ADD CONSTRAINT "rewards_ledger_points_positive" CHECK ("points" > 0),
  ADD CONSTRAINT "rewards_ledger_balances_not_negative"
    CHECK ("available_after" >= 0 AND "held_after" >= 0);

-- Wallet totals can't go below zero (net_adjusted may), and the balance rule always holds.
ALTER TABLE "wallets"
  ADD CONSTRAINT "wallets_not_negative" CHECK (
    "available" >= 0 AND "held" >= 0 AND "lifetime_earned" >= 0
    AND "lifetime_redeemed" >= 0 AND "scan_count" >= 0
  ),
  ADD CONSTRAINT "wallets_balance_rule" CHECK (
    "available" = "lifetime_earned" + "net_adjusted" - "lifetime_redeemed" - "held"
  );
