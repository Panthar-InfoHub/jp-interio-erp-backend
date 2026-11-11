# JP Interio — Backend API

The server for the **JP Interio Channel & Rewards Platform**, built by Panthar Infohub.

- Partners (carpenters, dealers, OEMs) scan QR codes on products to earn points (1 point = ₹1) and cash them out.
- Field staff manage partners, tasks, leads and requests inside a 6-tier hierarchy.
- The web console, the field app and the partner app all talk to this one API.

> The full build plan is in `../docs/Backend Development Plan.md`, and every decision is in `../docs/context/DECISIONS.md`.

---

## Tech stack

| Part | Tool |
|---|---|
| Runtime | Node.js 24, TypeScript (strict, ESM) |
| Web framework | Express 5 |
| Database | PostgreSQL on Neon, through Prisma 7 (Neon adapter) |
| Validation | Zod 4 |
| Logging | pino + pino-http |
| Formatting | Prettier (ESLint comes later: DEC-023) |
| Scripts | tsx |

---

## 1. Setup from scratch

**You need:** Node.js **24 or newer**, npm, and a Neon PostgreSQL database.

```bash
# 1. Install packages (this also generates the Prisma client)
npm install

# 2. Create your .env from the example and fill it in (see section 2)
cp .env.example .env

# 3. Create all tables in the database
npm run db:migrate

# 4. Fill in the starting data: 6 roles, the first Admin, default settings
npm run db:seed

# 5. Start the server
npm run dev
```

Check that it works: open **http://localhost:8080/health**. You should see `"status": "ok", "database": "up"`.

> **Neon sleeps** after a few minutes without use on the free plan. The first request after that can fail or be slow while it wakes up. Just try again.

---

## 2. Environment variables (`.env`)

| Variable | Required | What it is |
|---|---|---|
| `NODE_ENV` | No | `development` (default), `production` or `test` |
| `PORT` | No | Server port. Default `8080` |
| `LOG_LEVEL` | No | `debug`, `info`, `warn`… Default: `debug` in development, `info` in production |
| `DATABASE_URL` | **Yes** | Neon **pooled** connection (the host contains `-pooler`). Used by the app while running |
| `DIRECT_URL` | **Yes** | Neon **direct** connection (no `-pooler`). Used by Prisma for migrations |
| `CORS_ORIGINS` | No | Comma-separated list of web addresses allowed to call the API. Default `http://localhost:3000` |
| `AUTH_SECRET` | **Yes** | One long random secret (32+ characters). It signs login tokens and scrambles OTPs and refresh tokens. **Changing it logs everyone out.** The command to generate one is in `.env.example` |
| `SMS_PROVIDER` | No | `dummy` (default: prints the OTP in the terminal) or `msg91` (real SMS). `dummy` is refused in production |
| `MSG91_AUTH_KEY` | With msg91 | MSG91 auth key. **Never commit it** |
| `MSG91_OTP_TEMPLATE_ID` | With msg91 | MSG91's own template ID (not the long DLT number) |
| `MSG91_OTP_VARIABLE` | No | The template variable that gets the OTP. Default `otp` |
| `TEST_PHONES` | No | Comma-separated test mobiles. They log in with `TEST_OTP` and get no SMS |
| `TEST_OTP` | With test phones | The fixed 6-digit OTP for test phones |
| `ALLOW_TEST_PHONES_IN_PRODUCTION` | No | `false` (default). Test phones are off in production unless this is `true` |
| `SEED_ADMIN_NAME` | For seed | Name of the first Admin |
| `SEED_ADMIN_PHONE` | For seed | First Admin's 10-digit Indian mobile number. Stored as `91XXXXXXXXXX` |
| `SEED_ADMIN_EMAIL` | No | First Admin's email (optional) |

The server checks these on start-up and stops with a clear message if something is missing.
**Never commit `.env`.**

---

## 3. Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Start the server and restart it when a file changes |
| `npm run build` | Compile to `dist/` |
| `npm start` | Run the compiled server (production) |
| `npm run typecheck` | Check all TypeScript types |
| `npm run format` | Format all code with Prettier |
| `npm run format:check` | Check formatting without changing files ("lint" for now) |
| `npm run db:migrate` | Create and apply a migration after you change `prisma/schema.prisma` (development) |
| `npm run db:deploy` | Apply existing migrations (production / CI) |
| `npm run db:generate` | Regenerate the Prisma client |
| `npm run db:seed` | Add the starting data. Safe to run again (see section 7) |
| `npm run db:dev-data` | **Dev only.** Add the pretend test company for manual testing (see section 7) |
| `npm run db:studio` | Open Prisma Studio to browse the data |

**Before saying a task is done**, run `npm run typecheck` and `npm run format:check`. Both must pass.

`npx prisma migrate reset` wipes the database, re-applies all migrations and runs the seed. **Development only.**

---

## 4. Folder structure

```
backend/
├── prisma/
│   ├── schema.prisma        Database tables (models and enums)
│   ├── migrations/          SQL migrations (generated, never edit old ones)
│   ├── seed.ts              Starting data (roles, first Admin, settings, permission matrix)
│   └── devData.ts           Dev-only pretend company for manual testing
├── prisma.config.ts         Prisma settings (schema, migrations, seed, DIRECT_URL)
└── src/
    ├── server.ts            Starts the HTTP server, graceful shutdown
    ├── app.ts               Express app: middleware order, routes, error handler
    ├── config/
    │   ├── env.ts           Reads and checks .env
    │   ├── roles.ts         The 6 roles and ROLE.ADMIN etc. constants
    │   ├── settings.ts      Master list of business settings (with min/max)
    │   ├── capabilities.ts  Every action name and the Sub-Admin areas that unlock it
    │   ├── permissionMatrix.ts  Who may do which action, with which scope
    │   └── sensitiveFields.ts  Secret field names (hidden in logs and audit)
    ├── lib/
    │   ├── prisma.ts        The database client
    │   ├── logger.ts        pino logger (request ID on every line, secrets hidden)
    │   ├── requestContext.ts  Request ID, IP and device for the current request
    │   ├── auth/            Tokens (access / refresh / OTP hashes) and the refresh cookie
    │   └── sms/             SMS senders (dummy, MSG91) and test phones
    ├── middlewares/
    │   ├── requestContext.ts  Gives every request an ID (must run first)
    │   ├── auth.ts          requireAuth, requireApp, requireRole, getAuthUser
    │   ├── permission.ts    requirePermission, getScope
    │   ├── validate.ts      Checks params / query / body with Zod
    │   ├── notFound.ts      404 for unknown routes
    │   └── errorHandler.ts  The ONLY place errors become responses
    ├── routes/              URL → controller (index.ts mounts every feature)
    ├── controllers/         Read the request, call a service, send the reply
    ├── services/            Business logic and database work
    │                        (incl. permission, scope and hierarchy services: section 9)
    ├── validators/          Zod rules for each feature (+ common.ts)
    ├── utils/               apiResponse, errors, asyncHandler, pagination, phone
    └── generated/prisma/    Generated Prisma client (never edit, not committed)
```

---

## 5. How a request flows

```
request
  → requestContext   (gives it an ID)
  → pino-http        (logs it)
  → helmet, cors     (security)
  → JSON body reader, cookie reader
  → route → requireAuth (protected routes) → validate(...) → controller → service → database
  → sendSuccess(...)              on success
  → throw AppError → errorHandler on failure
```

**The layers:**
- **Routes** only connect a URL to its checks and its controller.
- **Controllers** stay thin: read the clean request, call the service, send the reply.
- **Services** hold all business logic and database work.
- **Validators** hold the Zod rules for each feature.

**Imports:** relative imports must end in `.js` (ESM), for example `import { prisma } from "../lib/prisma.js";`

---

## 6. API conventions

### 6.1 Response format

**Success:**
```json
{
  "success": true,
  "message": "optional text",
  "data": { },
  "meta": { "page": 1, "limit": 20, "total": 53, "totalPages": 3 }
}
```
`meta` appears on lists only. Use `sendSuccess(res, status, data, message?, meta?)` from `src/utils/apiResponse.ts`.

**Error:**
```json
{
  "success": false,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Invalid request data",
    "details": [{ "path": "body.points", "message": "Too small: expected number to be >=100" }],
    "requestId": "0192f5a0-…"
  }
}
```

### 6.2 Errors

**Throw** one of these from `src/utils/errors.ts`. Never send an error reply yourself:

| Class | Status | Code |
|---|---|---|
| `ValidationError` | 400 | `VALIDATION_ERROR` |
| `UnauthorizedError` | 401 | `UNAUTHORIZED` |
| `ForbiddenError` | 403 | `FORBIDDEN` |
| `NotFoundError` | 404 | `NOT_FOUND` |
| `ConflictError` | 409 | `CONFLICT` |
| `TooManyRequestsError` | 429 | `TOO_MANY_REQUESTS` |
| `ServiceUnavailableError` | 503 | `SERVICE_UNAVAILABLE` |
| `AppError` | any | your own code |

The error handler also turns these automatically:
- Zod errors → 400.
- A duplicate unique value (Prisma P2002) → 409.
- A record not found (P2025) → 404.
- Broken JSON → 400.
- A body that's too big → 413.
- The database can't be reached → 503.

Anything else is a bug and becomes a 500. In production its message is hidden from the client.

### 6.3 Request ID

- Every request gets an ID, returned in the **`X-Request-Id`** header and in `error.requestId`.
- If the client sends its own safe `X-Request-Id` (letters, numbers, `-` or `_`, up to 100 characters), it is reused.
- Every log line and every audit row carries the same ID. **To debug a failed request, search the logs for its ID.**
- In code, `getRequestContext()` gives `{ requestId, ip, userAgent }`.

### 6.4 Validation

Every route checks its input with `validate(...)` before the controller runs:

```ts
import { z } from "zod";
import { validate, type RequestSchemas, type ValidatedRequest } from "../middlewares/validate.js";
import { idParams } from "../validators/common.js";
import { asyncHandler } from "../utils/asyncHandler.js";

const schemas = {
  params: idParams,
  body: z.object({ points: z.number().int().min(100) }),
} satisfies RequestSchemas;

router.post(
  "/:id/payouts",
  validate(schemas),
  asyncHandler<ValidatedRequest<typeof schemas>>(async (req, res) => {
    req.body.points; // typed as number, already checked
  })
);
```

- All problems from params, query and body come back together, in one 400.
- Unknown fields are **removed**.
- Text like `"5"` becomes a number where the schema uses `z.coerce`.
- Ready-made rules in `validators/common.ts`:
  - `idParams` for a UUID `:id`;
  - `phoneSchema`, which cleans any Indian mobile to `91XXXXXXXXXX`.

### 6.5 Lists: paging, sorting and filters

**Every list is paged.** No endpoint returns an unlimited list.

| Query | Meaning | Default |
|---|---|---|
| `?page=2` | Page number, from 1 | `1` |
| `?limit=50` | Rows per page, 1 to **100** | `20` |
| `?sort=name` | Sort by one field, A→Z / oldest first | set per list (usually `-createdAt`) |
| `?sort=-name` | The same field, reversed (Z→A / newest first) | |
| `?status=active` | Filters: plain `field=value` pairs, defined per list | — |

- Only **one** sort field per request.
- Each list allows only its own sort fields. Any other value is a 400 that lists the allowed ones.
- Asking for a page past the end returns an empty list with the correct `meta`.

```ts
import { listQuery, pageMeta, toPrismaOrderBy, toPrismaPaging } from "../utils/pagination.js";

const zoneListQuery = listQuery({
  sortFields: ["name", "code", "createdAt"],
  defaultSort: "-createdAt",
}).extend({ status: z.enum(["active", "inactive"]).optional() });

// in the service:
const [rows, total] = await prisma.$transaction([
  prisma.zone.findMany({
    where,
    ...toPrismaPaging(q.page, q.limit),
    orderBy: toPrismaOrderBy(q.sort),
  }),
  prisma.zone.count({ where }),
]);
sendSuccess(res, 200, rows, undefined, pageMeta(q.page, q.limit, total));
```

`toPrismaOrderBy` always adds the `id` as a tie-breaker, so rows never repeat or go missing between pages. For the `settings` table, which has no `id`, pass `"key"` as the second argument.

---

## 7. Shared building blocks

### Settings: `getSetting(key)`

Business values the Admin can change without a code change: OTP expiry, minimum payout, session length and so on.

```ts
import { getSetting } from "../services/settings.service.js";
const minPoints = await getSetting("payout.min_points"); // → 100 (a number)
```

- Every setting is listed in `src/config/settings.ts` with its type, default, description and allowed `min`/`max` (or `readOnly`). **A new setting = one entry there, then `npm run db:seed`.**
- A misspelled key doesn't compile.
- Values are cached for 60 seconds. `PATCH /api/settings/:key` clears the cache itself (section 9.4).
- A missing or broken setting stops with a clear 500 `SETTING_ERROR`. It never quietly uses a default.

### Audit log: `recordAudit(tx, {...})`

Every change must write an audit row **inside the same transaction**:

```ts
await prisma.$transaction(async (tx) => {
  await tx.zone.update({ where: { id }, data: { name } });
  await recordAudit(tx, {
    actorId: currentUser.id, // null for system actions
    action: "zone.update", // always "thing.verb"
    entity: { type: "zone", id },
    before: { name: oldName }, // only the fields that changed
    after: { name },
  });
});
```

- Only a **transaction** client compiles. Passing the plain `prisma` client is a type error.
- The request ID, IP and device are filled in automatically.
- Secret fields are hidden automatically:
  - OTP, password and token → `[REDACTED]`;
  - Aadhaar, PAN, bank account and UPI ID → last 4 characters only.
- `audit_log` is **insert-only**. Never update or delete its rows.

### Roles

Use `ROLE.ADMIN`, `ROLE.ZONAL_HEAD` and the rest from `src/config/roles.ts`, never bare numbers.

| ID | Key | Tier | App |
|---|---|---|---|
| 1 | `admin` | 0 | web |
| 2 | `sub_admin` | 1 | web |
| 3 | `zonal_head` | 2 | web |
| 4 | `asm` | 3 | field |
| 5 | `sales_executive` | 4 | field |
| 6 | `partner` | 5 | partner |

### Phone numbers

They are always stored as **`91` + 10 digits**, with no `+` (for example `919876543210`), which is the format MSG91 expects. Clean input with `normalizePhone()` or `phoneSchema`.

### Seed (`npm run db:seed`)

- Adds the 6 roles, the first Admin (from `.env`), all settings and the permission matrix, in one transaction.
- **Safe to run again:** it only adds what is missing.
  - It never creates a second Admin.
  - It **never overwrites** a setting the Admin has changed.
  - **Permissions are the exception:** the table is made to match `src/config/permissionMatrix.ts` exactly (section 9.1).
- Each change writes an audit row with actor = system.

### Dev test data (`npm run db:dev-data`)

**Development only** (DEC-047). It adds a small pretend company so every role can be tried by hand, for example in Apidog. Run `npm run db:seed` first.

- **Who it adds:**
  - 2 zones: `TPUNE` and `TMUM`;
  - 3 Sub-Admins: one with Partners & KYC, one with Rewards & Payouts, one with no areas;
  - a Zonal Head per zone;
  - 3 ASMs (Pune ASM 1 has 2 Sales Executives, Pune ASM 2 has none);
  - 6 partners with mixed KYC states, one of them suspended.
- **Phones `9000000101`–`9000000146`.** The script prints the full table. To log in as them, add the numbers to `TEST_PHONES` in `.env`; they use `TEST_OTP`.
- **Safe:**
  - it refuses to run with `NODE_ENV=production`;
  - it only adds what is missing and never changes existing data;
  - it runs in one transaction and writes audit rows.
- **Easy to spot:** every name starts with "TEST".

---

## 8. Login & sessions (Module 2)

Everyone, Admin included, logs in with **phone + OTP**. Each role may use only its own app: `web` (Admin, Sub-Admin, Zonal Head), `field` (ASM, Sales Executive) or `partner`.

### 8.1 Endpoints (all under `/api/auth`)

| Method & path | Login needed | What it does |
|---|---|---|
| `POST /otp/request` | No | `{ phone, app }` → sends an OTP. 30 s wait before asking again |
| `POST /otp/verify` | No | `{ phone, app, otp, deviceId?, deviceName? }` → logs in. A new partner number creates the partner account |
| `POST /refresh` | No | Swaps the refresh token for a new access token + new refresh token |
| `GET /me` | Yes | Who am I |
| `GET /me/permissions` | Yes | My actions and their scopes (section 9.4) |
| `GET /sessions` | Yes | My logged-in devices (`isCurrent` marks this one) |
| `DELETE /sessions/:id` | Yes | Log out one of my devices |
| `POST /logout` | Yes | Log out this device |
| `POST /logout-all` | Yes | Log out every device, this one included |

### 8.2 Tokens

- **Access token:** sent as `Authorization: Bearer <token>`. It lasts **15 minutes**.
- **Refresh token:**
  - **Apps** get it in the login reply and send it back in the `/refresh` body.
  - **Web** gets it in the `jp_refresh` httpOnly cookie, sent automatically.
  - It lasts 7 days (web) or 60 days (apps), and **each refresh restarts the clock**.
  - Each refresh gives a new one. **Using an old one again ends that session** (treated as stolen).
- **Partners:** one device only. A new login ends the old device's session.
- **What the app should do:** on `401 ACCESS_TOKEN_INVALID`, call `/refresh` once. If that fails, go to the login screen. **The web console must not run two refreshes at the same time.**

### 8.3 Protecting a route

```ts
import { requireAuth, requireApp, requireRole, getAuthUser } from "../middlewares/auth.js";
import { ROLE } from "../config/roles.js";

router.get("/zones", requireAuth, requireApp("web"), requireRole(ROLE.ADMIN), controller.list);

// in the controller:
const user = getAuthUser(req); // id, roleId, tier, zoneId, parentId, subAdminAreas…
```

- `requireAuth` checks the session and user in the database on **every** request, so a logout or deactivation works immediately.
- To end all of a user's sessions (deactivate, transfer, role change), call `revokeAllSessions(tx, { userId, reason, actorId })` from `services/session.service.ts`, inside your transaction.

### 8.4 Testing login without SMS

- With `SMS_PROVIDER=dummy`, the OTP is printed in the server terminal as `[DEV SMS] OTP for …`.
- Numbers listed in `TEST_PHONES` always use `TEST_OTP` and never get an SMS.

---

## 9. Permissions, scope & settings (Module 3)

Three questions, three tools. Use all three on every protected route that touches records.

| Question | Tool | Refusal |
|---|---|---|
| **May you do this action at all?** | `requirePermission("kyc.verify")` | 403 |
| **Which records can you see?** | `scopeForPartners(user, scope)`, `scopeForStaff(user, scope)` + `assertInScope` | 404 |
| **May you manage this person?** | `assertCanManage(...)`, `assertCanCreate(...)` | 403 / 404 |

### 9.1 Actions and the permission matrix

- **Every action** (e.g. `kyc.verify`, `payouts.approve`) is listed in `src/config/capabilities.ts`, with the Sub-Admin areas that unlock it. A misspelled action doesn't compile.
- **Who may do what** is in `src/config/permissionMatrix.ts` (one block per role, scope `full` / `scoped` / `own`). The full matrix with reasons: `docs/Permission Matrix.md`.
- **`npm run db:seed` copies the matrix into the `permissions` table**: it adds, updates and deletes rows to match the file, with an audit row for each (DEC-049).
- **To change a permission:** edit `permissionMatrix.ts`, then run `npm run db:seed`. A running server picks it up within 60 seconds (DEC-043, DEC-050).
- **No row = refused** (default deny). Open doubts (D4.2, D4.5, D4.8, D11.11, D15.1, D17.2) have no row yet.

### 9.2 Protecting a route

```ts
import { requireAuth, getAuthUser } from "../middlewares/auth.js";
import { requirePermission, getScope } from "../middlewares/permission.js";
import { scopeForPartners, assertInScope } from "../services/scope.service.js";

router.get("/partners", requireAuth, requirePermission("partners.view"), controller.list);

// in the service: every list and every get-by-ID goes through the scope filter
const where = { AND: [scopeForPartners(user, scope), filtersFromTheQuery] };

const partner = await prisma.user.findFirst({
  where: { AND: [{ id }, scopeForPartners(user, scope)] },
});
assertInScope(partner, { user, entity: "partner", id }); // 404 if missing or outside scope
```

- `requirePermission` refuses with **403** and logs a warning; otherwise `getScope(req)` gives `full`, `scoped` or `own`.
- **Sub-Admins** also need an area that unlocks the action. Their areas are read fresh on every request, so a change applies straight away.
- **Who sees what** (DEC-051):

  | Role | Partners | Staff |
  |---|---|---|
  | Admin | all | all |
  | Sub-Admin | all (with the area) | all, through the staff picker only |
  | Zonal Head | their zone | everyone in their zone, incl. themselves |
  | ASM | partners they own | themselves + their Sales Executives |
  | Sales Executive | partners currently assigned to them | none |
  | Partner | only themselves | none |

- When in doubt (no zone, unknown role) the filter matches **nothing**, never everything.

### 9.3 "Only below me" (DEC-052)

```ts
import { assertCanManage, assertCanCreate } from "../services/hierarchy.service.js";

const target = await assertCanManage(user, getScope(req), "staff", id); // or "partner"
assertCanCreate(user, getScope(req), { roleId: ROLE.ASM, zoneId });
```

- You can only manage someone **strictly below** you **and** in your scope. **Never yourself.**
- When adding someone: the role must be below yours; Zonal Head, ASM and SE can only add in their own zone.

### 9.4 Endpoints

| Method & path | Who | What it does |
|---|---|---|
| `GET /api/auth/me/permissions` | Anyone logged in | My actions and their scopes (for showing/hiding buttons) |
| `GET /api/sub-admins` | Admin | All Sub-Admins with their areas |
| `GET /api/sub-admins/:id/areas` | Admin | One Sub-Admin's areas, who gave each, when |
| `PUT /api/sub-admins/:id/areas` | Admin | `{ areas: [...] }`, the full list; empty allowed; audited |
| `GET /api/settings` | Admin | All settings with value, min, max, default, read-only |
| `PATCH /api/settings/:key` | Admin | `{ value }`; checked against min/max; `otp.length` is read-only; audited |

API docs: `docs/api/auth.openapi.yaml` and `docs/api/settings-permissions.openapi.yaml`.

### 9.5 Dev-only test endpoints

Mounted **only when `NODE_ENV` is not `production`** (`src/routes/dev.routes.ts`). Docs: `docs/api/dev.openapi.yaml`. Use them with the dev test data (section 7).

| Path | Tests |
|---|---|
| `GET /api/dev/permission-check/:capability` | The permission guard |
| `GET /api/dev/scope/partners[/:id]`, `/api/dev/scope/staff[/:id]` | The scope filter |
| `GET /api/dev/can-manage/staff/:id`, `/can-manage/partners/:id`, `POST /api/dev/can-create` | The "only below me" rule |

---

## 10. Rules every feature must follow

These are short versions; the full list is R1–R14 in the build plan.

1. **Permissions are checked on the server.** Never trust the client to hide things.
2. **Scope:** every list and every get-by-ID goes through the scope filter. A record outside the user's scope returns **404**.
3. **The rewards ledger is insert-only.** Points are computed by the server only.
4. **Audit:** every change writes `audit_log` in the same transaction.
5. **No hard deletes** of business records. Change their status instead.
6. **Changes to several tables happen in one transaction.**
7. **Scan, payout and request creation are retry-safe** (idempotent).
8. **Types:** points are `Int`, rupees `Decimal(12,2)`, IDs are UUIDs, times are UTC.
9. **Never log** OTPs, tokens, passwords, or Aadhaar/PAN/bank numbers.
   - The logger hides the field names in `src/config/sensitiveFields.ts`.
   - **A new secret field must use one of those names, or be added to that list.**
10. **Every list is paged** (section 6.5).
11. **Every protected route uses `requireAuth`** (section 8.3) **and `requirePermission`** (section 9.2).

---

## 11. Adding a new feature (checklist)

1. Add or change models in `prisma/schema.prisma`, then run `npm run db:migrate`.
2. New actions: add them to `src/config/capabilities.ts` and `src/config/permissionMatrix.ts`, then run `npm run db:seed`. New record types: add a `scopeFor…` function to `src/services/scope.service.ts`.
3. Write Zod rules in `src/validators/<feature>.schema.ts`.
4. Put the business logic in `src/services/<feature>.service.ts`, with an audit row for every change.
5. Write a thin controller in `src/controllers/<feature>.controller.ts`.
6. Create the routes in `src/routes/<feature>.routes.ts` and mount them in `src/routes/index.ts`.
7. Add any new settings to `src/config/settings.ts` (with `min`/`max`) and run `npm run db:seed`.
8. Document the endpoints in `docs/api/<module>.openapi.yaml` and import it into **Apidog** (there is no Swagger in this project: DEC-015, DEC-042).
9. Run `npm run typecheck` and `npm run format:check`.

---

## 12. Not in yet

- **ESLint:** waiting for typescript-eslint to support TypeScript 7 (DEC-023).
- **Automated tests:** written at the end of the project (DEC-014).
- **Rate limiting** (including per-phone and per-IP OTP limits): added in Module 18, before go-live (DEC-016).
- **Real MSG91 SMS:** built, not yet tested with a real key. The current template is a temporary one and must be replaced with a DLT-approved OTP template before production (DEC-034).
