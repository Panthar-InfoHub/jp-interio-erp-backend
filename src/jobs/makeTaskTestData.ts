import { isProd } from "../config/env.js";
import { ROLE } from "../config/roles.js";
import { prisma } from "../lib/prisma.js";
import type { AuthUser } from "../middlewares/auth.js";
import { getPermissionScope } from "../services/permission.service.js";
import { cancelTask, completeTask, createTask, startTask } from "../services/task.service.js";
import { escalateOverdueTasks } from "../services/taskEscalation.service.js";
import { dateFromIso, todayInIst } from "../utils/istDate.js";
import {
  cancelTaskSchemas,
  completeTaskSchemas,
  createTaskSchemas,
} from "../validators/task.schema.js";
import { authUserByPhone, uploadTestPng } from "./devPartnerHelpers.js";

/**
 * `npm run dev:task-test-data` — DEV ONLY (frontend F10, DEC-288).
 *
 * Gives 12 tasks through the SAME services the apps use (give, start, complete with photos,
 * cancel), in every status:
 *
 *    1  Admin → Tasks Sub-Admin …104         open, high, due in 5 days
 *    2  Admin → Partners Sub-Admin …101      in progress
 *    3  Admin → ZH Pune …111                 open, due today
 *    4  Admin → ZH Pune …111                 overdue → flagged to the Admin
 *    5  Tasks SA …104 → ASM Pune 1 …121      completed, 2 photos + note
 *    6  Tasks SA …104 → ZH Mumbai …112       cancelled
 *    7  ZH Pune …111 → ASM Pune 2 …122       in progress, overdue → flagged to ZH Pune
 *    8  ZH Pune …111 → SE 1 …131             open, low
 *    9  ZH Mumbai …112 → ASM Mumbai 1 …123   completed, 1 photo
 *   10  ASM Pune 1 …121 → SE 2 …132          open, overdue → flagged to ASM Pune 1
 *   11  ASM Pune 1 …121 → themselves         cancelled
 *   12  Tasks SA …104 → SE 3 …133            completed late (overdue and flagged first)
 *
 * **Overdue can't be made through the services** (a due date must be today or later), so for
 * 4, 7, 10 and 12 the script moves the due date back 3 days straight in the database
 * (DEV ONLY, no audit row), then runs the real nightly check once (`escalateOverdueTasks`).
 * That check flags EVERY overdue task in the dev database, not only these.
 *
 * Every run adds a FRESH set (titles start with "TEST"). Leaves permanent rows (tasks, audit,
 * photo files in R2). While unfinished, the givers and doers can't be switched off or moved,
 * and ZH Pune / Mumbai can't be replaced (409 OPEN_TASKS). Refuses to run when
 * NODE_ENV=production.
 *
 * Needs: the dev test company (`npm run db:dev-data`, incl. …104 with the Tasks area), an
 * active Admin, and the R2_* settings (photos).
 */

const SESSION = "task-test-data";
const OVERDUE_DAYS_BACK = 3;

/** Who's who (phones as stored, with 91). `admin` is found by role. */
const PHONES = {
  saPartners: "919000000101",
  saTasks: "919000000104",
  zhPune: "919000000111",
  zhMumbai: "919000000112",
  asmPune1: "919000000121",
  asmPune2: "919000000122",
  asmMumbai1: "919000000123",
  se1: "919000000131",
  se2: "919000000132",
  se3: "919000000133",
} as const;
type Person = keyof typeof PHONES | "admin";

type Outcome =
  | { status: "open" }
  | { status: "in_progress" }
  | { status: "completed"; photos: number; note?: string }
  | { status: "cancelled"; reason: string };

interface TaskPlan {
  no: number;
  giver: Person;
  doer: Person;
  title: string;
  description?: string;
  category: string;
  priority: "high" | "medium" | "low";
  /** Days from today (India date) when given. */
  dueInDays: number;
  /** Moved back 3 days in the database, then flagged by the nightly check. */
  overdue?: boolean;
  outcome: Outcome;
}

const PLANS: TaskPlan[] = [
  {
    no: 1,
    giver: "admin",
    doer: "saTasks",
    title: "TEST Review the field task targets for December",
    description: "TEST: check every zone's open tasks and share a short summary",
    category: "Other",
    priority: "high",
    dueInDays: 5,
    outcome: { status: "open" },
  },
  {
    no: 2,
    giver: "admin",
    doer: "saPartners",
    title: "TEST Call the carpenters who signed up last week",
    category: "Carpenter meet",
    priority: "medium",
    dueInDays: 3,
    outcome: { status: "in_progress" },
  },
  {
    no: 3,
    giver: "admin",
    doer: "zhPune",
    title: "TEST Meet the Pune dealers about the new laminate range",
    category: "Dealer visit",
    priority: "medium",
    dueInDays: 0,
    outcome: { status: "open" },
  },
  {
    no: 4,
    giver: "admin",
    doer: "zhPune",
    title: "TEST Send the Pune monthly display photos",
    category: "Display setup",
    priority: "high",
    dueInDays: 1,
    overdue: true,
    outcome: { status: "open" },
  },
  {
    no: 5,
    giver: "saTasks",
    doer: "asmPune1",
    title: "TEST Set up the counter display at Sharma Hardware",
    description: "TEST: new BWP 18mm display, take a photo of the full counter",
    category: "Display setup",
    priority: "high",
    dueInDays: 2,
    outcome: {
      status: "completed",
      photos: 2,
      note: "TEST: display set up, the owner is happy",
    },
  },
  {
    no: 6,
    giver: "saTasks",
    doer: "zhMumbai",
    title: "TEST Product demo for the Mumbai architects",
    category: "Product demo",
    priority: "medium",
    dueInDays: 7,
    outcome: { status: "cancelled", reason: "TEST: the architects postponed the meeting" },
  },
  {
    no: 7,
    giver: "zhPune",
    doer: "asmPune2",
    title: "TEST Follow up the payment from Patil Traders",
    category: "Payment follow-up",
    priority: "high",
    dueInDays: 1,
    overdue: true,
    outcome: { status: "in_progress" },
  },
  {
    no: 8,
    giver: "zhPune",
    doer: "se1",
    title: "TEST Deliver the laminate sample book to Kothrud dealers",
    category: "Sample delivery",
    priority: "low",
    dueInDays: 6,
    outcome: { status: "open" },
  },
  {
    no: 9,
    giver: "zhMumbai",
    doer: "asmMumbai1",
    title: "TEST Visit the complaint site in Andheri",
    category: "Complaint visit",
    priority: "medium",
    dueInDays: 1,
    outcome: { status: "completed", photos: 1 },
  },
  {
    no: 10,
    giver: "asmPune1",
    doer: "se2",
    title: "TEST Carpenter meet at Hadapsar",
    category: "Carpenter meet",
    priority: "medium",
    dueInDays: 2,
    overdue: true,
    outcome: { status: "open" },
  },
  {
    no: 11,
    giver: "asmPune1",
    doer: "asmPune1",
    title: "TEST Check the stock at the Pune depot",
    category: "Other",
    priority: "low",
    dueInDays: 4,
    outcome: { status: "cancelled", reason: "TEST: the depot check was done by the Zonal Head" },
  },
  {
    no: 12,
    giver: "saTasks",
    doer: "se3",
    title: "TEST Dealer visit at Wakad",
    category: "Dealer visit",
    priority: "medium",
    dueInDays: 1,
    overdue: true,
    outcome: { status: "completed", photos: 1, note: "TEST: done late, the dealer was away" },
  },
];

/** Today + `days`, India time ("YYYY-MM-DD"). Negative = in the past. */
function dayFromToday(days: number): string {
  const [year, month, day] = todayInIst().split("-").map(Number);
  return new Date(Date.UTC(year!, month! - 1, day! + days)).toISOString().slice(0, 10);
}

/** Everyone the plans use, checked before anything is written. */
async function loadPeople(): Promise<Record<Person, AuthUser>> {
  const admin = await prisma.user.findFirst({
    where: { roleId: ROLE.ADMIN, status: "active" },
    orderBy: { createdAt: "asc" },
    select: { phone: true },
  });
  if (!admin) throw new Error("No active Admin found. Run npm run db:seed.");

  const people = { admin: await authUserByPhone(admin.phone, SESSION) } as Record<Person, AuthUser>;
  for (const [key, phone] of Object.entries(PHONES) as [keyof typeof PHONES, string][]) {
    people[key] = await authUserByPhone(phone, SESSION);
  }

  const inactive = await prisma.user.findMany({
    where: { id: { in: Object.values(people).map((p) => p.id) }, status: { not: "active" } },
    select: { phone: true, status: true },
  });
  if (inactive.length > 0) {
    const list = inactive.map((u) => `${u.phone.slice(2)} (${u.status})`).join(", ");
    throw new Error(`These people must be active: ${list}. Nothing was written.`);
  }
  return people;
}

async function giveTask(plan: TaskPlan, people: Record<Person, AuthUser>): Promise<string> {
  const giver = people[plan.giver];
  const scope = await getPermissionScope(giver, "tasks.assign");
  if (!scope) {
    throw new Error(
      `${giver.name ?? giver.phone} may not give tasks (a Sub-Admin needs the Tasks area).`
    );
  }
  const { task } = await createTask(
    giver,
    scope,
    createTaskSchemas.body.parse({
      assignedToId: people[plan.doer].id,
      title: plan.title,
      ...(plan.description ? { description: plan.description } : {}),
      category: plan.category,
      priority: plan.priority,
      dueDate: dayFromToday(plan.dueInDays),
    })
  );
  return task.id;
}

async function finish(
  plan: TaskPlan,
  taskId: string,
  people: Record<Person, AuthUser>
): Promise<void> {
  const doer = people[plan.doer];
  const { outcome } = plan;
  if (outcome.status === "completed") {
    const photoUrls: string[] = [];
    for (let index = 1; index <= outcome.photos; index += 1) {
      photoUrls.push(await uploadTestPng(doer, "task_photo", `TEST TASK PHOTO ${index} ${taskId}`));
    }
    await completeTask(
      doer,
      taskId,
      completeTaskSchemas.body.parse({
        photoUrls,
        ...(outcome.note ? { note: outcome.note } : {}),
      })
    );
  } else if (outcome.status === "cancelled") {
    await cancelTask(
      people[plan.giver],
      taskId,
      cancelTaskSchemas.body.parse({ reason: outcome.reason })
    );
  }
}

async function main() {
  if (isProd) throw new Error("This script is for the dev database only.");

  const people = await loadPeople();

  // 1. Give every task (the services check who may give to whom).
  const ids = new Map<number, string>();
  for (const plan of PLANS) {
    ids.set(plan.no, await giveTask(plan, people));
  }

  // 2. Start the in-progress ones (only the doer may).
  for (const plan of PLANS.filter((p) => p.outcome.status === "in_progress")) {
    await startTask(people[plan.doer], ids.get(plan.no)!);
  }

  // 3. DEV ONLY: move the overdue ones' due date back (no service allows a past date).
  const overdueIds = PLANS.filter((p) => p.overdue).map((p) => ids.get(p.no)!);
  await prisma.task.updateMany({
    where: { id: { in: overdueIds } },
    data: { dueDate: dateFromIso(dayFromToday(-OVERDUE_DAYS_BACK)) },
  });

  // 4. The real nightly check, once (flags every overdue task in dev to the manager).
  const check = await escalateOverdueTasks();

  // 5. Complete (with photos) and cancel.
  for (const plan of PLANS) {
    await finish(plan, ids.get(plan.no)!, people);
  }

  for (const plan of PLANS) {
    const overdue = plan.overdue ? ", overdue" : "";
    console.log(
      `DONE  ${String(plan.no).padStart(2)}  ${plan.outcome.status}${overdue}  ${plan.title}`
    );
  }
  console.log(
    `\nNightly check: ${check.found} overdue found, ${check.flagged} flagged, ` +
      `${check.skipped} already flagged, ${check.noManager} with no manager.`
  );
  console.log(`${PLANS.length} tasks given. Open the panel → Work → Tasks.`);
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
