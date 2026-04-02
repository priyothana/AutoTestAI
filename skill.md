---
name: autotest-ai
description: >
  Use this skill for ANY task related to the AutoTest AI application. The
  Python-to-Node.js migration is COMPLETE — the Python backend (backend/) is
  LEGACY and must NOT be modified. All development happens in services/api/
  (Node.js Fastify) and frontend/ (Next.js). Trigger this skill when the user
  mentions: adding a new feature, fixing a bug, adding a module, modifying
  routes or schemas, working on the Playwright execution engine, LangChain.js
  RAG, Salesforce MCP, self-healing, BullMQ workers, Prisma schema changes, UI
  pages, or any architectural decision. This file contains the authoritative
  development standards that must be followed on every code change.
---

# AutoTest AI — Development Standards

AI-driven Playwright test generation and execution platform. The Node.js
migration is **complete and production**. The Python backend at `backend/` is
read-only legacy artefact — do not touch it.

---

## ⚠️ Critical Rules (read before anything else)

1. **The Python backend (`backend/`) is DEAD.** Never modify it. Never run it.
   The Node.js backend at `services/api/` (port **4000**) is the live backend.
2. **The frontend URL must be `http://localhost:4000`.**
   `frontend/.env.local` must set `NEXT_PUBLIC_API_URL=http://localhost:4000`.
3. **All workers auto-start from `src/index.ts`.**
   Do not run workers as separate processes in development — they are imported
   inline (execution, healing, notification, metadata-sync).
4. **API contracts are locked.** Every route URL, request shape, response shape,
   and HTTP status code must match what the frontend already calls.
   Check the frontend fetch calls before touching any route.
5. **Zod is the single source of truth for shapes.** Never use `any` in a route
   handler. Define a schema in `<module>.schema.ts`, parse with `.parse()`, done.

---

## Architecture at a glance

```
AutoTestAI/
├── frontend/                         ← Next.js 14 app (App Router)
│   ├── app/
│   │   ├── dashboard/
│   │   │   ├── page.tsx              ← Dashboard home
│   │   │   ├── projects/[id]/        ← Project detail + Jira/SF integration
│   │   │   ├── tests/[id]/           ← Test editor + Run Test
│   │   │   ├── execution/            ← Execution history
│   │   │   ├── test-runs/            ← Test run results
│   │   │   ├── reports/              ← Analytics
│   │   │   └── settings/             ← App settings
│   │   ├── login/ signup/
│   │   └── layout.tsx globals.css
│   ├── components/                   ← Shared UI components (shadcn/ui)
│   ├── lib/                          ← API client utilities
│   └── .env.local                    ← NEXT_PUBLIC_API_URL=http://localhost:4000
│
├── services/
│   └── api/                          ← Node.js backend (port 4000) ← LIVE
│       ├── src/
│       │   ├── index.ts              ← Fastify entry + all module registration
│       │   │                           + inline worker auto-start
│       │   ├── modules/
│       │   │   ├── auth/             ← JWT login/register
│       │   │   ├── project/          ← Projects + integrations + Jira
│       │   │   ├── test-case/        ← Test case CRUD + step management
│       │   │   ├── test-run/         ← Test run lifecycle + polling
│       │   │   ├── test-generation/  ← LangChain.js RAG → Playwright script
│       │   │   ├── execution/        ← Execution history + enqueue
│       │   │   ├── salesforce/       ← MCP session + metadata
│       │   │   ├── self-healing/     ← AI locator healing
│       │   │   ├── analytics/        ← Read-only reporting
│       │   │   ├── settings/         ← App-wide settings
│       │   │   └── notification/     ← Jira/Slack/email dispatch
│       │   ├── shared/
│       │   │   ├── auth/             ← JWT middleware (registerJwt)
│       │   │   ├── db/               ← Prisma client singleton
│       │   │   ├── encryption/       ← Fernet encrypt/decrypt
│       │   │   ├── logger/           ← pino (createModuleLogger)
│       │   │   ├── queue/            ← BullMQ connection + QUEUES constants
│       │   │   └── types/            ← Shared TS interfaces
│       │   └── workers/
│       │       ├── execution.worker.ts    ← Playwright headless runner
│       │       ├── healing.worker.ts      ← AI self-healing
│       │       ├── notification.worker.ts ← Jira/Slack/email sender
│       │       └── metadata-sync.worker.ts← Salesforce metadata pipeline
│       ├── prisma/schema.prisma      ← Introspected from Postgres
│       ├── package.json
│       └── .env                      ← PORT=4000 DATABASE_URL REDIS_URL etc.
│
├── backend/                          ← ⛔ LEGACY Python — DO NOT MODIFY
├── docker-compose.yml
└── skill.md                          ← This file
```

---

## Tech Stack

| Layer | Technology |
|---|---|
| **Frontend** | Next.js 14 (App Router), TypeScript, Tailwind CSS, shadcn/ui, Radix UI |
| **HTTP Server** | Fastify 4 + `@fastify/jwt` + `@fastify/cors` + `@fastify/helmet` |
| **Validation** | Zod — all request and response shapes |
| **ORM** | Prisma 5 — introspected from live Postgres, typed client |
| **Database** | PostgreSQL (`autotestdb`) |
| **Queue / Workers** | BullMQ over Redis (port 6379) |
| **AI / RAG** | LangChain.js (`@langchain/core`, `@langchain/anthropic`, `@langchain/openai`) |
| **Salesforce** | `jsforce` — Handles all Salesforce operations (metadata, auth, SOQL), replacing the legacy 5000+ line Python `SalesforceLightningEngine` |
| **MCP** | `@modelcontextprotocol/sdk` — Legacy MCP interfaces mapped through JSForce |
| **Test Runner** | `@playwright/test` — headless Chromium, inside `execution.worker.ts` ONLY |
| **Logging** | pino + pino-http (structured JSON, fan-out to stdout + `logs/node.log`) |
| **Unit Tests** | Vitest (service layer) + supertest (routes) |
| **Dev Runtime** | `tsx watch` — hot-reload on file save, no build needed |
| **Frontend State** | React state + SWR/fetch (no Redux) |
| **UI Components** | shadcn/ui (based on Radix UI + Tailwind) |

---

## Module Responsibilities

### auth
- Login / register / token refresh
- Routes: `POST /api/v1/users/login`, `POST /api/v1/users/register`
- JWT issued here; all protected routes use `shared/auth/jwt.ts` middleware

### project *(owns: projects, project_integrations)*
- Project CRUD, Jira integration (connect / boards / config / stories)
- Salesforce OAuth credential storage
- Routes: `/api/v1/projects`, `/api/v1/jira/*`, `/api/v1/projects/:id/connect`
- **Other modules must import `project.service.ts` — never query these tables directly**

### test-case *(owns: test_cases)*
- Test case CRUD + step array management
- Routes: `GET/POST/PUT/DELETE /api/v1/tests`
- Steps stored as JSON column; AI generation writes here too

### test-run *(owns: test_runs)*
- Creates a `test_runs` row (status=`pending`) and enqueues to BullMQ
- `getTestRun` includes a **stale-run guard**: auto-marks runs stuck in
  `pending`/`running` for >5 min as `error` so the UI polling loop can exit
- Routes: `POST/GET/DELETE /api/v1/test-runs`
- **`execution.worker.ts` writes the final `passed`/`failed`/`error` status back
  to `test_runs` — this is what the frontend polls**

### test-generation *(owns: generated_scripts)*
- Accepts prompt + project context → LangChain.js RAG chain → Playwright steps
- Routes: `POST /api/v1/generate`, `GET /api/v1/tests/:id/generate`
- Does NOT run Playwright — only generates steps and optionally enqueues

### execution *(owns: executions — legacy, still used for history)*
- Execution history listing
- Routes: `GET /api/v1/executions`, `GET /api/v1/executions/:id`

### salesforce *(owns: metadata_raw_store, etc.)*
- JSForce connection pooling (`lib/sf-connection.ts`), caching and SOQL queries
- Metadata sync pipeline (4-stage: raw → normalise → domain model → embeddings)
- Replaces legacy Python `SalesforceLightningEngine`
- Routes: `GET /api/v1/salesforce/metadata/:objectName`

### self-healing *(owns: healing_suggestions, execution_learnings)*
- `healing.worker.ts` consumes `healing-queue`
- Runs LangChain.js vision chain → suggests corrected locator
- Auto-applies if `confidence >= HEALING_THRESHOLD`
- Routes: `GET /api/v1/heal/:executionId`

### analytics *(read-only — no table ownership)*
- Pure Prisma reads
- Routes: `GET /api/v1/analytics/projects/:id/summary`, `/flakiness`, `/coverage`

### settings *(owns: app_settings)*
- Global app configuration (session reuse, LLM model, thresholds)
- Routes: `GET/PUT /api/v1/settings`

### notification *(owns: notification_logs)*
- `notification.worker.ts` consumes `notification-queue`
- Sends Jira ticket comments, Slack webhooks, email
- Routes: `POST /api/v1/notifications/test`
- **No other module sends notifications — they enqueue to `notification-queue`**

---

## Development Standards

### Frontend (Next.js)

**File locations:**
- Pages: `frontend/app/dashboard/<feature>/page.tsx`
- Shared components: `frontend/components/<ComponentName>.tsx`
- API helpers: `frontend/lib/`

**Rules:**
- All API calls use `process.env.NEXT_PUBLIC_API_URL` (resolves to `http://localhost:4000`)
- Never hardcode `localhost:8000` or `localhost:4000` in component code
- Use `fetch` directly (no axios); add `try/catch` on every call
- Show loading states + error messages for every async operation
- Use `useRef` for intervals/timeouts to prevent stale closure bugs
- Client components that poll (e.g. test run status) MUST store the interval in a
  `useRef` so cleanup works correctly across re-renders
- Polling loops MUST have a hard timeout (90s max) and a consecutive-error counter
  (bail after 5 failed polls)
- Provide a manual "Stop" escape hatch for any long-running operation in the UI
- Jira API field names: always `jira_domain` / `jira_email` / `jira_token`
  (the Node.js Zod schema uses these; `domain`/`email`/`api_token` are wrong)
- Boards response shape: `{ boards: [...] }` (not a raw array)

**Component patterns:**
```tsx
// ✅ Correct polling with cleanup refs
const pollIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
const pollTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

const stopPolling = () => {
  if (pollIntervalRef.current) clearInterval(pollIntervalRef.current)
  if (pollTimeoutRef.current) clearTimeout(pollTimeoutRef.current)
  pollIntervalRef.current = null
  pollTimeoutRef.current = null
}

// ✅ Correct API call pattern
const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/api/v1/test-runs`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(payload),
})
if (!res.ok) {
  const err = await res.json().catch(() => ({ detail: 'Unknown error' }))
  throw new Error(err.detail || 'Request failed')
}
```

---

### Backend (Node.js — Fastify)

**Module file structure (mandatory):**
```
modules/<name>/
├── <name>.routes.ts    ← Fastify plugin; validates input; calls service only
├── <name>.service.ts   ← All business logic; public interface for other modules
└── <name>.schema.ts    ← Zod schemas for request + response shapes
```

**Cross-module import rule:**
```ts
// ✅ ALLOWED — another module's public service interface
import { getProjectById } from '../project/project.service.js'

// ❌ FORBIDDEN — never import another module's routes or schema
import { projectRoutes } from '../project/project.routes.js'
import { ProjectCreateSchema } from '../project/project.schema.js'
```

**Route handler pattern:**
```ts
// <module>.routes.ts
export async function myRoutes(app: FastifyInstance) {
  app.post('/things', async (request, reply) => {
    try {
      const body = MyRequestSchema.parse(request.body)   // Zod parse — throws on invalid
      const result = await svc.createThing(body)
      return reply.status(201).send(result)
    } catch (err: any) {
      if (err?.statusCode) return reply.status(err.statusCode).send({ detail: err.message })
      throw err   // unhandled → Fastify 500
    }
  })
}
```

**Service error pattern:**
```ts
// Throw a plain object with statusCode — routes catch and forward it
if (!thing) throw { statusCode: 404, message: 'Thing not found' }
if (!valid) throw { statusCode: 400, message: 'Validation failed: ...' }
```

**Registering a new module in `index.ts`:**
```ts
import { myRoutes } from './modules/my-feature/my-feature.routes.js'
// Add to the modules array in buildApp():
{ name: 'my-feature', fn: myRoutes as never, prefix: '/api/v1' }
```

**Long-running work → always use a BullMQ worker:**
- Playwright execution ✓ (execution.worker.ts)
- LLM / AI calls ✓ (healing.worker.ts, generation via service)
- MCP / Salesforce sync ✓ (metadata-sync.worker.ts)
- Email / Slack / Jira notifications ✓ (notification.worker.ts)

**Worker pattern:**
```ts
// workers/<name>.worker.ts
import { Worker } from 'bullmq'
import { QUEUES } from '../shared/queue/queues.js'
import { getRedisOptions } from '../shared/queue/connection.js'
import type { MyJob } from '../shared/queue/job-types.js'

new Worker<MyJob>(QUEUES.MY_QUEUE, async (job) => {
  const { field1, field2 } = job.data
  // do work — write results to Prisma
}, { ...getRedisOptions(), concurrency: 3 })
```

**Adding a new worker:**
1. Add the job type to `shared/queue/job-types.ts`
2. Add the queue name to `shared/queue/queues.ts`
3. Create `workers/<name>.worker.ts`
4. Auto-start it in `src/index.ts` (append an `import('./workers/<name>.worker.js')` call)

---

### Database (Prisma + PostgreSQL)

**Rules:**
- **Never hand-write Prisma models.** Always introspect: `cd services/api && npx prisma db pull`
- After any schema change: `npx prisma generate` to regenerate the typed client
- Each module only queries its own tables — enforced by convention (no DB ACL)
- Use `prisma.$queryRaw` only for complex aggregations that Prisma query builder can't do
- Migrations: use `prisma db push` for dev, proper migration files for production

**Schema change workflow:**
```bash
cd services/api

# 1. Make the schema change directly in Postgres (via psql or migration script)
# 2. Pull the updated schema
npx prisma db pull

# 3. Regenerate the typed client
npx prisma generate

# 4. Restart the dev server (tsx watch usually picks it up automatically)
```

**Key tables owned by each module:**

| Module | Prisma models |
|---|---|
| project | `projects`, `project_integrations` |
| test-case | `test_cases` |
| test-run | `test_runs` |
| execution | `executions` (legacy history) |
| salesforce | `metadata_raw_store`, `metadata_normalized`, `domain_models`, `vector_embeddings` |
| self-healing | `healing_suggestions`, `execution_learnings` |
| settings | `app_settings` |
| notification | `notification_logs` |
| auth | `users` |

**Critical: `test_runs` is what the frontend polls.** The execution worker writes
`passed`/`failed`/`error` back to `test_runs`. The `executions` table is legacy.

**Encryption:** Sensitive fields (passwords, tokens, API keys) are Fernet-encrypted.
Always use `fernetEncrypt()`/`fernetDecrypt()` from `shared/encryption/fernet.ts`
before storing or after reading any credential field.

---

### Queue Contracts

Defined in `shared/queue/queues.ts` (names) and `shared/queue/job-types.ts` (shapes).
Both producer and consumer import from these files — never duplicate the shape.

| Queue | Producer | Consumer |
|---|---|---|
| `execution-queue` | `test-run.service.ts` | `execution.worker.ts` |
| `healing-queue` | `execution.worker.ts` | `healing.worker.ts` |
| `notification-queue` | `healing.worker.ts` | `notification.worker.ts` |
| `metadata-sync-queue` | Salesforce trigger | `metadata-sync.worker.ts` |

```ts
// shared/queue/queues.ts
export const QUEUES = {
  EXECUTION:     'execution-queue',
  HEALING:       'healing-queue',
  NOTIFICATION:  'notification-queue',
  METADATA_SYNC: 'metadata-sync-queue',
} as const

// shared/queue/job-types.ts — canonical shapes
export interface ExecutionJob {
  testRunId:    string
  testCaseId:   string
  projectId:    string
  triggeredBy:  'manual' | 'auto'
  context:      ExecutionContext
}
export interface HealingJob {
  executionId:       string
  testRunId:         string
  testCaseId:        string
  projectId:         string
  failedLocator:     string
  screenshotBase64:  string
  htmlSnippet:       string
  logs:              Record<string, unknown>[]
  steps:             StepData[]
}
export interface NotificationJob {
  projectId:    string
  event:        'test-failed' | 'test-healed' | 'test-passed'
  executionId:  string
}
```

---

### Unit Testing

**Tooling:** Vitest (unit, service layer) + supertest (HTTP integration tests)

**What to test:**
| Layer | Tool | What |
|---|---|---|
| Service functions | Vitest | Logic, Prisma mocked with `vi.mock` |
| Route handlers | Vitest + supertest | HTTP status codes, response shapes, error paths |
| Workers | Vitest | Job processing logic with mocked Prisma + BullMQ |
| Frontend components | N/A for now | Manual QA + E2E tests planned |

**Service unit test pattern:**
```ts
// modules/<name>/<name>.service.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import prisma from '../../shared/db/prisma.js'

vi.mock('../../shared/db/prisma.js', () => ({
  default: {
    test_runs: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
  },
}))

describe('getTestRun', () => {
  it('throws 404 when run not found', async () => {
    vi.mocked(prisma.test_runs.findUnique).mockResolvedValue(null)
    await expect(getTestRun('bad-id')).rejects.toMatchObject({ statusCode: 404 })
  })
})
```

**Route integration test pattern:**
```ts
// modules/<name>/<name>.routes.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { buildApp } from '../../../index.js'
import supertest from 'supertest'

let app: Awaited<ReturnType<typeof buildApp>>

beforeAll(async () => { app = await buildApp() })
afterAll(async () => { await app.close() })

describe('POST /api/v1/test-runs', () => {
  it('returns 404 for unknown test case', async () => {
    const res = await supertest(app.server)
      .post('/api/v1/test-runs')
      .send({ test_case_id: '00000000-0000-0000-0000-000000000000' })
    expect(res.status).toBe(404)
    expect(res.body).toHaveProperty('detail')
  })
})
```

**Run tests:**
```bash
cd services/api
npm test              # run all tests once
npm run test:watch    # watch mode
```

---

## Adding a New Feature — Checklist

Before writing any code, answer these questions:

1. **Which module owns this?** If it spans multiple modules, split the logic —
   each module owns its slice. Cross-module calls go through the public
   `.service.ts` interface.

2. **Is this synchronous or asynchronous?**
   - Immediate response → Fastify route
   - Long-running (Playwright, LLM, MCP, email) → BullMQ worker

3. **Does the API path + shape match what the frontend already calls?**
   Search the frontend for the fetch URL before touching any route.

4. **Are credentials stored encrypted?**
   Any credential touching the DB must go through `fernetEncrypt`/`fernetDecrypt`.

5. **Have I written tests?**
   New service functions → Vitest unit test.
   New routes → supertest integration test.

6. **Frontend uses the right env var?**
   All API calls use `process.env.NEXT_PUBLIC_API_URL` — never a hardcoded URL.

7. **Worker auto-started?**
   If a new worker was added, add the `import('./workers/<name>.worker.js')` call
   to the auto-start block in `src/index.ts`.

---

## Environment Variables

**Backend** (`services/api/.env`):
```bash
PORT=4000
NODE_ENV=development
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/autotestdb
REDIS_URL=redis://localhost:6379
JWT_SECRET=<secret>
JWT_EXPIRES_IN=7d
SECRET_KEY=<same-as-jwt-secret>          # legacy alias used by some modules
OPENAI_API_KEY=
ANTHROPIC_API_KEY=
LLM_PROVIDER=anthropic                   # 'openai' | 'anthropic'
LLM_MODEL=claude-sonnet-4-20250514
SALESFORCE_ENCRYPTION_KEY=               # Fernet key for credential encryption
SALESFORCE_REDIRECT_URI=http://localhost:4000/api/v1/integrations/salesforce/callback
HEALING_THRESHOLD=0.85
```

**Frontend** (`frontend/.env.local`):
```bash
NEXT_PUBLIC_API_URL=http://localhost:4000
NEXT_PUBLIC_BACKEND_VERSION=node
NEXT_PUBLIC_NODE_API_URL=http://localhost:4000
```

---

## Running Locally

```bash
# 1. Ensure Postgres + Redis are running
redis-cli ping          # should return PONG
psql -U postgres -c "SELECT 1 FROM pg_database WHERE datname='autotestdb'"

# 2. Start the Node.js backend (auto-starts all workers)
cd services/api
npm run dev             # tsx watch src/index.ts — hot reload on save

# 3. Start the Next.js frontend
cd frontend
npm run dev             # http://localhost:3000

# 4. Verify
curl http://localhost:4000/health        # should return {"status":"ok"}
```

---

## Common Mistakes to Avoid

| Mistake | Correct approach |
|---|---|
| Editing `backend/` Python code | All changes go in `services/api/` |
| Using port 8000 in the frontend | Always port 4000 (`NEXT_PUBLIC_API_URL`) |
| Sending `domain`/`email`/`api_token` to Jira endpoints | Use `jira_domain`/`jira_email`/`jira_token` |
| Worker updates `executions` table for test runs | Write to `test_runs` (that's what the frontend polls) |
| Starting execution worker manually | It auto-starts from `index.ts` |
| Hand-writing Prisma models | Always `prisma db pull` then `prisma generate` |
| Importing from another module's `.routes.ts` or `.schema.ts` | Import from `.service.ts` only |
| Using `setInterval` without a ref | Use `useRef<ReturnType<typeof setInterval>>` for cleanup |
| Polling without a hard timeout | Max 90s + consecutive error bail-out after 5 failures |
| Hardcoding secrets or API keys | Use env vars, encrypt with Fernet before DB storage |
| Running a raw array response from a Jira boards endpoint | Wrap in `{ boards: [...] }` |

---

## Code Patterns Reference

### Fastify route with Zod validation
```ts
app.post('/things', async (request, reply) => {
  try {
    const body = ThingCreateSchema.parse(request.body)
    const thing = await svc.createThing(body)
    return reply.status(201).send(thing)
  } catch (err: any) {
    if (err?.statusCode) return reply.status(err.statusCode).send({ detail: err.message })
    throw err
  }
})
```

### Enqueuing a BullMQ job
```ts
import { Queue } from 'bullmq'
import { QUEUES } from '../../shared/queue/queues.js'
import { getRedisOptions } from '../../shared/queue/connection.js'
import type { ExecutionJob } from '../../shared/queue/job-types.js'

const queue = new Queue<ExecutionJob>(QUEUES.EXECUTION, getRedisOptions())

await queue.add('execute', jobPayload, {
  attempts: 3,
  backoff: { type: 'exponential', delay: 2000 },
})
```

### Module logger
```ts
import { createModuleLogger } from '../../shared/logger/index.js'
const log = createModuleLogger('my-module')
log.info('something happened')
log.warn({ err }, 'warning with context')
log.error({ err }, 'error with context')
```

### Encrypting credentials before DB write
```ts
import { fernetEncrypt, fernetDecrypt } from '../../shared/encryption/fernet.js'

const encrypted = fernetEncrypt(plaintextPassword)
await prisma.project_integrations.update({ where: { id }, data: { password: encrypted } })

// Reading back:
const decrypted = fernetDecrypt(row.password)
```

### LangChain.js AI call
```ts
import { ChatAnthropic } from '@langchain/anthropic'
import { ChatPromptTemplate } from '@langchain/core/prompts'

const llm = new ChatAnthropic({ model: process.env.LLM_MODEL })
const prompt = ChatPromptTemplate.fromMessages([
  ['system', SYSTEM_PROMPT],
  ['human', '{input}'],
])
const chain = prompt.pipe(llm)
const result = await chain.invoke({ input: userPrompt })
```

### Salesforce JSForce Connection
```ts
import { getConnection, executeWithRetry } from '../../modules/salesforce/lib/sf-connection.js'

// Simple query using the connection pool
const conn = await getConnection(projectId)
const result = await conn.query('SELECT Id FROM Account LIMIT 1')

// Operation with auto-retry on INVALID_SESSION_ID
const result = await executeWithRetry(projectId, async (conn) => {
  return await conn.describe('Account')
})
```

---

## JSForce Integration

JSForce is the **exclusive** Salesforce API client for AutoTestAI. It fully replaces the
legacy Python `SalesforceLightningEngine` (8001 proxy) and all direct `simple-salesforce`
calls. Every interaction with a Salesforce org — metadata, SOQL, record CRUD, and session
management — flows through JSForce.

### Implementation Files

| File | Role |
|---|---|
| `services/api/src/modules/salesforce/lib/sf-connection.ts` | **Core** — connection pool, auth factory, `executeWithRetry`, `drainPool`, `wrapJsforceError` |
| `services/api/src/modules/salesforce/lib/sf-metadata.ts` | JSForce `describe` / `describeGlobal` calls with 10-min in-process cache |
| `services/api/src/modules/salesforce/lib/sf-types.ts` | Shared TypeScript types (`SFCredential`, `SalesforceError`, `ObjectMetadata`, etc.) |
| `services/api/src/modules/salesforce/lib/sf-dependent-picklist.ts` | Bitmap-based dependent picklist resolution via JSForce |
| `services/api/src/modules/salesforce/salesforce.service.ts` | Public service layer — the **only** file other modules may import; wraps all JSForce calls |

### Authentication Flows

JSForce supports two auth modes, resolved automatically from `project_integrations`:

#### Password Flow (most common)
Uses `username`, `password` (Fernet-decrypted) + `security_token`. The login URL is taken
from the stored `salesforce_login_url` column (either `https://login.salesforce.com` for
production or `https://test.salesforce.com` for sandboxes).

```ts
const conn = new jsforce.Connection({ loginUrl: credential.loginUrl })
await conn.login(username, `${password}${securityToken}`)
```

#### OAuth2 Flow
If `client_id` and `access_token` are present in `project_integrations`, the access token
is set directly — no `login()` call is needed.

```ts
const conn = new jsforce.Connection({
  instanceUrl: credential.instanceUrl,
  accessToken: credential.accessToken,
  oauth2: { clientId, clientSecret },
})
```

### Connection Pool (`lib/sf-connection.ts`)

The pool maintains **one** persistent `jsforce.Connection` per `projectId`:

| Export | Purpose |
|---|---|
| `getConnection(projectId)` | Returns a cached connection; creates+authenticates if none exists. Concurrent-request-safe (pending Map deduplication). |
| `invalidateConnection(projectId)` | Evicts the cached connection; next `getConnection()` re-authenticates. |
| `executeWithRetry(projectId, fn)` | Runs `fn(conn)` with automatic re-auth on `INVALID_SESSION_ID`. Preferred over raw `getConnection()`. |
| `drainPool()` | Gracefully logs out all pooled connections. Called on `SIGTERM`. |
| `wrapJsforceError(err, objectName?)` | Converts raw JSForce errors into typed `SalesforceError` with `statusCode`. |

**Stale connection eviction** runs every 30 minutes via `conn.identity()` health checks.

### Key JSForce APIs in Use

| Operation | JSForce call | Where used |
|---|---|---|
| Login (password) | `conn.login(user, pass+token)` | `sf-connection.ts` → `_createAndAuth()` |
| Login (OAuth2) | `new Connection({ accessToken })` | `sf-connection.ts` → `_createAndAuth()` |
| Describe object | `conn.describe(objectName)` | `sf-metadata.ts` → `describeObject()` |
| Global describe | `conn.describeGlobal()` | `sf-metadata.ts` → `listObjects()`, `salesforce.service.ts` |
| SOQL query | `conn.query(soql)` | `salesforce.service.ts` → `mcpQuery()` |
| SOQL + deleted | `conn.queryAll(soql)` | `salesforce.service.ts` → `mcpQuery()` |
| Get record | `conn.retrieve(object, id)` | `salesforce.service.ts` → `mcpGetRecord()` |
| Create record | `conn.create(object, data)` | `salesforce.service.ts` → `mcpCreateRecord()` |
| Update record | `conn.update(object, data)` | `salesforce.service.ts` → `mcpUpdateRecord()` |
| Delete record | `conn.destroy(object, id)` | `salesforce.service.ts` → `mcpDeleteRecord()` |
| Search (SOSL) | `conn.search(query)` | `salesforce.service.ts` → `mcpSearch()` |
| Org limits | `conn.limits()` | `salesforce.service.ts` → `mcpLimits()` |
| Session probe | `conn.identity()` | `sf-connection.ts` → `isConnectionAlive()` |
| Logout | `conn.logout()` | `sf-connection.ts` → `drainPool()` |

### Metadata Pipeline

The 4-stage pipeline all starts with JSForce raw extraction (`syncMetadataRaw`):

```
Stage 1 — Raw extraction (JSForce)
  conn.describeGlobal() → targets (custom + 5 standard objects)
  conn.describe(objectName) per target → upsert into metadata_raw_store

Stage 2 — Normalise  → metadata_normalized
Stage 3 — Domain model → domain_models
Stage 4 — Embeddings  → vector_embeddings
```

Stages 2–4 run asynchronously via `metadata-sync.worker.ts` (BullMQ). Stage 1 is
available as a standalone export (`syncMetadataRaw`) for direct worker invocation.

### Error Handling Rules

- **Always use `executeWithRetry()`** for live Salesforce calls — it handles `INVALID_SESSION_ID` automatically.
- **Never expose raw JSForce errors** — wrap them with `wrapJsforceError()` before rethrowing.
- **DB fallback pattern** — `salesforce.service.ts` catches `NO_INTEGRATION` / `INVALID_LOGIN` errors and serves cached data from `metadata_raw_store` / `metadata_normalized` so the UI never hard-fails on a stale credential.

### Common Mistakes

| Mistake | Correct approach |
|---|---|
| Using `instanceUrl` as the `loginUrl` for sandboxes | Always use `salesforce_login_url` column (set to `test.salesforce.com` for sandboxes) |
| Importing `jsforce` directly in `salesforce.service.ts` for metadata | Use `lib/sf-metadata.ts` functions (they are cached) |
| Calling other modules' routes for Salesforce data | Import only from `salesforce.service.ts` (the public service interface) |
| Forgetting to invalidate pool after credential update | Call `invalidateConnection(projectId)` after any credential change |