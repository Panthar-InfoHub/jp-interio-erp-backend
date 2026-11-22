import { randomUUID } from "node:crypto";
import { isProd } from "../config/env.js";
import { prisma } from "../lib/prisma.js";
import type { AuthUser } from "../middlewares/auth.js";
import {
  cancelMyRequest,
  createMyRequest,
  runHandlerStep,
  runHandOver,
  type HandlerAction,
} from "../services/request.service.js";
import { todayInIst } from "../utils/istDate.js";
import {
  acceptRequestSchemas,
  assignRequestSchemas,
  cancelRequestSchemas,
  createRequestSchemas,
  moneyStepSchemas,
} from "../validators/request.schema.js";
import { authUserByPhone, uploadTestPng } from "./devPartnerHelpers.js";

/**
 * `npm run dev:request-test-data` — DEV ONLY (frontend F9, DEC-281).
 *
 * Makes shipment / sample requests in every stage through the SAME services the apps use
 * (the partner sends, the handler moves it on, the ASM hands one over):
 *
 *   X (TEST Pune, ASM 1)    Requested shipment (2 products) · Accepted ₹25,000 ·
 *                           Paid (UPI + receipt) → Processing → Dispatched ·
 *                           Completed shipment · Rejected · a sample handed to TEST SE 4
 *   Y (TEST Pune, ASM 2)    Completed sample · Cancelled by the partner ·
 *                           Cancelled after payment (refund due) · Refunded (cash + receipt)
 *   W (TEST Mumbai, ASM 1)  Delivered shipment · Requested sample
 *
 * Every run adds a FRESH set (12 requests). Leaves permanent rows (requests, timeline,
 * audit, receipt files in R2). While open, X / Y / W can't move to another ASM and TEST
 * SE 4 can't be switched off or moved (409 OPEN_REQUESTS, DEC-165, DEC-172). A partner who
 * isn't verified and active is skipped with a note. Refuses to run when NODE_ENV=production.
 *
 * Needs: the dev test company (`npm run db:dev-data`), X / Y (`dev:kyc-test-partners`,
 * verified in the panel), W (`dev:payout-test-data`), the products `TEST-SCAN-CHECK` and
 * `BWP-18` switched on (with their brand and category), and the R2_* settings (receipts).
 */

const SESSION = "request-test-data";
const PRODUCT_SKUS = ["TEST-SCAN-CHECK", "BWP-18"] as const;
const SE4_PHONE = "919000000134";

type Step =
  | { do: "accept"; amount?: number }
  | { do: "pay"; mode: "upi" | "bank" | "cheque" | "cash"; receipt?: boolean }
  | { do: "processing" | "dispatched" | "delivered" | "completed" | "refund_initiated" }
  | { do: "refund"; mode: "cash"; receipt?: boolean }
  | { do: "reject" | "cancel"; reason: string }
  | { do: "partner_cancel"; reason: string }
  | { do: "assign_se4"; reason: string };

interface RequestPlan {
  label: string;
  category: "shipment" | "sample";
  /** [index into PRODUCT_SKUS, quantity] */
  items: [number, number][];
  notes?: string;
  steps: Step[];
}

interface PartnerPlan {
  key: string;
  phone: string;
  /** The ASM who handles this partner's requests (no Sales Executive is set). */
  handlerPhone: string;
  requests: RequestPlan[];
}

const toDispatched: Step[] = [{ do: "processing" }, { do: "dispatched" }];

const PLANS: PartnerPlan[] = [
  {
    key: "X",
    phone: "919000000210",
    handlerPhone: "919000000121",
    requests: [
      {
        label: "Requested (2 products)",
        category: "shipment",
        items: [
          [0, 50],
          [1, 20],
        ],
        notes: "TEST: please call before coming",
        steps: [],
      },
      {
        label: "Accepted ₹25,000",
        category: "shipment",
        items: [[0, 30]],
        steps: [{ do: "accept", amount: 25000 }],
      },
      {
        label: "Paid by UPI → Dispatched",
        category: "shipment",
        items: [[1, 40]],
        steps: [
          { do: "accept", amount: 18000 },
          { do: "pay", mode: "upi", receipt: true },
          ...toDispatched,
        ],
      },
      {
        label: "Completed shipment",
        category: "shipment",
        items: [[0, 10]],
        steps: [
          { do: "accept", amount: 12000 },
          { do: "pay", mode: "bank" },
          ...toDispatched,
          { do: "delivered" },
          { do: "completed" },
        ],
      },
      {
        label: "Rejected",
        category: "shipment",
        items: [[1, 5]],
        steps: [{ do: "reject", reason: "TEST: this product is not stocked at the depot" }],
      },
      {
        label: "Sample handed to TEST SE 4",
        category: "sample",
        items: [[0, 1]],
        steps: [{ do: "assign_se4", reason: "TEST: SE 4 visits this area this week" }],
      },
    ],
  },
  {
    key: "Y",
    phone: "919000000211",
    handlerPhone: "919000000122",
    requests: [
      {
        label: "Completed sample",
        category: "sample",
        items: [[1, 2]],
        steps: [{ do: "accept" }, ...toDispatched, { do: "delivered" }, { do: "completed" }],
      },
      {
        label: "Cancelled by the partner",
        category: "shipment",
        items: [[0, 15]],
        steps: [{ do: "partner_cancel", reason: "TEST: I ordered from a dealer instead" }],
      },
      {
        label: "Cancelled after payment (refund due)",
        category: "shipment",
        items: [[1, 25]],
        steps: [
          { do: "accept", amount: 20000 },
          { do: "pay", mode: "cash" },
          { do: "partner_cancel", reason: "TEST: the site work was postponed" },
        ],
      },
      {
        label: "Refunded (cash)",
        category: "shipment",
        items: [[0, 8]],
        steps: [
          { do: "accept", amount: 9000 },
          { do: "pay", mode: "cheque" },
          { do: "cancel", reason: "TEST: stock ran out after payment" },
          { do: "refund_initiated" },
          { do: "refund", mode: "cash", receipt: true },
        ],
      },
    ],
  },
  {
    key: "W",
    phone: "919000000213",
    handlerPhone: "919000000123",
    requests: [
      {
        label: "Delivered shipment",
        category: "shipment",
        items: [
          [0, 60],
          [1, 10],
        ],
        steps: [
          { do: "accept", amount: 40000 },
          { do: "pay", mode: "bank" },
          ...toDispatched,
          { do: "delivered" },
        ],
      },
      { label: "Requested sample", category: "sample", items: [[1, 1]], steps: [] },
    ],
  },
];

/** A made-up payment reference (not unique on purpose). */
function testReference(mode: string): string {
  return `TEST${mode.toUpperCase()}${String(Date.now()).slice(-8)}`;
}

/** Today + 7 days, India time ("YYYY-MM-DD"). */
function nextWeek(): string {
  const [year, month, day] = todayInIst().split("-").map(Number);
  const date = new Date(Date.UTC(year!, month! - 1, day! + 7));
  return date.toISOString().slice(0, 10);
}

/** The partner's id, if they may send requests now (verified and active). */
async function loadPartner(plan: PartnerPlan): Promise<string | null> {
  const user = await prisma.user.findUnique({
    where: { phone: plan.phone },
    select: { id: true, status: true, partnerProfile: { select: { kycState: true } } },
  });
  const skip = (why: string) => {
    console.log(`SKIP  ${plan.key} (${plan.phone.slice(2)}): ${why}`);
    return null;
  };
  if (!user) return skip("not found (run dev:kyc-test-partners / dev:payout-test-data first)");
  if (user.partnerProfile?.kycState !== "verified") {
    return skip(`KYC ${user.partnerProfile?.kycState ?? "?"}, must be verified`);
  }
  if (user.status !== "active") return skip(`account ${user.status}, must be active`);
  return user.id;
}

async function runStep(
  step: Step,
  ids: { partnerId: string; requestId: string },
  handler: AuthUser,
  se4Id: string
): Promise<void> {
  const { partnerId, requestId } = ids;
  const handlerStep = (action: HandlerAction) => runHandlerStep(handler, requestId, action);

  switch (step.do) {
    case "accept":
      await handlerStep({
        step: "accept",
        input: acceptRequestSchemas.body.parse(
          step.amount === undefined ? {} : { agreedAmount: step.amount }
        ),
      });
      return;
    case "pay":
    case "refund": {
      const receiptUrl = step.receipt
        ? await uploadTestPng(handler, "request_receipt", `TEST RECEIPT ${step.do} ${requestId}`)
        : undefined;
      await handlerStep({
        step: step.do === "pay" ? "payment_received" : "refunded",
        input: moneyStepSchemas.body.parse({
          date: todayInIst(),
          mode: step.mode,
          ...(step.mode === "cash" ? {} : { reference: testReference(step.mode) }),
          ...(receiptUrl ? { receiptUrl } : {}),
        }),
      });
      return;
    }
    case "reject":
    case "cancel":
      await handlerStep({
        step: step.do,
        input: cancelRequestSchemas.body.parse({ reason: step.reason }),
      });
      return;
    case "partner_cancel":
      await cancelMyRequest(
        partnerId,
        requestId,
        cancelRequestSchemas.body.parse({ reason: step.reason })
      );
      return;
    case "assign_se4":
      await runHandOver(handler, requestId, {
        kind: "assign",
        input: assignRequestSchemas.body.parse({ salesExecutiveId: se4Id, reason: step.reason }),
      });
      return;
    default:
      await handlerStep({ step: step.do });
  }
}

async function runPlan(
  plan: PartnerPlan,
  productIds: string[],
  se4Id: string,
  address: string
): Promise<number> {
  const partnerId = await loadPartner(plan);
  if (!partnerId) return 0;
  const handler = await authUserByPhone(plan.handlerPhone, SESSION);

  for (const item of plan.requests) {
    const { request } = await createMyRequest(
      partnerId,
      randomUUID(),
      createRequestSchemas.body.parse({
        category: item.category,
        items: item.items.map(([index, quantity]) => ({ productId: productIds[index], quantity })),
        deliveryAddress: `${address} (TEST ${plan.key})`,
        preferredDeliveryDate: nextWeek(),
        ...(item.notes ? { notes: item.notes } : {}),
      })
    );
    for (const step of item.steps) {
      await runStep(step, { partnerId, requestId: request.id }, handler, se4Id);
    }
    console.log(`DONE  ${plan.key}: ${request.requestNo} ${item.category} → ${item.label}`);
  }
  return plan.requests.length;
}

async function main() {
  if (isProd) throw new Error("This script is for the dev database only.");

  const products = await prisma.product.findMany({
    where: { sku: { in: [...PRODUCT_SKUS] } },
    select: { id: true, sku: true },
  });
  const productIds = PRODUCT_SKUS.map((sku) => {
    const found = products.find((product) => product.sku === sku);
    if (!found)
      throw new Error(`Product ${sku} not found. Add it (Products page) or run db:dev-data.`);
    return found.id;
  });

  const se4 = await prisma.user.findUnique({
    where: { phone: SE4_PHONE },
    select: { id: true, status: true },
  });
  if (!se4 || se4.status !== "active") {
    throw new Error(`TEST SE 4 (${SE4_PHONE.slice(2)}) must exist and be active.`);
  }

  let made = 0;
  for (const plan of PLANS) {
    made += await runPlan(plan, productIds, se4.id, "1 Test Road, Site office");
  }
  console.log(`\n${made} requests made. Open the panel → Work → Requests.`);
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
