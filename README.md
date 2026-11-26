# JP Interio — Backend API

The server for the **JP Interio Channel & Rewards Platform**, built by Panthar Infohub.

- Partners (carpenters, dealers, OEMs) scan QR codes on products to earn points (1 point = ₹1) and cash them out.
- Field staff manage partners, tasks and shipment / sample requests ("leads") inside a 6-tier hierarchy.
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
| `REPORTS_DATABASE_URL` | No | Dashboards and reports read through this connection (e.g. a Neon **read-only copy**). Empty = `DATABASE_URL` (DEC-210, section 20) |
| `CORS_ORIGINS` | No | Comma-separated list of web addresses allowed to call the API. Default `http://localhost:3000`. The browser may read the `Content-Disposition` and `X-Row-Count` reply headers (CSV file names and row counts, DEC-299) |
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
| `KYC_ENCRYPTION_KEY` | **Yes** | 32 random bytes in base64. Locks PAN / Aadhaar / GST / bank / UPI numbers and makes their fingerprints. **Losing or changing it makes stored numbers unreadable.** Keep a safe copy; use a different key in production. The command is in `.env.example` |
| `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` | **Yes** | Cloudflare R2 account and API token ("Object Read & Write" on this bucket only). **Never commit the keys** |
| `R2_BUCKET` | **Yes** | The R2 bucket name (one public bucket, DEC-084, DEC-085) |
| `R2_PUBLIC_BASE_URL` | **Yes** | The bucket's public link (r2.dev or custom domain), no slash at the end |
| `STORAGE_PREFIX` | **Yes** | Folder in front of every file: `dev` on development machines, `prod` in production (DEC-086) |

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
| `npm run job:clean-drafts` | Run the unfinished-onboarding clean-up now (it also runs daily inside the server, section 11) |
| `npm run job:escalate-tasks` | Run the overdue-task check now (it also runs inside the server, section 18.3). Safe any time |

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
- **Wallets (Module 8):** opens an empty points wallet for any verified partner who has none (section 14.1).
- Each change writes an audit row with actor = system.

### Dev test data (`npm run db:dev-data`)

**Development only** (DEC-047). It adds a small pretend company so every role can be tried by hand, for example in Apidog. Run `npm run db:seed` first.

- **Who it adds:**
  - 2 zones: `TPUNE` and `TMUM`;
  - 5 Sub-Admins: one with Partners & KYC, one with Rewards & Payouts, one with no areas, one with Products & Catalog (`9000000105`, DEC-116), one with QR Batches (`9000000106`, DEC-126);
  - a Zonal Head per zone;
  - 3 ASMs (Pune ASM 1 has 2 Sales Executives, Pune ASM 2 has none);
  - 6 partners with mixed KYC states, one of them suspended; the verified ones (A, C, E, F) get an empty points wallet.
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
- **No row = refused** (default deny). Open doubts (D11.11, D15.1, D17.2) have no row yet.

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
- **Partner features that need a verified partner** (catalog, scan, cash-out, requests) also add `requireVerifiedPartner` (`src/middlewares/verifiedPartner.ts`, Module 5) right after `requireAuth`:

  ```ts
  router.post("/scan", requireAuth, requireVerifiedPartner, requirePermission("scans.create"), ...)
  ```

  Unfinished / pending / rejected → **403 `PARTNER_NOT_VERIFIED`** (with `details.kycState`); staff → 403. Suspended partners are already stopped by `requireAuth`.
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

## 10. Zones, staff & the org tree (Module 4)

### 10.1 The hierarchy

```
Admin ─┬─ Sub-Admins (no zone; work by areas)
       └─ Zonal Head (exactly one per zone)
            └─ ASM (manager = the zone's Zonal Head, set automatically)
                 ├─ Sales Executive (same zone as their ASM)
                 └─ Partner (owned by the ASM; optionally looked after by one of the ASM's SEs)
```

- **Nobody is ever deleted.** People are deactivated; zones are made inactive.
- **Every change** is audited and runs in one transaction. Moving or deactivating someone **logs them out** (`revokeAllSessions`).
- **Moves only change the future.** Old records keep their old manager and zone.
- **"Reassign first":** an ASM can't be deactivated or moved to another zone while they have Sales Executives or partners; a Zonal Head can't be deactivated while in charge of a zone (DEC-057, DEC-059, DEC-066).
- **Requests (Module 11):** a Sales Executive handling an unfinished request can't be deactivated or moved; a partner with an open request can't be transferred or have their Sales Executive changed / removed (section 17.1).
- **Tasks (Module 12):** anyone with unfinished tasks given to them or by them can't be switched off or moved, and a Zonal Head can't be replaced (409 `OPEN_TASKS`); the staff profile and My Team show task counts (section 18.4).

### 10.2 Endpoints

| Method & path | Who | What it does |
|---|---|---|
| `GET /api/zones`, `GET /api/zones/:id` | Any staff | Zones with their Zonal Head and headcounts |
| `POST /api/zones`, `PATCH /api/zones/:id` | Admin | Create / edit (code in CAPITALS, code and name unique, code locked once used) |
| `POST /api/zones/:id/deactivate`, `/reactivate` | Admin | Only an empty zone can be deactivated |
| `POST /api/zones/:id/zonal-head` | Admin | Put a zoneless Zonal Head in charge; ASMs follow; the old one keeps no zone |
| `POST /api/users` | Admin, Zonal Head, ASM | Add staff (role must be below yours; manager and zone filled in) |
| `GET /api/users`, `GET /api/users/:id` | Admin, Zonal Head, ASM | Scoped list (filters) and detail (with team counts) |
| `GET /api/users/picker` | Admin, Tasks / Requests Sub-Admins | Active field staff for "assign to" dropdowns |
| `PATCH /api/users/:id` | Admin, Zonal Head | Name, phone, email (new phone → logged out) |
| `PATCH /api/users/me` | Any staff | My own name and email (never the phone) |
| `POST /api/users/:id/deactivate`, `/reactivate` | By role (see DEC-065) | SE → partners go back to the ASM |
| `POST /api/users/:id/transfer` | SE: Zonal Head / Admin; ASM: Admin | `{ asmId }` or `{ zoneId }` |
| `GET /api/team` | ASM | My Sales Executives with partner counts |
| `POST /api/partners/:id/assign-sales-executive`, `/unassign-sales-executive` | ASM | Who looks after the partner |
| `POST /api/partners/:id/transfer` | Zonal Head, Admin | Move a partner to another ASM (SE cleared) |
| `GET /api/org/tree` | Admin, Zonal Head, ASM | The hierarchy as a tree |

- **Permission by target:** add, deactivate and transfer pick the action from the role of the person involved (e.g. `sales_exec.deactivate` for an SE, `users.deactivate` for an ASM), so those checks live in `user.service.ts` (`loadForAction`), not in the route.
- API docs: `docs/api/zones.openapi.yaml`, `docs/api/users.openapi.yaml`, `docs/api/partners.openapi.yaml`.
- The full manual test plan: `docs/Module 4 complete testing.md`.

---

## 11. Partner onboarding & KYC (Module 5)

### 11.1 How a partner becomes verified

```
Carpenter:     basic info → payout account → KYC → submit
Dealer / OEM:  basic info → firm details → payout account → KYC → submit
                                                                  │
            pending ──approve──▶ verified        (self sign-up: the checker picks an ASM of the zone)
               └──reject (reason)──▶ rejected ──undo (Admin)──▶ pending
```

- **Two ways in:** the partner signs up in the Partner App (picks their zone), or an ASM / Sales Executive starts it in the Field Sales App with the partner's phone + OTP. Either one may finish the steps (DEC-091).
- **Forward only** (DEC-089): a step is accepted only when it is the current one. The partner type locks after basic info.
- **Who checks:** the Zonal Head of the zone, the Partners & KYC Sub-Admin, the Admin. Reject is final; only the Admin can undo it.
- **Unfinished onboardings** are retired after `onboarding.draft_days` days (setting, default 30): account switched off, phone and numbers freed, photos deleted (DEC-093). Runs daily inside the server (`src/jobs/draftCleanup.job.ts`) and by hand with `npm run job:clean-drafts`. The Admin can also retire one draft now (`POST /api/partners/:id/remove-draft`).

### 11.2 Sensitive numbers and files

- **PAN, Aadhaar, GST, bank account, UPI ID** are cleaned, format-checked and stored **encrypted** (AES-256-GCM) with a **fingerprint** (HMAC) for duplicate checks and the **last 4** for display (`src/lib/crypto/sensitiveData.ts`). Staff who can see the partner get the full numbers (DEC-083).
- **Duplicates are blocked** across all partners, ever (`src/services/kycDuplicate.service.ts`). A number is reserved as soon as its step is saved (DEC-095). Each check takes a short database lock on that number, so two people can't register it at the same second.
- **Files go straight from the app to Cloudflare R2:** `POST /api/uploads/upload-link` gives a 5-minute signed link, the app uploads with `PUT`, then sends the file's public URL in the step. The server checks the file is really there, the right type and size (`src/services/storage.service.ts`). One public bucket; random file names (DEC-084 – DEC-086).

### 11.3 Endpoints

| Method & path | Who | What it does |
|---|---|---|
| `POST /api/uploads/upload-link` | Partner, ASM, SE | A signed link to upload one KYC photo / PDF |
| `GET /api/partner/onboarding`, `/zones`; `PUT /basic-info`, `/firm-details`, `/kyc`; `POST /payout-account`, `/submit` | Partner | Self sign-up steps |
| `POST /api/field/onboarding/start`, `/verify`; `GET /drafts`, `/:partnerId`; the same steps under `/:partnerId/...` | ASM, SE | Field onboarding and "my drafts" |
| `GET /api/partner/status` | Partner | Which screen to show and whom to contact |
| `PATCH /api/partner/profile`; `/api/partner/payout-accounts` (list, add, edit, set-default, remove) | Verified partner | My details and my bank / UPI accounts |
| `GET /api/kyc/queue`, `GET /api/kyc/:id`; `POST /:id/approve`, `/:id/reject`, `/:id/undo-rejection` | ZH, Sub-Admin, Admin (undo: Admin) | The KYC queue |
| `GET /api/partners`, `GET /api/partners/:id` | SE, ASM, ZH, Sub-Admin, Admin | Partner list (verified only) and Partner 360 (any state) |
| `PATCH /api/partners/:id/profile`, `POST /:id/change-phone` | SE, ASM, ZH, Sub-Admin, Admin | Edit a verified partner; change their phone (no OTP, logged out) |
| `/api/partners/:id/payout-accounts` (list, add, edit, set-default, remove) | SE, ASM, ZH, Sub-Admin, Admin | A verified partner's bank / UPI accounts |
| `POST /api/partners/number-lookup`, `POST /:id/remove-draft` | Admin | Who holds a number; retire one draft now |

- API docs: `docs/api/uploads.openapi.yaml`, `onboarding.openapi.yaml`, `field-onboarding.openapi.yaml`, `kyc.openapi.yaml`, `partners.openapi.yaml`.
- The full manual test plan: `docs/testing/Module 5 complete testing.md`.

---

## 12. Product catalog (Module 6)

### 12.1 How the catalog works

```
Brand (on/off)            Category tree (each on/off, any depth)
   │                       Plywood ─┬─ Marine ─┬─ BWR
   │                                │          └─ BWP
   │                                └─ Commercial
   └──────────┬─────────────────────────┘
           Product: SKU, name, brand, ONE category (any level), MRP, one image, on/off
```

- **Managed by** the Admin and the Products & Catalog Sub-Admin (`products.manage`, DEC-108). Nothing is ever deleted, only switched off.
- **A product counts under its own category and every category above it**, not under its siblings or the ones below (DEC-109). A category filter always includes everything below it.
- **"Effectively on":** a category is really on only when its own switch and every switch above it are on. Switching a parent off hides everything below; switching it back on brings back what was not switched off by itself (DEC-110, DEC-111).
- **Who sees a product in the apps:** only when the product, its brand and its whole category chain are on.
- **What "off" blocks:**

| Switched off | Hidden in app catalog | New requests (Module 11) | New QR batches (Module 7) |
|---|---|---|---|
| Product | yes | blocked | blocked |
| Brand or category | yes | blocked | **still allowed** (DEC-110) |

  Use `assertProductUsable(productId, "request" | "qr_batch", tx?)` in `src/services/product.service.ts` for these checks; don't re-write them.
- **Unique rules** (DEC-111): brand names (any case, extra spaces ignored); brand code (optional, capitals); category names among siblings; **SKU ignoring case and spaces** (`bwp 18mm` = `BWP18MM`). The cleaned copies live in `name_key` / `sku_key` (`src/utils/catalogKeys.ts`).
- **Categories:** can be moved; never under itself or its own sub-categories, and never added / moved under a switched-off parent (DEC-112). All category changes take one lock for the whole tree. The tree is read whole and walked in memory (`src/services/categoryTree.ts`).
- **Products:** added to / moved to only an "on" brand and an effectively-on category (DEC-114). SKU can be changed until the product has its first QR batch; after that it is locked for good, even if every batch is voided (409, `skuLocked: true`, DEC-122). MRP is `Decimal(12,2)`, more than 0, returned as text (`"1250.00"`).
- **Images** (DEC-113): one per product, required. Upload with purpose `product_image` (JPG / PNG / WebP, 5 MB, needs `products.manage`), then send the `fileUrl` as `imageUrl`. Replacing the image deletes the old file from R2 after the save.

### 12.2 Endpoints

| Method & path | Who | What it does |
|---|---|---|
| `GET /api/brands`, `GET /:id`; `POST /`, `PATCH /:id`, `POST /:id/deactivate`, `/:id/reactivate` | Admin, Products Sub-Admin | Brands, with product counts |
| `GET /api/categories/tree`, `GET /:id`; `POST /`, `PATCH /:id` (rename / move), `POST /:id/deactivate`, `/:id/reactivate` | Admin, Products Sub-Admin | Category tree with own / effective switch and counts (direct + including below) |
| `GET /api/products`, `GET /:id`; `POST /`, `PATCH /:id`, `POST /:id/deactivate`, `/:id/reactivate` | Admin, Products Sub-Admin | Products; each shows `visibleInApp` and `hiddenBecause` |
| `POST /api/uploads/upload-link` (`purpose: product_image`) | Admin, Products Sub-Admin | Signed link for a product image |
| `GET /api/catalog/products`, `/products/:id`, `/categories`, `/brands` | Every role; partners must be verified | The read-only app catalog (Partner App, Field App, other staff) |

- The app catalog shows **light fields only** and filters by brand, category and text search (DEC-115). Its brand list and category tree are short reference lists and are **not paged**; the product list is.
- Partners on the catalog use `requireVerifiedIfPartner` (`src/middlewares/verifiedPartner.ts`): staff pass, a partner who is not verified gets 403 `PARTNER_NOT_VERIFIED`.
- API docs: `docs/api/catalog.openapi.yaml` (and `uploads.openapi.yaml` 0.2.0). Manual test plan: `docs/testing/Module 6 complete testing.md`.

### 12.3 One-time setup: CORS on the R2 bucket (for the web console)

Apidog and the mobile apps don't need this. A **browser** (the web console uploading product images) is blocked by R2 unless the bucket allows the console's address. Do this once before the console goes live:

1. Cloudflare dashboard → **R2** → open the bucket (`R2_BUCKET`) → **Settings** → **CORS Policy** → **Add CORS policy** (or **Edit**).
2. Paste this, with your real console address(es) in `AllowedOrigins`:

```json
[
  {
    "AllowedOrigins": ["http://localhost:5173", "http://localhost:3000"],
    "AllowedMethods": ["PUT", "GET"],
    "AllowedHeaders": ["Content-Type"],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 3600
  }
]
```

3. Save. It can take a minute to apply. Test: upload a product image from the console; the browser's network tab should show the `PUT` to R2 with status 200 and no CORS error.

**Done on 2026-11-18** with the two local addresses above (checked: both allowed to PUT; other sites and DELETE refused). **When the console gets its real domain, add it to `AllowedOrigins`.**

---

## 13. QR codes (Module 7)

### 13.1 How a batch works

```
make batch ──▶ generated ──download ZIP──▶ exported ──(download again, any number of times)
     │               └──────────┬──────────────┘
     │                        void (reason, permanent) ──▶ voided
     └─ every code: active ──scan (Module 9)──▶ scanned        unused codes on void ──▶ void
```

- **Managed by** the Admin and the QR Batches Sub-Admin only (`qr.generate`, `qr.export`, `qr.void`, `qr.view`). The Zonal Head can't see QR batches (DEC-044 Q7).
- **A code** is 12 characters of Base32 (`A–Z`, `2–7`), made with `crypto.randomBytes`: random, not in order, with no product data inside (DEC-118, DEC-121). The QR picture holds the link `https://www.jpinterio.in/q/<CODE>`. Helpers: `src/utils/qrCode.ts`.
- **Making a batch** (`POST /api/qr/batches`):
  - the product must be **switched on** (its brand / category may be off, DEC-110); checked with `assertProductUsable(id, "qr_batch", tx)`;
  - limits are settings: `qr.max_batch_size` (default 10,000) and `qr.max_points_per_code` (default 1,000) (DEC-119);
  - the batch number is `QRB-<year>-<4 digits>`, restarting every year (DEC-120);
  - codes are made **straight away** in one transaction, inserted 1,000 at a time; a clash simply makes a new code. No expiry (DEC-117).
- **SKU lock** (DEC-122): once a product has any QR batch its SKU can't change (product answers show `skuLocked`). The batch takes a share lock on the product row, so the two can't race.
- **The ZIP download** (`GET /api/qr/batches/:id/export`, DEC-123), built while it is sent (`src/services/qrExport.service.ts`):
  - `codes.csv`: batch_no, code, link, product_sku, product_name (no points);
  - `images-png/<CODE>.png` (1000 × 1000) and `images-svg/<CODE>.svg`; highest damage tolerance (level H), no text under the QR;
  - the same codes every time; every download is logged (who, when) **when it starts**; the first one sets the batch to `exported`;
  - a voided batch can't be downloaded (409). About 11 seconds and 6 MB for 3,000 codes.
- **Voiding** (`POST /api/qr/batches/:id/void`, DEC-124): permanent, reason 10–500 characters, whole batch only. Unused codes → `void`; scanned codes keep their points. Voiding twice changes nothing.
- **Locks:** download, void and (in Module 9) scanning all lock the batch row first with `lockBatch(tx, id)` from `src/services/qrBatch.service.ts`, so a scan can't slip in while a batch is being voided. **Module 9 (Scan & Earn) must use it.**
- **Reading a code** from what someone typed or scanned: `parseQrInput(input)` in `src/utils/qrCode.ts` accepts the plain code or the full link (any case, spaces and dashes ignored). It accepts any address that contains `/q/`; Module 9 decides whether scans accept only `jpinterio.in`.

### 13.2 Endpoints

| Method & path | Permission | What it does |
|---|---|---|
| `GET /api/qr/products` | `qr.generate` | Product picker: switched-on products, with brand / category and a note if hidden in the app (DEC-122) |
| `POST /api/qr/batches` | `qr.generate` | `{ productId, quantity, pointsPerCode, notes? }` → makes the batch and its codes |
| `GET /api/qr/batches/:id/export` | `qr.export` | The ZIP for printing (any number of times; logged) |
| `POST /api/qr/batches/:id/void` | `qr.void` | `{ reason }` → void the batch |
| `GET /api/qr/batches` | `qr.view` | Batch list with code counts, total points, download count; filters status, product, date range, batch-number search |
| `GET /api/qr/batches/:id` | `qr.view` | Batch details, plus every download and the void details |
| `GET /api/qr/batches/:id/codes` | `qr.view` | The batch's codes, paged; filter by status, search by code |
| `GET /api/qr/codes/:code` | `qr.view` | One code's story (plain code or URL-encoded link): status, batch, product, who scanned it |

- **Date filters** (`createdFrom`, `createdTo`) take a date-time with a time zone, e.g. `2026-11-19T00:00:00+05:30`, so the screen decides where the Indian day starts.
- API docs: `docs/api/qr.openapi.yaml`. Manual test plan: `docs/testing/Module 7 complete testing.md`.

---

## 14. Points ledger & wallet (Module 8)

### 14.1 How points are kept

- **1 point = ₹1**, whole numbers, **never expire** (DEC-127). Rupees for screens come from `pointsToRupees()` in `src/utils/money.ts` (2-decimal text).
- **`rewards_ledger`** is the passbook: **insert-only**. A database trigger refuses `UPDATE`, `DELETE` and `TRUNCATE`, and checks refuse 0 points or negative balances (hand-written SQL in migration `20261119114836_points_ledger_wallet`, DEC-130). A mistake is fixed with a new line. Test lines in the dev database can never be removed (DEC-131).
- **`wallets`** holds each partner's totals: `available`, `held`, `lifetime_earned` (scans only), `lifetime_redeemed` (paid out; a refund lowers it), `net_adjusted` (manual ±), `scan_count`. A database check keeps **available = earned + net adjusted − redeemed − held** (DEC-129).
- **Entry types:** `earn` (scan, Module 9) · `hold` / `release` / `redeem` (cash-out, Module 10) · `refund` (a paid cash-out whose transfer failed, Module 10, DEC-128) · `adjust` (manual credit / debit).
- **The only code that changes points** is `postLedgerEntry(tx, input)` in `src/services/ledger.service.ts`, inside the caller's transaction:
  1. locks the wallet row (`FOR UPDATE`): moves on one wallet wait in line;
  2. a repeat of the same scan / cash-out step returns the saved line (`duplicate: true`): retry-safe through the unique (source type, source id, type);
  3. refuses a **frozen** wallet (partner not `active` or not `verified`): every move, whoever asks (409 `WALLET_FROZEN`, DEC-131);
  4. refuses a move the balance can't cover (400 `INSUFFICIENT_POINTS`); a manual debit never goes below zero and never touches held points (DEC-128);
  5. writes the line (with the balances after it) and updates the wallet.
  It writes **no audit entry**: each feature records its own in the same transaction (DEC-131). A missing wallet is a bug: logged and refused, never created on the fly.
- **Wallets are opened** empty at KYC approval (same transaction; `walletOpened` in the approval audit), and by `npm run db:seed` / `npm run db:dev-data` for partners verified earlier (`openWallet`, `openMissingWallets` in `src/services/wallet.service.ts`, DEC-132).
- **Who made a line:** partners, ASMs and SEs see "JP Interio"; Admin, Sub-Admins and Zonal Heads see the real name (DEC-133, DEC-134).

### 14.2 Endpoints

| Method & path | Permission | What it does |
|---|---|---|
| `GET /api/partner/wallet` | `wallet.self` + verified partner | My balance card (with rupees) |
| `GET /api/partner/wallet/statement` | `wallet.self` + verified partner | My passbook; filters `type` (comma list), `direction`, `from`, `to` |
| `GET /api/partners/:id/wallet` | `ledger.view` (scope) | A partner's balance card, or `wallet: null` + note if not verified; also `partner` (name, phone, business, zone) for staff without Partner 360 (DEC-256) |
| `GET /api/partners/:id/ledger` | `ledger.view` (scope) | A partner's passbook (same filters) |
| `POST /api/partners/:id/points-adjustment` | `ledger.adjust` | `{ direction, points, reason }` (reason 10–500); Admin + Rewards Sub-Admin; audited (DEC-135) |
| `GET /api/ledger` | `ledger.view` (scope) | Lines across partners + `meta.totals`; extra filters zone, ASM, partner, search, made by |
| `GET /api/reports/points-liability` | `reports.points_liability` (Admin) | Owed = available + held, as of `asOf`, by zone, with "of which frozen" (DEC-136) |

- Partner 360 (`GET /api/partners/:id`) also has a `points` box, only for staff with `ledger.view` (DEC-134).
- `ledger.view` scope: Admin and Rewards Sub-Admin all; Zonal Head their zone; ASM their partners (incl. their SEs'); SE their assigned partners (DEC-127).
- **Not yet:** double-click protection and categories for adjustments, partner notices (DEC-135); Excel / CSV for the report (DEC-136).

### 14.3 Reconciliation (`npm run job:reconcile-ledger`)

Read-only check of every wallet against its ledger (`src/services/reconcile.service.ts`, DEC-137): totals = sum of lines, newest line = wallet, no broken chain between lines, no lines without a wallet. Mismatches → error log + one `ledger.reconcile_mismatch` audit entry, exit code 1. It **never fixes** anything. Run by hand for now (no schedule yet).

- API docs: `docs/api/ledger.openapi.yaml` (and `partners.openapi.yaml` 0.6.0 for Partner 360). Manual test plan: `docs/testing/Module 8 complete testing.md`.

---

## 15. Scan & earn (Module 9)

### 15.1 How a scan works

`POST /api/partner/scans` with `{ code, deviceId? }` (`src/services/scan.service.ts`, DEC-138 – DEC-143):

1. **Read strictly** (`parseScanInput()` in `src/utils/qrCode.ts`): only `http(s)://jpinterio.in/q/<CODE>`, `http(s)://www.jpinterio.in/q/<CODE>` or the plain 12-character code. Anything else → `INVALID_CODE`. (The staff code lookup keeps the looser `parseQrInput()`.)
2. **Find the code** → else `INVALID_CODE`.
3. **One transaction, batch row locked** with `lockBatch()` (same lock as void and download; scans from one batch go one at a time, DEC-147):
   - scanned by **this partner** → a retry: 200, the original scan, **no new points**, the balance now (DEC-142);
   - scanned by **someone else** → 409 `ALREADY_SCANNED` "This code has already been redeemed." (no date, no name);
   - **voided** code or batch → 409 `VOIDED`;
   - **active** → code marked `scanned` (who / when) + a `scans` row (zone and owning ASM copied now) + `postLedgerEntry({ type: "earn" })` with the **batch's** points + audit `scan.create`. 201.
- **Switched-off products still earn** (DEC-142). **No rate limit and no location** (DEC-138, DEC-139).
- **Three guards against double points:** the batch lock, the unique `scans.qr_code_id`, and the ledger's unique (source, type). Proven with 20 parallel scans of one code (DEC-146).
- **Failed scans** by verified partners are saved in `scan_attempts` (reason `invalid_code` / `already_scanned` / `voided`, input, code read loosely, QR code id, device, IP). No audit entry; nobody can view them yet (Module 17). A failed save is only logged (DEC-144).
- `awardScan(tx, …)`, `saveAttempt(…, db)` and the history functions take a transaction / `db`, so checks can run them and roll back.

### 15.2 Endpoints

| Method & path | Permission | What it does |
|---|---|---|
| `POST /api/partner/scans` | `scans.create` + verified partner | Scan a code: 201 new (`N points added`), 200 retry (`This scan was already counted`) |
| `GET /api/partner/scans` | `wallet.self` + verified partner | My scans: time, code, points, product; filters `from`, `to`, `productId`; `meta.totals` (scans, points) |
| `GET /api/partners/:id/scans` | `scans.view` (scope) | A partner's scans: adds the batch; device ID and IP only for Admin and Sub-Admins (DEC-145) |

- `scans.view` scope: Admin, Partners and Rewards Sub-Admins all; Zonal Head their zone; ASM their partners; SE their assigned partners. Scope follows the partner's current owner.
- API docs: `docs/api/scans.openapi.yaml`. Manual test plan: `docs/testing/Module 9 complete testing.md`.

---

## 16. Payouts (Module 10)

### 16.1 How a payout works

A verified partner cashes points out to one of their saved payout accounts (1 point = ₹1). Staff pay **by hand, outside the platform**, then mark it paid (`src/services/payout.service.ts`, DEC-148 – DEC-156).

```
requested ──approve──► approved ──mark-paid──► paid ──mark-failed──► failed (final)
    │                      │
    └──────decline─────────┘──► declined (final)
```

| Step | From | Points (`postLedgerEntry`) | Audit |
|---|---|---|---|
| Ask (`Idempotency-Key` header) | — | `hold` | `payout.request` |
| Approve | requested | none (stay held) | `payout.approve` |
| Decline (reason 10–500, partner sees it) | requested, approved | `release` | `payout.decline` |
| Mark paid (method; transaction ID unless cash; optional proof) | approved | `redeem` | `payout.mark_paid` |
| Correct paid details (no reason) | paid | none | `payout.paid_details_edit` |
| Mark failed (reason 10–500) | paid | `refund` | `payout.mark_failed` |

- **Asking** (`createPayout`): one transaction. Locks the **wallet first** (so a partner's requests and every points move wait in line), then checks the `Idempotency-Key` (same key + same points / account / note → the payout already made, 200; other details → 409 `IDEMPOTENCY_KEY_REUSED`), the minimum `payout.min_points` (no maximum, any whole number), and the account (own, not removed; locked with `lockPartnerAccounts`). The account's details **and the encrypted full number** are copied onto the payout; the partner's zone and owning ASM are copied for reports. Number `PAY-<year>-<6 digits>` from an advisory lock, restarting each UTC year.
- **Staff steps** (`approveInTx`, `declineInTx`, `markPaidInTx`, `editPaidDetailsInTx`, `markFailedInTx`): scope check by the partner's **current** owner (out of scope → 404), then lock the wallet, then the payout row (same order as asking: no deadlocks). A button pressed again → 200 `alreadyDone`, nothing changes. A step the status doesn't allow → 409 `PAYOUT_WRONG_STATUS`. A **frozen wallet** (partner suspended / not verified) refuses every step except correcting paid details → 409 `WALLET_FROZEN`; the payout waits.
- **Proof** (optional, any method): upload purpose `payout_proof` (PDF or image, 5 MB, `src/config/uploads.ts`); checked in R2 with `verifyUploadedFile` **before** the transaction. Replaced / removed proof files are kept (the audit trail still points to them). **Only staff see the proof** and staff names; the partner sees the reasons.
- **Full account numbers** are shown to everyone who can see the payout (DEC-083), never logged or written to the audit log.
- Not built (DEC-148, DEC-153, DEC-156): Processing step, partner cancel, TDS, fraud-flag block (Module 17), notifications, CSV download.

### 16.2 Endpoints

| Method & path | Permission | What it does |
|---|---|---|
| `POST /api/partner/payouts` | `payouts.request` + verified partner | Ask for a payout; 201 new, 200 retry. Needs `Idempotency-Key` |
| `GET /api/partner/payouts` | `payouts.request` + verified partner | My payouts, newest first; filter `status` |
| `GET /api/partner/payouts/:id` | `payouts.request` + verified partner | One of my payouts (someone else's → 404) |
| `GET /api/payouts` | `payouts.view` (scope) | Staff list, newest first, full numbers; filters `status`, `zoneId`, `partnerId` (DEC-258), `search`, `from`, `to`, `paidMethod`; no totals |
| `GET /api/payouts/:id` | `payouts.view` (scope) | One payout + `partnerContext` (wallet, scans last 30 days, last 5 payouts, verified date) |
| `POST /api/payouts/:id/approve` | `payouts.approve` (scope) | requested → approved |
| `POST /api/payouts/:id/decline` | `payouts.approve` (scope) | requested / approved → declined; points back |
| `POST /api/payouts/:id/mark-paid` | `payouts.mark_paid` (scope) | approved → paid; points paid out |
| `PATCH /api/payouts/:id/paid-details` | `payouts.mark_paid` (scope) | Correct method / transaction ID / proof while paid |
| `POST /api/payouts/:id/mark-failed` | `payouts.approve` (scope) | paid → failed (final); points back |

- Scope: Admin and the Rewards & Payouts Sub-Admin all partners; Zonal Head their zone; ASM (view only) their partners incl. their SEs'; Sales Executive (view only) their assigned partners.
- Partner 360 (`GET /api/partners/:id`) has a `payouts` box for staff with `payouts.view` (`payoutsBoxFor360`).
- API docs: `docs/api/payouts.openapi.yaml` (also `uploads` 0.3.0, `partners` 0.7.0). Manual test plan: `docs/testing/Module 10 complete testing.md`.

---

## 17. Requests (Module 11)

### 17.1 How a request works

A verified partner asks for a **shipment** (priced) or a free **sample** from their app. "Leads" are the same thing: there is no separate leads feature (DEC-157). It goes **automatically** to the partner's Sales Executive, or to their ASM if they have none. The handler meets the partner, agrees **one total price** (whole rupees, shipments only) and moves the request stage by stage. **No reward points are involved** (`src/services/request.service.ts`, DEC-157 – DEC-173).

```
SHIPMENT
requested ─► accepted (price) ─► payment_received ─► processing ─► dispatched ─► delivered ─► completed
    │             │                    │                  │
    └─ rejected   └── cancelled        └──── cancelled ───┘
                      (no money)              ─► refund_initiated ─► refunded

SAMPLE (free): requested ─► accepted ─► processing ─► dispatched ─► delivered ─► completed
               (rejected from requested; cancelled from accepted / processing)
```

- **Every move is permanent:** no skipping, no going back (DEC-162). The rules are in `stepAllowed`; a wrong stage → 409 `REQUEST_WRONG_STATUS`. Pressed again → 200 `alreadyDone`.
- **Open** (`OPEN_REQUEST_WHERE`) = not finished. **Finished** = completed, rejected, cancelled with no money received, refunded. A request cancelled **after payment** stays open until refunded.
- **Creating** (`createRequest`): one transaction. Locks the partner's `users` row (share) then `partner_profiles` row (update): this partner's requests wait in line and a transfer / Sales Executive change can't happen meanwhile. Then the `Idempotency-Key` check (same rule as payouts), every product through `assertProductUsable(id, "request")` (name and SKU copied), handler = Sales Executive else owning ASM, zone + owning ASM copied, number `REQ-<year>-<6 digits>` from an advisory lock, items, first timeline row, audit `request.create`.
- **Handler steps** (`handlerStepInTx`): lock the request row, then check the caller is on the handler side (`handlerWhere`: the Sales Executive handling it; the ASM for their own and their Sales Executives' requests), else 404. Accept needs `agreedAmount` for a shipment (refused for a sample). Payment received / refunded: date (past allowed, not future, India time; refund not before payment), mode `cash` / `upi` / `cheque` / `bank`, reference (required unless cash), optional receipt (upload purpose `request_receipt`, checked in R2 **before** the transaction). Payment / refund details can't be corrected (DEC-170). Each step: one timeline row (`partner_request_events`, who / when / reason) + audit `request.<step>`.
- **Cancel:** the partner (`cancelMyRequestInTx`) or the handler, from requested up to processing; reason 10–500. After payment → the handler does refund_initiated → refunded (always the full agreed amount).
- **Hand-overs** (`handOverInTx`, ASM only): assign to / move between their **active** Sales Executives, or take back, at any open stage, with a reason; locks the Sales Executive's row so they can't be deactivated meanwhile. Only that request changes, not the partner's Sales Executive.
- **Blocks while requests are open** (409 `OPEN_REQUESTS`, `details.openRequests`; DEC-165, DEC-172): partner transfer; changing or removing the partner's Sales Executive (a **first** one is allowed) — `countOpenRequestsOfPartner`; Sales Executive deactivate or move to another ASM — `countOpenRequestsHandledBy`, counted **after** their partner links are cleared so a request being saved is seen. Every one of these locks the rows in the same order as creating a request (no deadlocks).
- **India time:** "today" for dates is the IST calendar day (`src/utils/istDate.ts`, DEC-169).
- **What the partner sees:** stages with dates only (no staff names, no hand-overs, no payment details), the agreed price, the reject / cancel reason, and the **current** handler's name and phone.
- Not built (DEC-158, DEC-164, DEC-170): notifications, receipt / invoice, payment corrections, dispatch details (vehicle, LR), proof of delivery, Zonal Head / Sub-Admin / Admin actions (view only for now). (A list of all requests for the web panel was added later, F9 T1, DEC-279.)

### 17.2 Endpoints

| Method & path | Permission | What it does |
|---|---|---|
| `POST /api/partner/requests` | `requests.create` + verified partner | Send a request; 201 new, 200 retry. Needs `Idempotency-Key` |
| `GET /api/partner/requests` | `requests.view` + verified partner | My requests, newest first; filters `status`, `category` |
| `GET /api/partner/requests/:id` | `requests.view` + verified partner | One of my requests (someone else's → 404) |
| `POST /api/partner/requests/:id/cancel` | `requests.create` + verified partner | Cancel before dispatched, with a reason |
| `GET /api/requests` | `requests.view` (scope) + **web app** | All requests I may see (Admin, Requests Sub-Admin, Zonal Head; added for the panel, F9 T1, DEC-279, DEC-280); **all states** by default (`state`); filters `status`, `category`, `zoneId`, `handlerId`, `asmId` (that ASM or their Sales Executives), `search`, `from`, `to`; sort `createdAt` / `updatedAt`; rows also have the partner's current `zone`. A filter outside the scope gives an empty list |
| `GET /api/requests/worklist` | `requests.handle` | Requests I handle (ASM: + my Sales Executives'); open by default (`state`); filters `status`, `category`, `handlerId`, `search`, `from`, `to` |
| `GET /api/requests/:id` | `requests.view` (scope) + staff app (a partner → 403, DEC-280) | Full details: payment / refund with receipts, reasons, timeline with names and hand-overs |
| `POST /api/requests/:id/accept` · `reject` · `payment-received` · `processing` · `dispatched` · `delivered` · `completed` · `cancel` · `refund-initiated` · `refunded` | `requests.handle` (handler side) | One stage step each |
| `POST /api/requests/:id/assign` · `take-back` | `requests.delegate` (ASM) | Hand-overs, with a reason |
| `GET /api/partners/:id/requests` | `requests.view` (scope) + staff app (a partner → 403, DEC-280) | A partner's request history: counts (total, open, by kind, by stage, completed shipments count + ₹) and the list |

- View scope (`scopeForRequests` in `scope.service.ts`): Admin and the Requests Sub-Admin all; Zonal Head partners now in their zone; ASM requests handled by them or their Sales Executives **plus** all requests of partners they own now; Sales Executive only the ones they handle now; Partner their own. **Admin, Sub-Admin and Zonal Head are view only for now** (DEC-164); they find requests in `GET /api/requests` (web only) or through the partner.
- **Staff views are staff-only:** a partner holds `requests.view` (own) too, so the staff routes add `requireApp` (DEC-280); partners use `/api/partner/requests`.
- Partner 360 has a `requests` box for staff with `requests.view` (`requestsBoxFor360`); "My Team" (`GET /api/team`) shows open requests per Sales Executive and for the team.
- API docs: `docs/api/requests.openapi.yaml` 0.2.0 (also `partners` 0.10.0, `uploads` 0.4.0, `users` 0.8.0, `auth` 0.4.2, `settings-permissions` 0.2.2). Manual test plan: `docs/testing/Module 11 complete testing.md`.

---

## 18. Field tasks (Module 12)

### 18.1 How a task works

A manager gives a task (a dealer visit, a display setup, …) to someone below them. **Only that person** does it and completes it with **1–10 photos** and an optional note. No GPS, no task number, no comments, no repeating tasks, no partner link. Never deleted (`src/services/task.service.ts`, DEC-175 – DEC-184).

```
open ──► in_progress ──► completed      (Start is optional: open ──► completed)
  │           │
  └───────────┴──► cancelled            (giver or above; reason 10–500)
```

- **Who gives to whom** (`ASSIGNABLE_ROLES` + `scopeForStaff`): Admin → Zonal Heads, Sub-Admins, ASMs, Sales Executives; Tasks Sub-Admin → Zonal Heads, ASMs, Sales Executives (any zone); Zonal Head → ASMs and Sales Executives in their zone; ASM → their own Sales Executives and themselves; Sales Executive → nobody. Out of reach → 404, wrong role → 403, not active → 409.
- **Giving** (`createTask`): locks the giver's and the doer's `users` rows (id order), checks, saves the doer's **zone** on the task (never changes, DEC-178), audit `task.create`. Due date = a day only, today or later (India time). Category = free text; suggestions in `src/config/taskCategories.ts` (`GET /api/tasks/categories`). Priority default medium. **Not retry-safe** (no `Idempotency-Key`, DEC-180).
- **Edit / cancel** (`updateTask`, `cancelTask`): the giver **and the people above them** (`editWhere`): Admin all; Tasks Sub-Admin every task not given by the Admin; Zonal Head their own + tasks an ASM gave in their zone; ASM their own. Else 404. Completed or cancelled → 409 (locked). A new due date must be today or later and **clears the overdue flag**. Audit `task.update` (changed fields only) / `task.cancel`.
- **Start / complete** (`startTask`, `completeTask` → `completeTaskInTx`): only the doer (`assignedToId`), else 404. Photos: upload purpose `task_photo` (images only, 5 MB), each checked in R2 **before** the transaction. Late is fine (the flag stays as history; the audit says `late`). Pressed again → 200 `alreadyDone`.
- **India time:** "today" and "overdue" use the IST calendar day (`src/utils/istDate.ts`). `isOverdue` = not finished and the due day has passed.

### 18.2 Endpoints

| Method & path | Permission | What it does |
|---|---|---|
| `GET /api/tasks/categories` | `tasks.assign` | Suggested categories |
| `POST /api/tasks` | `tasks.assign` | Give a task |
| `PATCH /api/tasks/:id` | `tasks.assign` (giver or above) | Edit title, description, category, priority, due date |
| `POST /api/tasks/:id/cancel` | `tasks.assign` (giver or above) | Cancel with a reason |
| `GET /api/tasks/mine` | `tasks.complete` | Tasks given to me: `view` = unfinished (default) / today / upcoming / overdue / completed / cancelled, plus counts for every view |
| `GET /api/tasks` | `tasks.view` (scope) | Team list; filters `status` (one status, or `unfinished` = open + in progress, DEC-289), `priority`, `category`, `assignedToId`, `assignedById`, `zoneId`, `dueFrom`, `dueTo`, `overdue`, `escalatedToMe`, `search`; sort `createdAt` / `dueDate` / `completedAt` |
| `GET /api/tasks/:id` | `tasks.view` scope **or** given to me | Full details with photos |
| `POST /api/tasks/:id/start` | `tasks.complete` (doer) | open → in_progress |
| `POST /api/tasks/:id/complete` | `tasks.complete` (doer) | Complete with 1–10 photos + optional note |

- View scope (`scopeForTasks` in `scope.service.ts`): Admin and the Tasks Sub-Admin all; Zonal Head tasks whose saved zone is theirs (+ given to / by them); ASM given to them, to their Sales Executives, or by them; Sales Executive their own.
- **Every Sub-Admin** has `tasks.complete` (own), whatever their areas — an exception to rule G1, so the Admin doesn't get it (`NOT_FOR_ADMIN` in `permissionMatrix.ts`, DEC-179).

### 18.3 The nightly overdue check

- `src/services/taskEscalation.service.ts` (`escalateOverdueTasks` → `findTasksToFlag` + `flagTaskInTx`): every unfinished task past its due day and not flagged yet is flagged **once** to the doer's **direct manager** (their saved `parentId`; a manager who isn't active → the next one up): `escalated_at` + `escalated_to`, audit `task.escalate` with no actor. **The task stays with the doer.** One small transaction per task; each re-checked under its row lock, so runs can overlap safely.
- `src/jobs/taskEscalation.job.ts`, started in `server.ts`: **5 minutes after start-up**, then **every night at 00:30 India time (19:00 UTC)**. By hand: `npm run job:escalate-tasks`.
- **Serverless hosting:** in-server timers don't run reliably there. Use the platform's scheduler to run `npm run job:escalate-tasks` at 19:00 UTC instead (open for Module 18). The same applies to `job:clean-drafts`.

### 18.4 People changes and staff screens

- **Blocks** (409 `OPEN_TASKS`, `details.openTasks`; DEC-184): a person with **unfinished tasks given to them or by them** can't be switched off (any role), a Sales Executive or ASM can't be moved, and a Zonal Head can't be replaced (the old one). `assertNoOpenTasks` / `countOpenTasksOf` lock the person's `users` row first — the same row `createTask` locks — so a task can't slip in.
- **Staff profile** (`GET /api/users/:id`): `tasks: { pending, overdue, givenOpen }`. **My Team** (`GET /api/team`): `pendingTasks` / `overdueTasks` per Sales Executive and in the summary (`taskCountsFor`).
- API docs: `docs/api/tasks.openapi.yaml` (also `users` 0.9.0, `zones` 0.4.0, `uploads` 0.5.0, `auth` 0.4.3, `settings-permissions` 0.2.3). Manual test plan: `docs/testing/Module 12 complete testing.md`.

---

## 19. Support tickets (Module 15)

### 19.1 How a ticket works

A **partner** reports a problem from the Partner App; **only the Admin** handles it from the web console. Every change goes through `src/services/ticket.service.ts` (DEC-187 – DEC-194). No conversation, no "assign to", no time limit (SLA), no links to payouts / scans / QR / requests. Never deleted.

```
open ──► in_progress ──► resolved      (open ──► resolved directly is fine)
  │           │
  └───────────┴──► rejected            (resolved / rejected: note 10–2,000, final)
```

- **Who raises** (`tickets.create`, Partner only): **any state except suspended** — sign-up not finished, KYC pending, KYC rejected, verified. Suspended partners can't log in (`requireAuth`), so the routes use **no** `requireVerifiedPartner` (DEC-189). The partner only raises: no edit, cancel, close or reopen.
- **Raising** (`createTicket`): category (6 codes, labels in `src/config/ticketCategories.ts`), description 10–2,000, **0–5 photos** (upload purpose `ticket_photo`, images only, 5 MB, each checked in R2 **before** the transaction, no repeats). Photos are a **list of links in one column** `photo_urls` (no photos table, DEC-191). Number `TKT-<year>-<0001>` under a Postgres advisory lock (`support:ticket_no`), audit `ticket.create`. **Not retry-safe** (no `Idempotency-Key`, DEC-190): the Admin rejects a duplicate.
- **Handling** (`changeTicketStatus` → `changeTicketStatusInTx`, `tickets.handle`, Admin only, web only): locks the ticket row `FOR UPDATE`; allowed moves in `moveAllowed`; `in_progress` takes **no** note, `resolved` / `rejected` need one (10–2,000) and set `closed_at`. Same status again → 200 `alreadyDone` (first note kept, no audit row). A final ticket → 409. No going back to `open`. Saves `updated_by` + `status_changed_at`. Audit `ticket.start` / `ticket.resolve` / `ticket.reject` (before / after).
- **The partner never sees which Admin** handled the ticket (only status, note and dates).

### 19.2 Endpoints

| Method & path | Permission | What it does |
|---|---|---|
| `GET /api/partner/tickets/categories` | Partner, `tickets.create` | The 6 categories with display names |
| `POST /api/partner/tickets` | Partner, `tickets.create` | Raise a ticket (0–5 photos) |
| `GET /api/partner/tickets` | Partner, `tickets.create` | My tickets, newest first, optional `status` |
| `GET /api/partner/tickets/:id` | Partner, `tickets.create` | One own ticket; someone else's → 404 |
| `GET /api/tickets` | Admin, `tickets.handle`, web | Queue: `status` = unfinished (default) / all / one status; `category`; `search` (ticket number, partner name, phone); `partnerId` (one partner, DEC-295); counts per status (over all tickets) |
| `GET /api/tickets/categories` | Admin, `tickets.handle`, web | The 6 category codes + names, same as the partner endpoint (DEC-295) |
| `GET /api/tickets/:id` | Admin, `tickets.handle`, web | Full ticket with photos, the partner (phone, type, zone, KYC state), who last changed it |
| `POST /api/tickets/:id/status` | Admin, `tickets.handle`, web | `in_progress` / `resolved` / `rejected` (+ `note` for the last two) |

- **Partner 360** (`GET /api/partners/:id`): a `tickets` box `{ open, in_progress, resolved, rejected, total }`, only for staff with `tickets.handle` (the Admin) — `ticketsBoxFor360`.
- Permissions were already seeded (Partner `tickets.create` own, Admin `tickets.handle` full): no change, still 125 rows.
- API docs: `docs/api/tickets.openapi.yaml` (also `uploads` 0.6.0, `partners` 0.9.0). Manual test plan: `docs/testing/Module 15 complete testing.md`.

---

## 20. Dashboards & reports (Module 16)

### 20.1 How it works

Read-only: dashboards and CSV reports **never change business data**; the only write is one audit row per CSV download (DEC-195 – DEC-225).

- **Report connection** (`reportsDb` in `src/lib/prisma.ts`, DEC-210): every dashboard and report query reads through it. It is the main database until `REPORTS_DATABASE_URL` is set (e.g. to a Neon read-only copy) — no code change needed. Writes (the audit row) always go through `prisma`.
- **Counted live** on every call (DEC-211). No summary tables. If a number becomes slow later, switch only that one to background counting.
- **Periods** (`src/utils/period.ts`, DEC-202, DEC-209): `today`, `month` (default) and `all`, India dates. `dormantCutoff(days)`: a partner whose last scan is before this moment is **dormant** (setting `partners.dormant_days`, default 30, DEC-201).
- **Meaning of every number:** DEC-221 – DEC-223 (and the Reports & Dashboards API file). Short version:
  - "Signed up" partner = KYC pending, verified or rejected, not a retired draft. Active / dormant are counted among verified, not suspended partners.
  - **Where it happened** (DEC-222): scans, points, requests, payouts and tasks count in the zone / owning ASM **saved on the record**. Partner counts and the Zonal Head's payout cards use the partner's **current** zone.
  - A Sales Executive's scan numbers use the partners **assigned to them now** (scans don't save the SE, DEC-223).
- **Who sees what** (DEC-200): `dashboard.view` — Admin (full), every Sub-Admin (`every_area`, they see their areas' cards), Zonal Head (scoped), ASM and Sales Executive (own). `reports.view` — Admin, Sub-Admin (all 6 areas; **which** report is checked per report from their areas, `REPORT_AREAS` in `reportExport.service.ts`, DEC-214) and Zonal Head. ASMs / SEs: dashboard only. `reports.points_liability` now includes the **Rewards Sub-Admin** (DEC-205).
- **Dashboard** (`src/services/dashboard.service.ts`): one address for every role (DEC-220); `getDashboard` picks the role's cards. The card builders (`partnerCards`, `scanCards`, `payoutCards`, `requestCards`, `taskCards`, …) take a scope filter, so each role reuses them. Leaderboards: top 5 partners (points) and top 5 **active** ASMs (`rankAsmsBy` = points / scans / newPartners); ties → reached first, then name (DEC-217, DEC-222). No fraud card until Module 17 (DEC-198).
- **CSV reports** (`src/services/reportExport.service.ts`, DEC-224): `startReportDownload` checks the Sub-Admin area and the zone (a Zonal Head always gets their own zone; another zone → 403), works out the rows and the row count, writes **one `report.export` audit row** (who, report, filters, row count; DEC-218), then the controller streams the file with `writeCsv` (`src/utils/csv.ts`: BOM, India times, `'` in front of `=` `+` `-` `@`, CRLF). Big tables are read 1,000 rows at a time (no size limit, DEC-208). PAN / GST / bank / UPI in full, **Aadhaar last 4** (DEC-207). The QR batch export uses the same `csvCell`.

### 20.2 Endpoints

| Method & path | Permission | What it does |
|---|---|---|
| `GET /api/dashboard?period=today\|month\|all&rankAsmsBy=points\|scans\|newPartners` | `dashboard.view` (web and app) | My dashboard; `role` in the reply says which cards |
| `GET /api/reports/scans.csv` | `reports.view`, web; Sub-Admin: Rewards or QR | One row per scan. Filters: `from`, `to`, `zoneId`, `productId`, `partnerId` |
| `GET /api/reports/points-issued.csv` | `reports.view`, web; Sub-Admin: Rewards | One row per partner (totals) |
| `GET /api/reports/payouts.csv` | `reports.view`, web; Sub-Admin: Rewards | One row per payout; `status` |
| `GET /api/reports/partners.csv` | `reports.view`, web; Sub-Admin: Partners | One row per partner; `kycState`, `activity`, `partnerType`; dates = joined between (no default) |
| `GET /api/reports/products.csv` | `reports.view`, web; Sub-Admin: Products | One row per product |
| `GET /api/reports/regions.csv` | `reports.view`, web; Sub-Admin: Partners | One row per zone |
| `GET /api/reports/tasks.csv` | `reports.view`, web; Sub-Admin: Tasks | One row per task; `status` |
| `GET /api/reports/requests.csv` | `reports.view`, web; Sub-Admin: Requests | One row per request; `stage`, `type` |
| `GET /api/reports/points-liability` | `reports.points_liability` (Admin, Rewards Sub-Admin) | JSON, unchanged from Module 8 |

- Dates `from` / `to` (`YYYY-MM-DD`, India, both included) are optional: none = this month. The file name carries them (`payouts_2026-11-01_to_2026-11-21.csv`); `X-Row-Count` gives the rows.
- Permissions: 125 → **132** rows (`dashboard.view` × 5 roles; Sub-Admin `reports.view` and `reports.points_liability`). Settings: + `partners.dormant_days`. No migration.
- API docs: `docs/api/reports.openapi.yaml` (also `ledger` 0.2.0, `auth` 0.4.4, `settings-permissions` 0.2.4). Manual test plan: `docs/testing/Module 16 complete testing.md`.

---

## 21. Rules every feature must follow

These are short versions; the full list is R1–R14 in the build plan.

1. **Permissions are checked on the server.** Never trust the client to hide things.
2. **Scope:** every list and every get-by-ID goes through the scope filter. A record outside the user's scope returns **404**.
3. **The rewards ledger is insert-only.** Points are computed by the server only, and change only through `postLedgerEntry` (section 14.1).
4. **Audit:** every change writes `audit_log` in the same transaction.
5. **No hard deletes** of business records. Change their status instead.
6. **Changes to several tables happen in one transaction.**
7. **Scan, payout and request creation are retry-safe** (idempotent).
8. **Types:** points are `Int`, rupees `Decimal(12,2)`, IDs are UUIDs, times are UTC.
9. **Never log** OTPs, tokens, passwords, or Aadhaar/PAN/bank numbers.
   - The logger hides the field names in `src/config/sensitiveFields.ts`.
   - **A new secret field must use one of those names, or be added to that list.**
10. **Every list is paged** (section 6.5). Only short reference lists for pickers are exempt (e.g. the app catalog's brands and category tree, section 12.2).
11. **Every protected route uses `requireAuth`** (section 8.3) **and `requirePermission`** (section 9.2).

---

## 22. Adding a new feature (checklist)

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

## 23. Not in yet

- **ESLint:** waiting for typescript-eslint to support TypeScript 7 (DEC-023).
- **Automated tests:** written at the end of the project (DEC-014).
- **Rate limiting** (including per-phone and per-IP OTP limits): added in Module 18, before go-live (DEC-016).
- **Real MSG91 SMS:** built, not yet tested with a real key. The current template is a temporary one and must be replaced with a DLT-approved OTP template before production (DEC-034).
