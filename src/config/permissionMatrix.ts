import type { PermissionScope } from "../generated/prisma/enums.js";
import { CAPABILITIES, CAPABILITY_KEYS, type Capability } from "./capabilities.js";
import { ROLE, type RoleId } from "./roles.js";

/**
 * Who may do which action, and on whose records — docs/Permission Matrix.md (DEC-044).
 * `npm run db:seed` makes the `permissions` table match this file exactly: it adds,
 * updates and deletes rows, each with an audit row (DEC-049). To change a permission,
 * edit this file and run the seed again (DEC-043).
 *
 * Scopes: "full" = everything, "scoped" = own zone, "own" = own/assigned records
 * (for an ASM also their Sales Executives' records).
 *
 * Boxes still waiting on a doubt have NO entry, so they are refused until decided:
 * D4.2 (ASM deactivates own SE), D4.5 (transfers across zones), D4.8 (Sub-Admin and SEs),
 * D11.11 (ASM takes back a request), D15.1 (field staff raise tickets), D17.2 (reverse scan).
 */
type RoleMatrix = Partial<Record<Capability, PermissionScope>>;

/** Admin: every management action (G1). Not the field/partner actions. */
const ADMIN: RoleMatrix = {
  "settings.manage": "full",
  "sub_admins.manage": "full",
  "audit.view": "full",
  "zones.manage": "full",
  "users.view": "full",
  "users.pick": "full",
  "users.create": "full",
  "users.edit": "full",
  "users.transfer": "full",
  "users.deactivate": "full",
  "sales_exec.create": "full",
  "sales_exec.transfer": "full",
  "sales_exec.deactivate": "full",
  "partners.view": "full",
  "partners.onboard": "full",
  "partners.edit": "full",
  "partners.transfer": "full",
  "partners.suspend": "full",
  "kyc.verify": "full",
  "kyc.reveal": "full",
  "products.manage": "full",
  "catalog.view": "full",
  "qr.view": "full",
  "qr.generate": "full",
  "qr.export": "full",
  "qr.void": "full",
  "scans.view": "full",
  "ledger.view": "full",
  "ledger.adjust": "full",
  "reports.points_liability": "full",
  "payouts.view": "full",
  "payouts.approve": "full",
  "payouts.mark_paid": "full",
  "requests.view": "full",
  "requests.handle": "full",
  "requests.delegate": "full",
  "leads.view": "full",
  "leads.manage": "full",
  "leads.assign": "full",
  "tasks.assign": "full",
  "tasks.view": "full",
  "notifications.manage": "full",
  "tickets.handle": "full",
  "reports.view": "full",
  "fraud.review": "full",
};

/**
 * Sub-Admin: "full" for every action that any area unlocks, built from `capabilities.ts`
 * so the two files can never disagree. Whether a given Sub-Admin holds the area is
 * checked in code at request time (sub_admin_areas).
 */
const SUB_ADMIN: RoleMatrix = Object.fromEntries(
  CAPABILITY_KEYS.filter((key) => CAPABILITIES[key].subAdmin !== "never").map((key) => [
    key,
    "full",
  ])
);

/** Zonal Head: their one zone. */
const ZONAL_HEAD: RoleMatrix = {
  "users.view": "scoped",
  "users.create": "scoped",
  "users.edit": "scoped",
  "users.transfer": "scoped",
  "sales_exec.create": "scoped",
  "sales_exec.transfer": "scoped",
  "sales_exec.deactivate": "scoped",
  "partners.view": "scoped",
  "partners.edit": "scoped",
  "partners.transfer": "scoped",
  "kyc.verify": "scoped",
  "kyc.reveal": "scoped",
  "catalog.view": "full",
  "scans.view": "scoped",
  "ledger.view": "scoped",
  "payouts.view": "scoped",
  "payouts.approve": "scoped",
  "payouts.mark_paid": "scoped",
  "requests.view": "scoped",
  "requests.handle": "scoped",
  "requests.delegate": "scoped",
  "leads.view": "scoped",
  "leads.manage": "scoped",
  "leads.assign": "scoped",
  "tasks.assign": "scoped",
  "tasks.view": "scoped",
  "tasks.complete": "own",
  "reports.view": "scoped",
};

/** ASM: own records plus their Sales Executives' records ("Team"). */
const ASM: RoleMatrix = {
  "users.view": "own",
  "sales_exec.create": "own",
  "team.assign_partners": "own",
  "partners.view": "own",
  "partners.onboard": "own",
  "partners.edit": "own",
  "kyc.reveal": "own",
  "catalog.view": "full",
  "scans.view": "own",
  "ledger.view": "own",
  "payouts.view": "own",
  "requests.view": "own",
  "requests.handle": "own",
  "requests.delegate": "own",
  "leads.view": "own",
  "leads.manage": "own",
  "leads.convert": "own",
  "leads.assign": "own",
  "tasks.assign": "own",
  "tasks.view": "own",
  "tasks.complete": "own",
};

/** Sales Executive: only records assigned to them or created by them. */
const SALES_EXECUTIVE: RoleMatrix = {
  "partners.view": "own",
  "partners.onboard": "own",
  "partners.edit": "own",
  "kyc.reveal": "own",
  "catalog.view": "full",
  "scans.view": "own",
  "ledger.view": "own",
  "payouts.view": "own",
  "requests.view": "own",
  "requests.handle": "own",
  "leads.view": "own",
  "leads.manage": "own",
  "leads.convert": "own",
  "tasks.view": "own",
  "tasks.complete": "own",
};

/** Partner: only themselves. */
const PARTNER: RoleMatrix = {
  "partner.self": "own",
  "catalog.view": "full",
  "scans.create": "own",
  "wallet.self": "own",
  "payouts.request": "own",
  "requests.create": "own",
  "requests.view": "own",
  "tickets.create": "own",
};

export const PERMISSION_MATRIX: Record<RoleId, RoleMatrix> = {
  [ROLE.ADMIN]: ADMIN,
  [ROLE.SUB_ADMIN]: SUB_ADMIN,
  [ROLE.ZONAL_HEAD]: ZONAL_HEAD,
  [ROLE.ASM]: ASM,
  [ROLE.SALES_EXECUTIVE]: SALES_EXECUTIVE,
  [ROLE.PARTNER]: PARTNER,
};

export interface PermissionRow {
  roleId: RoleId;
  capability: Capability;
  scope: PermissionScope;
}

/**
 * The matrix as table rows. Throws if the matrix breaks rule G1 (the Admin must have
 * every action a Sub-Admin area unlocks), so a mistake stops the seed before saving.
 */
export function getPermissionRows(): PermissionRow[] {
  const missingForAdmin = CAPABILITY_KEYS.filter((key) => SUB_ADMIN[key] && !ADMIN[key]);
  if (missingForAdmin.length > 0) {
    throw new Error(
      `Permission matrix: the Admin is missing Sub-Admin actions (rule G1): ${missingForAdmin.join(", ")}`
    );
  }

  const rows: PermissionRow[] = [];
  for (const [roleId, matrix] of Object.entries(PERMISSION_MATRIX)) {
    for (const capability of CAPABILITY_KEYS) {
      const scope = matrix[capability];
      if (scope) rows.push({ roleId: Number(roleId) as RoleId, capability, scope });
    }
  }
  return rows;
}
