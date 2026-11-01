# Feature Description Module Wise

The backend is built in 12 modules, one after another. Finish each module (code, migration and tests) before starting the next.

---

## Overview

### Roles (6 levels, more can be added later)

| Level | Role | Uses | Login |
|---|---|---|---|
| 0 | Admin | Web dashboard | Google sign-in |
| 1 | Sub-Admin | Web dashboard | Google sign-in |
| 2 | Zonal Head | Web dashboard | Google sign-in |
| 3 | ASM | Field app | Phone + OTP |
| 4 | Salesman / Sales Executive (works under the ASM) | Field app | Phone + OTP |
| 5 | Partner (carpenter, dealer, OEM furniture maker) | Partner app | Phone + OTP |

Roles are stored in the database, not hardcoded, so new roles can be added without changing code.

### Platforms
- **Web dashboard:** Admin, Sub-Admin and Zonal Head
- **Field app:** ASM and Salesman
- **Partner app:** Partners

### Tools chosen
- **Google login:** Google's official sign-in on the web, checked on the backend with `google-auth-library` (no Firebase, no Better Auth)
- **OTP and SMS:** MSG91, which also covers WhatsApp in Module 11. DLT registration must be started early.
- **Sessions:** our own tokens (short access token plus long refresh token), stored in Postgres. No outside auth service.

---

## Module 1: Foundation & Shared Setup
- Replace the example `User` model with the real `users`, `roles` and `zones` tables
- Roles table holds each role's level, what data it can see, and which app it may use
- Shared request validation (body, params, query) using Zod
- Pagination helper for list endpoints
- Rate limiting to block too many requests
- System settings table (OTP expiry, session length, minimum payout and so on)
- Audit log helper that records who changed what, and when
- Test setup
- Swagger (API documentation) setup
- Seed script that fills the database with starting data (6 roles, first Admin)

## Module 2: Authentication & Sessions
**Web login (Admin, Sub-Admin, Zonal Head)**
- Sign in with Google
- Only users already created by an Admin can log in. Google never creates new accounts.
- Optionally allow only the company's Google Workspace domain
- Backup login for Admins in case Google is unavailable (method to be decided)

**App login (ASM, Salesman, Partner)**
- Phone number + OTP sent through MSG91
- ASM and Salesman: only numbers already added by a manager can log in
- Partner: a new number creates a new partner account with status "Pending KYC"
- Each role can log into its own app only (a Salesman can't use the partner app, and so on)
- OTP rules: 6 digits, valid for 5 minutes, at most 5 wrong tries, wait before resending, limits per phone and per IP
- Dummy SMS sender that prints the OTP in the logs until MSG91 and DLT are ready
- Test numbers with a fixed OTP for development and app-store review

**Sessions (same for everyone)**
- Access token (JWT, valid 15 minutes) and refresh token (long-lived)
- Refresh tokens stored hashed in a `sessions` table, one row per device
- Get a new access token silently with the refresh token. The refresh token is replaced each time.
- Detect stolen tokens: if an old refresh token is reused, end the session
- Session length: 7 days on the web, 30–60 days in the apps
- Web keeps the refresh token in a secure cookie. The apps keep it in the phone's secure storage.
- Logout, and logout from all devices
- Partners can be logged in on one device only. Logging in on a new device ends the old session and records it for fraud checks.
- All of a user's sessions end when they are deactivated, transferred, or their role changes
- "Who am I" endpoint, and a list of the user's active devices

## Module 3: Org Hierarchy & Access Control
- 6-level user tree: Admin → Sub-Admin → Zonal Head → ASM → Salesman → Partner
- Create and manage segments and zones
- Create, edit and deactivate staff users (email for web users, phone for app users)
- Assign each Salesman to an ASM
- Move a user or partner to another zone without losing their history
- Permissions for each role
- Middleware that checks whether a user is allowed to do an action
- Scope filter: users only see data in their own part of the tree
- When a post is vacant, its work goes up to the manager above

## Module 4: Partner Onboarding & KYC
- Partner self-registration in the partner app
- ASM or Salesman can register a partner during a field visit
- Upload ID documents: Aadhaar, PAN, GST, and bank or UPI details
- Store documents securely (encrypted)
- KYC approval queue for Zonal Heads
- Duplicate check on phone, PAN and bank account
- Approve or reject (a reason is required to reject)
- Partners can log in but cannot scan or redeem until they are verified
- Partner list and full partner profile view

## Module 5: Product Catalog
- Add, edit and deactivate products (SKUs)
- Product details: brand, category, sub-category, thickness, size, grade, price (MRP)
- Support for more than one brand
- Search and filter products

## Module 6: QR Code Engine
- Create a batch of QR codes for a product
- Every code in a batch carries the same fixed points
- Codes are random, unique and cannot be guessed
- Export a batch for printing
- Void or recall a whole batch (damaged, stolen or recalled stock)
- List batches and view batch details
- Look up any single QR code and see its status

## Module 7: Points Ledger & Wallet
- Points ledger where entries are only ever added, never edited or deleted
- Entry types: earn, hold, release, redeem, refund, adjust
- Wallet balance: available points and points on hold
- Admin can manually add or remove points (a reason is required)
- Partner transaction history
- Points liability report (total value of unpaid points)

## Module 8: Scan & Earn
- Partner scans a QR code with the camera, or types the code in
- In one step: mark the code as used, save the scan, add the points and update the wallet
- If a request is sent twice (bad network), points are added only once
- Clear replies: success, already scanned, voided code or invalid code
- Save the location and device of each scan
- Block accounts scanning too fast (more than 10 codes a minute)

## Module 9: Payout Redemption
- Partner turns points into cash (1 point = ₹1) via UPI or bank transfer
- Points go on hold as soon as the request is made
- Zonal Head approves (points are taken) or declines (points are returned)
- Accountant enters the bank reference number (UTR) to mark it paid
- Payout status tracking: Requested → Approved → Processing → Paid
- Minimum payout amount, taken from system settings

## Module 10: Field Operations
- Managers assign tasks to people below them (dealer visits, display setup and so on)
- ASM can assign tasks to their Salesmen
- Task status, priority and due date
- ASM or Salesman completes a task with GPS check-in and photo proof
- Overdue tasks go up to the manager automatically
- Sales leads with stages: New → Contacted → Qualified → Negotiation → Won / Lost
- Reason required when a lead is lost
- Turn a won lead into a new partner with one tap

## Module 11: Notifications & Support
- Send SMS and WhatsApp (MSG91), push notifications and email
- Message templates that admins can edit
- Replace the dummy SMS sender from Module 2 with MSG91, if it isn't already live
- Alerts for OTP, successful scans, KYC result and payout status
- Support tickets raised from the apps (damaged QR, late payout, account issues)
- Photo attachment on tickets
- Support ticket queue for staff to handle

## Module 12: Dashboards, Anti-Fraud & Final Polish
- Web dashboards for Admin, Sub-Admin and Zonal Head
- Home screen data for the field app (ASM, Salesman) and the partner app
- Each role sees only its own data
- Reports and analytics (scans, points, payouts, regions)
- Fraud checks: too many scans, shared devices, frequent device changes, scans from places too far apart
- Fraud review queue for admins
- Audit log viewer
- Full test coverage for every module
- Security tests (users cannot see data outside their scope)
- Complete API documentation and Postman collection
- Deployment guide

---

## Still to be decided
1. Does JP Interio use Google Workspace? If yes, which domain should be allowed?
2. Backup login for Admins: phone + OTP on the web, or one seeded super-admin account?
3. What can a Salesman see: only their own work, or everything under their ASM?
4. Can one person have two roles (for example Salesman and Partner)? Suggested: no, one phone number means one role.
5. Exact session lengths for the apps (30 or 60 days).
