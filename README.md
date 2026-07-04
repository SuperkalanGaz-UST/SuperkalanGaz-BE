# superkalan-crm-api

Backend for the **Superkalan Gaz Centralized CRM** — an ITIL 4 value-based, centralized CRM
for an LPG franchise distributor. Core value stream: **order-to-delivery**.

Requirements and acceptance criteria live in **Jira project `SK`**. Read **AGENTS.md**
before writing any code — branch scoping (`branch_id`) and soft-delete rules are mandatory.

## Stack

- **NestJS** + TypeScript (strict) — modular monolith, no microservices
- **TypeORM** + **PostgreSQL** (Supabase as managed Postgres only — no Supabase SDK/PostgREST)
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
