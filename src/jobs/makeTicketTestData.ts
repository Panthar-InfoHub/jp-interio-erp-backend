import { isProd } from "../config/env.js";
import { ROLE } from "../config/roles.js";
import { prisma } from "../lib/prisma.js";
import type { AuthUser } from "../middlewares/auth.js";
import { changeTicketStatus, createTicket } from "../services/ticket.service.js";
import { changeTicketStatusSchemas, createTicketSchemas } from "../validators/ticket.schema.js";
import { authUserByPhone, uploadTestPng } from "./devPartnerHelpers.js";

/**
 * `npm run dev:ticket-test-data` — DEV ONLY (frontend F11, DEC-295).
 *
 * Partners raise 10 support tickets through the SAME service the partner app uses
 * (`createTicket`, photos uploaded as the partner with purpose `ticket_photo`), then the
 * Admin moves some through the real `changeTicketStatus`:
 *
 *    1  A …141 (verified)            damaged QR, 1 photo        open
 *    2  A                            points not received        in progress
 *    3  X …210                       payout issue               open
 *    4  X                            request issue              resolved
 *    5  Y …211                       account / KYC, 2 photos    open
 *    6  Y                            other                      rejected
 *    7  W …213                       damaged QR, 5 photos       in progress
 *    8  W                            payout issue               resolved
 *    9  B …142 (KYC pending)         account / KYC              open
 *   10  D …144 (sign-up not finished) other                     open
 *
 * Every run adds a FRESH set (descriptions start with "TEST"). Leaves permanent rows
 * (tickets, audit, photo files in R2). A partner who isn't found or isn't active (a suspended
 * partner can't raise, DEC-189) is skipped with a note. Refuses to run when NODE_ENV=production.
 *
 * Needs: the dev test company (`npm run db:dev-data`: A, B, D), X / Y
 * (`dev:kyc-test-partners`), W (`dev:payout-test-data`), an active Admin, and the R2_*
 * settings (photos).
 */

const SESSION = "ticket-test-data";

type Category =
  "damaged_qr" | "points_not_received" | "payout_issue" | "account_kyc" | "request_issue" | "other";

type Outcome =
  | { status: "open" }
  | { status: "in_progress" }
  | { status: "resolved" | "rejected"; note: string; startFirst?: boolean };

interface TicketPlan {
  no: number;
  partner: string;
  phone: string;
  category: Category;
  description: string;
  photos: number;
  outcome: Outcome;
}

const PLANS: TicketPlan[] = [
  {
    no: 1,
    partner: "A",
    phone: "919000000141",
    category: "damaged_qr",
    description: "TEST: the QR sticker on the 18mm sheet is torn and won't scan.",
    photos: 1,
    outcome: { status: "open" },
  },
  {
    no: 2,
    partner: "A",
    phone: "919000000141",
    category: "points_not_received",
    description: "TEST: I scanned a code yesterday but the points are not in my wallet.",
    photos: 0,
    outcome: { status: "in_progress" },
  },
  {
    no: 3,
    partner: "X",
    phone: "919000000210",
    category: "payout_issue",
    description: "TEST: my payout from last week has not reached my bank account yet.",
    photos: 0,
    outcome: { status: "open" },
  },
  {
    no: 4,
    partner: "X",
    phone: "919000000210",
    category: "request_issue",
    description: "TEST: my shipment request shows dispatched but nothing has arrived.",
    photos: 0,
    outcome: {
      status: "resolved",
      note: "TEST: the transporter delivered it today; please check with the site.",
      startFirst: true,
    },
  },
  {
    no: 5,
    partner: "Y",
    phone: "919000000211",
    category: "account_kyc",
    description: "TEST: I changed my UPI ID and want to update it in the app.",
    photos: 2,
    outcome: { status: "open" },
  },
  {
    no: 6,
    partner: "Y",
    phone: "919000000211",
    category: "other",
    description: "TEST: same problem as my earlier ticket about the UPI ID.",
    photos: 0,
    outcome: {
      status: "rejected",
      note: "TEST: duplicate of the earlier UPI ticket, handled there.",
    },
  },
  {
    no: 7,
    partner: "W",
    phone: "919000000213",
    category: "damaged_qr",
    description: "TEST: five stickers in one bundle were printed badly and none of them scan.",
    photos: 5,
    outcome: { status: "in_progress" },
  },
  {
    no: 8,
    partner: "W",
    phone: "919000000213",
    category: "payout_issue",
    description: "TEST: my payout was marked paid but the amount looks wrong.",
    photos: 0,
    outcome: {
      status: "resolved",
      note: "TEST: the amount was right; TDS explained to the partner on a call.",
    },
  },
  {
    no: 9,
    partner: "B",
    phone: "919000000142",
    category: "account_kyc",
    description: "TEST: my KYC is pending for many days, please check it.",
    photos: 0,
    outcome: { status: "open" },
  },
  {
    no: 10,
    partner: "D",
    phone: "919000000144",
    category: "other",
    description: "TEST: I can't finish my sign-up, the app stops at the KYC step.",
    photos: 0,
    outcome: { status: "open" },
  },
];

/** The partner as `requireAuth` builds them, if they may raise now (found, a partner, active). */
async function loadPartner(plan: TicketPlan): Promise<AuthUser | null> {
  const user = await prisma.user.findUnique({
    where: { phone: plan.phone },
    select: { roleId: true, status: true },
  });
  const skip = (why: string) => {
    console.log(
      `SKIP  ${String(plan.no).padStart(2)}  ${plan.partner} (${plan.phone.slice(2)}): ${why}`
    );
    return null;
  };
  if (!user) return skip("not found (see the script's 'Needs' list)");
  if (user.roleId !== ROLE.PARTNER) return skip("not a partner");
  if (user.status !== "active") return skip(`account ${user.status}, must be active`);
  return authUserByPhone(plan.phone, SESSION);
}

async function move(admin: AuthUser, ticketId: string, status: string, note?: string) {
  await changeTicketStatus(
    admin,
    ticketId,
    changeTicketStatusSchemas.body.parse({ status, ...(note ? { note } : {}) })
  );
}

async function main() {
  if (isProd) throw new Error("This script is for the dev database only.");

  const adminRow = await prisma.user.findFirst({
    where: { roleId: ROLE.ADMIN, status: "active" },
    orderBy: { createdAt: "asc" },
    select: { phone: true },
  });
  if (!adminRow) throw new Error("No active Admin found. Run npm run db:seed.");
  const admin = await authUserByPhone(adminRow.phone, SESSION);

  let made = 0;
  for (const plan of PLANS) {
    const partner = await loadPartner(plan);
    if (!partner) continue;

    const photoUrls: string[] = [];
    for (let index = 1; index <= plan.photos; index += 1) {
      photoUrls.push(
        await uploadTestPng(partner, "ticket_photo", `TEST TICKET PHOTO ${plan.no}-${index}`)
      );
    }
    const ticket = await createTicket(
      partner,
      createTicketSchemas.body.parse({
        category: plan.category,
        description: plan.description,
        photoUrls,
      })
    );

    const { outcome } = plan;
    if (outcome.status === "in_progress") {
      await move(admin, ticket.id, "in_progress");
    } else if (outcome.status === "resolved" || outcome.status === "rejected") {
      if (outcome.startFirst) await move(admin, ticket.id, "in_progress");
      await move(admin, ticket.id, outcome.status, outcome.note);
    }

    made += 1;
    console.log(
      `DONE  ${String(plan.no).padStart(2)}  ${ticket.ticketNo}  ${plan.partner}  ${plan.category}` +
        `${plan.photos ? `, ${plan.photos} photo(s)` : ""} → ${outcome.status}`
    );
  }
  console.log(`\n${made} tickets raised. Open the panel → Support tickets.`);
}

try {
  await main();
} catch (error) {
  console.error(
    "Stopped:",
    error instanceof Error ? error.message : "could not connect to the database. Try again."
  );
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
