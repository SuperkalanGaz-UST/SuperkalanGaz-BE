# superkalan-crm-api

Backend for the **Superkalan Gaz Centralized CRM** — an ITIL 4 value-based, centralized CRM
for an LPG franchise distributor. Core value stream: **order-to-delivery**.

Requirements and acceptance criteria live in **Jira project `SK`**. Read **AGENTS.md**
before writing any code — branch scoping (`branch_id`) and soft-delete rules are mandatory.

## Stack

- **NestJS** + TypeScript (strict) — modular monolith, no microservices
- **TypeORM** + **PostgreSQL** (Supabase managed Postgres; temporary private Supabase Storage is server-only)
- **NGINX** reverse proxy at the edge
- GPS: SinoTrack ST-901 hardware → Traccar (self-hosted middleware) → this API

## Modules (5 — no Supply Chain module)

1. Customer Information Management (CIM)
2. Service Request & Dispatch (SRD)
3. Loyalty Program Monitoring (LPM)
4. CSAT Feedback & Analytics
5. Fleet Management

## Database

7 schemas (`core`, `cim`, `srd`, `fleet`, `loyalty`, `csat`, `inventory`), UUID PKs,
no FK constraints (integrity enforced in the service layer), explicit indexes on all
reference columns, **soft delete only**, migrations only (no `synchronize`).

## Branch authorization

- Protected `app_metadata.branch_ids` UUIDs are the identity scope; for Branch Owners, the
  guard intersects them with live `core.branches.owner_id` assignments before authorizing.
- A Branch Owner may own one or more branches; every branch has one active owner.
- A Branch Manager remains limited to exactly one branch.
- Branch names are display metadata only. A requested active branch may narrow the JWT
  scope after server validation, but it can never widen it.

For an existing environment, apply `migrations/0029_index_branch_owner_assignment.sql`,
then run `npm run migrate:branch-scope-uuid`. The maintenance command preflights all Auth
users, refuses ambiguous name mappings, writes UUID claims through the GoTrue Admin API,
and backfills `core.branches.owner_id`. Affected users must refresh their sessions afterward.

## Sibling repos

| Repo                    | Purpose                              |
| ----------------------- | ------------------------------------ |
| `superkalan-crm-web`    | Next.js internal staff dashboard     |
| `superkalan-crm-mobile` | React Native + Expo customer app     |

## Run

```bash
npm install
npm run start:dev   # dev server
npm run build       # production build
npm run test        # unit tests
npm run test:e2e    # e2e tests
npm run lint        # lint
```

Copy `.env.example` to `.env` and fill in values. Never commit credentials.

For Franchise Administrator invitations, add the first `WEB_ORIGIN` value to
Supabase Auth's allowed redirect URLs. Set `SUPABASE_EMAIL_OTP_EXPIRY_SECONDS`
to the same duration as the project's **Email OTP Expiration** setting so the
governance lifecycle feed and Supabase enforce the same expiry time.

For Delivery Rider invitations, set `DELIVERY_RIDER_INVITATION_REDIRECT_URL` to
the dedicated `/delivery-rider-invitation` web route (or the local custom scheme)
and add the corresponding path-scoped URL to Supabase Auth's redirect allow list.
That route supports invitation-only web onboarding and ends with a mobile-app
handoff; Delivery Rider operations remain mobile-only.
If Supabase returns the verified invitation session to the web Site URL, the web
client follows the same pending-session activation pattern used for Franchise
Administrator invitations. Only explicitly decorated Delivery Rider onboarding
endpoints accept the pending JWT.

## Temporary Proof of Delivery storage

Create a private Supabase Storage bucket named `delivery-proofs` (or set
`SUPABASE_STORAGE_BUCKET` to the approved bucket name). Public access must remain
disabled. Apply `migrations/0033_create_service_request_delivery_proofs.sql`.

The NestJS API uses the server-only `SUPABASE_SERVICE_ROLE_KEY` to upload and
stream Proof of Delivery images after enforcing the caller's branch scope. The
web and mobile clients never call Supabase Storage directly. This is a temporary
provider decision so the storage adapter can later be replaced by another
private object-storage provider without changing the domain or client APIs.
