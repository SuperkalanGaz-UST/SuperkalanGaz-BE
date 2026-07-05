# AGENTS.md — Superkalan Gaz Centralized CRM

> Guidance for AI coding agents working in this project. Read the **Golden Rules** and
> **Multitenancy** sections before writing any code. This project is a university capstone;
> **panel defensibility is the primary filter for every decision** — never add features,
> practices, or claims outside confirmed scope.

---

## 1. Project Overview

An ITIL 4 value-based, **centralized CRM** for **Superkalan Gaz**, an LPG franchise
distributor. It replaces manual, fragmented operations (phone orders, verbal follow-ups)
with a centralized platform. The core value stream is **order-to-delivery**; the system is
designed to optimize that Service Value System (SVS).

Requirements and acceptance criteria are tracked in **Jira project `SK`**. Treat Jira stories
as the source of truth for behavior; this file governs *how* code is written and *what*
constraints must never be violated.

---

## 2. Repositories

| Repo                   | Stack                     | Purpose                          |
| ---------------------- | ------------------------- | -------------------------------- |
| `superkalan-crm-api`   | NestJS + TypeScript       | Backend, business logic, data    |
| `superkalan-crm-web`   | Next.js (React)           | Internal staff dashboard (FA/BO/BM) |
| `superkalan-crm-mobile`| React Native + Expo       | **Customer-only** mobile app     |

Sections below are tagged `[api]`, `[web]`, `[mobile]`, or `[all]` where they apply.

---

## 3. Golden Rules (read first) `[all]`

1. **Branch scoping is mandatory.** Every data access must be filtered by `branch_id`
   according to the caller's role. A missing branch filter is a cross-tenant data leak.
   See §5.
2. **No hard deletes — ever.** Use soft delete (`deleted_at` / status columns). Never emit
   SQL `DELETE` or TypeORM `.remove()` / `.delete()` for domain records.
3. **Stay in scope.** If a request implies anything in §11 (Prohibited / Out of Scope),
   stop and state which boundary it crosses before proceeding.
4. **Use locked terminology only.** See §10. The word **"omnichannel" is banned.**
5. **MVP first.** Ship the simplest robust implementation before proposing extensions.
6. **Don't invent resolutions to open questions.** See §13. If a needed decision is
   unresolved, ask rather than assume.
7. **No hallucinated ITIL practices.** Only the four in §9 are implemented.

---

## 4. Tech Stack & Architecture `[all]`

- **Backend:** NestJS, TypeScript, TypeORM, PostgreSQL.
- **DB hosting:** Supabase **as managed Postgres only.** Do **not** use the Supabase client
  SDK or PostgREST — it would bypass the branch-scoped JWT guard system. Connect via
  standard Postgres connection + TypeORM.
- **Web:** Next.js (React).
- **Mobile:** React Native + Expo (customers only).
- **GPS:** **SinoTrack ST-901** hardware devices → **Traccar** (self-hosted middleware) →
  ingested by the API. These are two distinct things; never conflate them (§10).
- **Edge:** NGINX reverse proxy in front of the API.
- **Architecture style:** **Modular monolith** using NestJS's native module system.
  **No microservices.** RESTful, 3-tier.

---

## 5. Multitenancy & Data Isolation — CRITICAL `[api]`

- Model: **shared-schema multitenancy** with **`branch_id` row scoping**.
- Isolation is enforced **at the application layer** via **NestJS guards reading JWT
  claims** — **NOT** Postgres Row-Level Security and **NOT** physical partitioning.
- **Implication for you:** the database will not stop a cross-branch read. *You* must. Every
  repository/service query for branch-owned data must apply the `branch_id` derived from the
  authenticated principal. Do not trust a `branch_id` sent from the client body/params for
  scoping; derive it from the verified JWT.
- **Do not claim or comment that isolation is "DB-enforced."** It is guard-enforced. Accurate
  comments matter — this is a panel-defense point.

Scoping by role (see §7 for full permissions):
- **FA:** cross-branch read visibility (no operational writes).
- **BO / BM:** strictly their own `branch_id`.
- **Customer:** their own records only.

---

## 6. Database Conventions `[api]`

- **7 schemas:** `core`, `cim`, `srd`, `fleet`, `loyalty`, `csat`, `inventory` (23 tables).
- **UUID primary keys** everywhere.
- **No foreign-key constraints in the schema.** Referential integrity is enforced in the
  **NestJS service layer**. When writing services, validate referenced records exist and
  belong to the correct branch before persisting.
- **Explicit indexes are required on all reference columns** (every column used as a logical
  FK / lookup). Add the index in the same migration that introduces the column.
- **Soft delete only** (§3.2).
- Migrations are the only way to change schema; do not rely on TypeORM `synchronize`.

---

## 7. Roles & Permissions (RBAC) `[all]`

| Role | Interface | Can do | Must NOT do |
| ---- | --------- | ------ | ----------- |
| **Franchise Administrator (FA)** | Web | Cross-branch read visibility; **set system-wide SLA thresholds (only FA may)**; manage branch accounts | Any operational write; process orders; dispatch; approve redemptions |
| **Branch Owner (BO)** | Web | Configure **their branch only**: loyalty merchandise catalog, point rates, threshold values *within FA-set bounds*, Dual-Authorization toggle; view branch analytics | Process daily orders; dispatch; cross-branch access |
| **Branch Manager (BM)** | Web | **Day-to-day ops for their branch:** create/process service requests, dispatch riders, approve loyalty redemptions | Change SLA thresholds; act outside own branch |
| **Customer (CU)** | **Mobile only** | Place orders, track delivery status *milestones*, submit CSAT | Access web dashboard; see live GPS coordinates |

Hard constraints:
- **BO and BM are always separate people.** Do not merge these roles or share a session.
- **FA has no operational write actions.** Its only writes are SLA-threshold config
  (system-wide) and branch-account management.
- **Customers see delivery status milestones only — never live GPS coordinates.**

---

## 8. Module & Domain Rules `[api] [web] [mobile]`

**5 confirmed modules. There is no Supply Chain module.**

1. **Customer Information Management (CIM)** — profiles, addresses, purchase history.
2. **Service Request & Dispatch (SRD)** — digital order creation + rider assignment.
   - **Four-timestamp SLA chain (mandatory):**
     `requested_at → dispatched_at → in_transit_at → delivered_at`.
   - SLA breach is measured across **three segments**: request→dispatch,
     dispatch→in-transit, in-transit→delivery.
   - **`order_source` is mandatory on every service request** (`Mobile App` vs
     `Walk-in/Phone`) for channel-level SLA reporting. Never omit it.
   - **Race condition:** re-check `dispatched_at` state at dispatch time to prevent
     double-dispatch (panel-defense requirement).
3. **Loyalty Program Monitoring (LPM)** — see §8a. Two **separate** tracks; never merge.
4. **CSAT Feedback & Analytics** — post-delivery star ratings, complaint (Incident) logging,
   average response-time tracking.
5. **Fleet Management** — GPS via SinoTrack ST-901 → Traccar → API. **Riders do not use a
   mobile app**; there is no rider client. Live GPS/Fleet integration is
   hardware-dependent and may be sprint-deferred — check current sprint before building it.

### 8a. Loyalty Program Rules `[api] [web]`

Two entirely separate tracks — **do not share tables/logic that would merge them**:

- **Household track:** points-based; **12-month point expiry**; BO-configurable merchandise
  catalog and point rates *per cylinder size*; redemption-code system; digital ledger.
- **Commercial track:** **30+1 purchase-count model** → free cylinder reward.

Shared workflow:
- **Dual-authorization redemption:** the system flags eligibility; a **Branch Manager
  approves** before any reward dispatches.
- **`Dual Authorization` toggle** lives in **Branch Owner Settings** and controls the BM
  approval gate. **Both ON and OFF code paths must be implemented and covered in
  acceptance criteria.**
- **Re-validate eligibility at BM approval time** (not only at flagging time) — panel-defense
  requirement.

---

## 9. ITIL 4 Mapping `[all]`

Ground designs, model names, and comments in ITIL 4 — but **only these four practices**:

- **Service Request Management** → orders ("Service Requests").
- **Relationship Management** → customer relationships / CIM.
- **Service Level Management** → SLA thresholds and breach measurement.
- **Incident Management** → complaints ("Incidents").

**Do NOT invoke or imply** CMDB, Change Enablement, Problem Management, or Monitoring & Event
Management as practices this system implements. Vocabulary: "Service Request" (order),
"Incident" (complaint), "SLA breach."

---

## 10. Locked Terminology (non-negotiable) `[all]`

- **"Centralized CRM" / "value-based CRM"** — **never "omnichannel."**
- **"Branch Manager"** — never "Branch Head" / "Branch Administrator."
- **"Franchise Administrator"** — the correct top-level role name.
- **SinoTrack ST-901 = hardware device.** **Traccar = self-hosted middleware** that consumes
  SinoTrack data. Never call Traccar the tracker, or vice versa.

---

## 11. Prohibited / Out of Scope `[all]`

Do not write code for, scaffold, or suggest:
- Live corporate **ERP** integration for supply-chain replenishment.
- **HR / payroll**, employee records, **BIR / tax** reporting, or **accounting**.
- Any **rider mobile app** (riders are GPS-tracked via hardware only).
- Additional ITIL practices beyond the four in §9.
- Any feature outside the 5 modules in §8.

**In scope (do not confuse with the above):** low-stock alerts and reorder *logging* —
configurable thresholds against a **mock JSON supply endpoint**. Only the *live ERP
connection* is excluded, not the alert/logging logic.

If a prompt asks for anything prohibited, **state which boundary it crosses first**, then
propose an in-scope alternative.

---

## 12. Coding Conventions

### `[all]`
- TypeScript strict; no `any` without a written reason.
- Clean, well-commented code. Comments explain *why*, not *what*.
- Group related files into logical directories within the **correct repo**.
- Keep secrets in env vars; never commit credentials.

### `[api]`
- One NestJS module per bounded context aligned to the DB schemas (§6).
- Controllers thin; business rules in services; data access in repositories.
- Enforce branch scoping (§5) and integrity checks (§6) in the service layer.
- DTOs + validation pipes on every endpoint; never trust client input for scoping.

### `[web]`
- App Router (Next.js). Server components for data fetch where sensible.
- Role-gate every screen against §7; the UI must not render actions a role can't perform.
- Talk to the API only; no direct DB access from the web app.
- **No backend lives in this repo.** All backend logic, API endpoints, and database
  access belong in **`superkalan-crm-api`** (NestJS). Do **not** create an `api/` folder
  or Next.js API routes (e.g. `app/api/**`, `pages/api/**`) inside `superkalan-crm-web`;
  the web app only calls the NestJS API over HTTP via the client in
  `src/app/lib/api.ts`. If a request seems to need a new server route, add the endpoint in
  `superkalan-crm-api` instead.

### `[mobile]`
- Expo, customer-only flows. No staff/admin screens.
- Surface **delivery status milestones only** — no map with live coordinates.

---

## 13. Open Decisions — DO NOT ASSUME `[api]`

These are unresolved. Do not silently pick one; ask or leave a `// DECISION PENDING` marker:

- **`branch_review_log`**: separate entity vs. a status field on the `branches` table.
  (Must be settled before UAT seeding.)
- **`srd.products` pricing**: shared catalog vs. branch-independent. Current working
  assumption is a **shared catalog with price snapshotted onto the order at creation time** —
  confirm before relying on it.
- Some **Section 1.2 operational figures** (order volume, delay minutes, follow-up %) are
  pending client confirmation; do not hardcode invented numbers as if verified.

---

## 14. Build / Test / Run

> **Verify these against the actual `package.json` scripts in each repo** — the commands
> below are conventional defaults, not confirmed. Correct them if they differ.

- `[api]` `npm run start:dev` · `npm run build` · `npm run test` · `npm run test:e2e` · `npm run lint`
- `[web]` `npm run dev` · `npm run build` · `npm run lint`
- `[mobile]` `npx expo start` · `npm run lint`

Before proposing a PR: run lint + relevant tests, and confirm no branch-scoping gaps and no
scope violations (§11).

---

## 15. When Unsure `[all]`

Ask, or leave an explicit `// DECISION PENDING` / `// PANEL-CHECK` comment, rather than
guessing. Prefer the answer that is **defensible to the panel** over the one that is merely
convenient. If a request conflicts with anything in this file, this file wins — surface the
conflict.
