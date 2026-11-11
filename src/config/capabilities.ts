import type { SubAdminArea } from "../generated/prisma/enums.js";

/**
 * Every action (capability) the permission system knows, from docs/Permission Matrix.md
 * (DEC-044, DEC-048). Routes name these keys in `requirePermission(...)`, so a typo is a
 * compile error. Which role may do each action is stored in the `permissions` table.
 *
 * `subAdmin` says which Sub-Admin areas (DEC-019) unlock the action:
 * - a list of areas: a Sub-Admin holding ANY of them has it (in all zones);
 * - "every_area": every Sub-Admin has it, whatever their areas;
 * - "never": no Sub-Admin ever has it (Admin-only actions, and field/partner actions).
 */
type SubAdminRule = readonly SubAdminArea[] | "every_area" | "never";

interface CapabilityDefinition {
  subAdmin: SubAdminRule;
  description: string;
}

export const CAPABILITIES = {
  // ---- Settings, access and audit (Modules 3, 17) ----
  "settings.manage": { subAdmin: "never", description: "See and change system settings" },
  "sub_admins.manage": {
    subAdmin: "never",
    description: "Create Sub-Admins; grant or remove their areas",
  },
  "audit.view": { subAdmin: "never", description: "Search the audit log" },

  // ---- Zones and staff (Module 4) ----
  "zones.manage": {
    subAdmin: "never",
    description: "Create, edit, deactivate zones; set a zone's Zonal Head",
  },
  "users.view": { subAdmin: "never", description: "Staff list, staff detail, org tree" },
  "users.pick": {
    subAdmin: ["tasks", "leads_requests"],
    description: "Read-only staff picker (name, role, zone) to assign work",
  },
  "users.create": {
    subAdmin: "never",
    description: "Add Zonal Heads and ASMs (the tier rule decides which role)",
  },
  "users.edit": {
    subAdmin: "never",
    description: "Edit a staff member's name and contact details",
  },
  "users.transfer": {
    subAdmin: "never",
    description: "Move an ASM to another Zonal Head or zone",
  },
  "users.deactivate": {
    subAdmin: "never",
    description: "Deactivate or reactivate a Zonal Head or ASM",
  },
  // Sub-Admin side waits on D4.8; "never" until answered (DEC-048).
  "sales_exec.create": { subAdmin: "never", description: "Add a Sales Executive" },
  "sales_exec.transfer": {
    subAdmin: "never",
    description: "Move a Sales Executive to another ASM",
  },
  "sales_exec.deactivate": {
    subAdmin: "never",
    description: "Deactivate or reactivate a Sales Executive",
  },
  "team.assign_partners": {
    subAdmin: "never",
    description: "Assign or un-assign a partner to one of my Sales Executives",
  },

  // ---- Partners and KYC (Module 5) ----
  "partners.view": {
    subAdmin: ["partners"],
    description: "Partner list and Partner 360",
  },
  "partners.onboard": {
    subAdmin: ["partners"],
    description: "Onboard a partner and submit their KYC",
  },
  "partners.edit": {
    subAdmin: ["partners"],
    description: "Edit partner details (field staff: basic profile only)",
  },
  "partners.transfer": { subAdmin: "never", description: "Move a partner to another ASM" },
  "partners.suspend": {
    subAdmin: ["partners"],
    description: "Suspend or reactivate a partner",
  },
  "kyc.verify": { subAdmin: ["partners"], description: "KYC queue; approve or reject" },
  "kyc.reveal": {
    subAdmin: ["partners"],
    description: "Show a full Aadhaar, PAN or bank number (audited)",
  },
  "partner.self": {
    subAdmin: "never",
    description: "My own profile, KYC documents, bank/UPI details, submit for verification",
  },

  // ---- Products and QR codes (Modules 6, 7) ----
  "products.manage": {
    subAdmin: ["products"],
    description: "Add, edit, activate or deactivate products; brands; categories",
  },
  "catalog.view": { subAdmin: "every_area", description: "Browse active products" },
  "qr.view": {
    subAdmin: ["qr"],
    description: "QR batch list, batch detail, single-code lookup",
  },
  "qr.generate": { subAdmin: ["qr"], description: "Create a QR batch" },
  "qr.export": { subAdmin: ["qr"], description: "Export a QR batch for printing" },
  "qr.void": { subAdmin: ["qr"], description: "Void or recall a QR batch" },

  // ---- Scans, points and payouts (Modules 8–10) ----
  "scans.create": { subAdmin: "never", description: "Scan a QR code and earn points" },
  "scans.view": {
    subAdmin: ["partners", "rewards"],
    description: "A partner's scan history (staff view)",
  },
  "wallet.self": {
    subAdmin: "never",
    description: "My wallet, my statement, my scan history",
  },
  "ledger.view": {
    subAdmin: ["rewards"],
    description: "A partner's points statement; ledger across partners",
  },
  "ledger.adjust": {
    subAdmin: ["rewards"],
    description: "Manual points credit or debit (reason required)",
  },
  "reports.points_liability": { subAdmin: "never", description: "Points liability report" },
  "payouts.request": { subAdmin: "never", description: "Cash out points" },
  "payouts.view": { subAdmin: ["rewards"], description: "Payout list and approval queue" },
  "payouts.approve": { subAdmin: ["rewards"], description: "Approve or decline a payout" },
  "payouts.mark_paid": {
    subAdmin: ["rewards"],
    description: "Mark a payout processing, enter the UTR, mark paid",
  },

  // ---- Leads and requests (Modules 11, 13) ----
  "requests.create": {
    subAdmin: "never",
    description: "Raise a shipment or sample request",
  },
  "requests.view": {
    subAdmin: ["leads_requests"],
    description: "See requests and a partner's request history",
  },
  "requests.handle": {
    subAdmin: ["leads_requests"],
    description: "Enter the price, confirm collection, accept or reject a request",
  },
  "requests.delegate": {
    subAdmin: ["leads_requests"],
    description: "Give a request to a Sales Executive, or take it back",
  },
  "leads.view": { subAdmin: ["leads_requests"], description: "See leads and the pipeline" },
  "leads.manage": {
    subAdmin: ["leads_requests"],
    description: "Create and edit leads, move stage",
  },
  "leads.convert": { subAdmin: "never", description: "Convert a Won lead into a partner" },
  "leads.assign": {
    subAdmin: ["leads_requests"],
    description: "Assign or re-assign a lead to someone",
  },

  // ---- Tasks (Module 12) ----
  "tasks.assign": {
    subAdmin: ["tasks"],
    description: "Create a task and assign it to someone below",
  },
  "tasks.view": { subAdmin: ["tasks"], description: "See tasks" },
  "tasks.complete": {
    subAdmin: "never",
    description: "Update and complete my own task, with photo proof",
  },

  // ---- Notifications, support, dashboards and fraud (Modules 14–17) ----
  "notifications.manage": { subAdmin: "never", description: "Edit message templates" },
  "tickets.create": {
    subAdmin: "never",
    description: "Raise a support ticket; see my tickets",
  },
  "tickets.handle": {
    subAdmin: "never",
    description: "Ticket queue; assign, update and resolve tickets",
  },
  "reports.view": { subAdmin: "never", description: "Reports and CSV exports" },
  "fraud.review": {
    subAdmin: "never",
    description: "Fraud flag queue; dismiss or act on a flag",
  },
  // Waits on D17.2; "never" for Sub-Admins until answered (DEC-048).
  "fraud.reverse_scan": {
    subAdmin: "never",
    description: "Take back points from a fraudulent scan",
  },
} as const satisfies Record<string, CapabilityDefinition>;

/** An action name, e.g. "kyc.verify". */
export type Capability = keyof typeof CAPABILITIES;

/** All action names, in the order above. */
export const CAPABILITY_KEYS = Object.keys(CAPABILITIES) as Capability[];

/** True if `value` is a known action name (e.g. for a value read from the database). */
export function isCapability(value: string): value is Capability {
  return Object.hasOwn(CAPABILITIES, value);
}
