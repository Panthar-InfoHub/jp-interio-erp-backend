import "dotenv/config";
import { defineConfig } from "prisma/config";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
    // Run by `prisma migrate reset` (and `npm run db:seed`).
    seed: "tsx prisma/seed.ts",
  },
  datasource: {
    // CLI commands (migrate, studio) use the DIRECT (non-pooled) connection.
    url: process.env.DIRECT_URL!,
  },
});
