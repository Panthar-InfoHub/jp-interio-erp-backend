-- CreateEnum
CREATE TYPE "permission_scope" AS ENUM ('full', 'scoped', 'own');

-- CreateTable
CREATE TABLE "permissions" (
    "role_id" SMALLINT NOT NULL,
    "capability" VARCHAR(60) NOT NULL,
    "scope" "permission_scope" NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "permissions_pkey" PRIMARY KEY ("role_id","capability")
);

-- AddForeignKey
ALTER TABLE "permissions" ADD CONSTRAINT "permissions_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
