-- CreateTable
CREATE TABLE "brands" (
    "id" UUID NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "name_key" VARCHAR(100) NOT NULL,
    "code" VARCHAR(20),
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "brands_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_categories" (
    "id" UUID NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "name_key" VARCHAR(100) NOT NULL,
    "parent_id" UUID,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "product_categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "products" (
    "id" UUID NOT NULL,
    "sku" VARCHAR(50) NOT NULL,
    "sku_key" VARCHAR(50) NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "brand_id" UUID NOT NULL,
    "category_id" UUID NOT NULL,
    "thickness" VARCHAR(50),
    "size" VARCHAR(100),
    "grade" VARCHAR(50),
    "mrp" DECIMAL(12,2) NOT NULL,
    "image_url" VARCHAR(1000) NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "products_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "brands_name_key_key" ON "brands"("name_key");

-- CreateIndex
CREATE UNIQUE INDEX "brands_code_key" ON "brands"("code");

-- CreateIndex
CREATE INDEX "product_categories_parent_id_idx" ON "product_categories"("parent_id");

-- CreateIndex
CREATE UNIQUE INDEX "product_categories_parent_id_name_key_key" ON "product_categories"("parent_id", "name_key");

-- CreateIndex
CREATE UNIQUE INDEX "products_sku_key_key" ON "products"("sku_key");

-- CreateIndex
CREATE INDEX "products_brand_id_idx" ON "products"("brand_id");

-- CreateIndex
CREATE INDEX "products_category_id_idx" ON "products"("category_id");

-- CreateIndex
CREATE INDEX "products_active_idx" ON "products"("active");

-- AddForeignKey
ALTER TABLE "product_categories" ADD CONSTRAINT "product_categories_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "product_categories"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "products_brand_id_fkey" FOREIGN KEY ("brand_id") REFERENCES "brands"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "products_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "product_categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
