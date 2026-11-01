import type { AppType } from "../generated/prisma/enums.js";

/** Role ids. They never change once seeded; use these instead of bare numbers. */
export const ROLE = {
  ADMIN: 1,
  SUB_ADMIN: 2,
  ZONAL_HEAD: 3,
  ASM: 4,
  SALES_EXECUTIVE: 5,
  PARTNER: 6,
} as const;

export type RoleId = (typeof ROLE)[keyof typeof ROLE];

/** The 6 fixed roles. The seed fills the `roles` table from this list. */
export const ROLES = [
  { id: ROLE.ADMIN, key: "admin", name: "Admin", tier: 0, app: "web" },
  { id: ROLE.SUB_ADMIN, key: "sub_admin", name: "Sub-Admin", tier: 1, app: "web" },
  { id: ROLE.ZONAL_HEAD, key: "zonal_head", name: "Zonal Head", tier: 2, app: "web" },
  { id: ROLE.ASM, key: "asm", name: "ASM", tier: 3, app: "field" },
  {
    id: ROLE.SALES_EXECUTIVE,
    key: "sales_executive",
    name: "Sales Executive",
    tier: 4,
    app: "field",
  },
  { id: ROLE.PARTNER, key: "partner", name: "Partner", tier: 5, app: "partner" },
] as const satisfies readonly {
  id: RoleId;
  key: string;
  name: string;
  tier: number;
  app: AppType;
}[];
