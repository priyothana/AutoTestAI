---
name: autotest-ai-migration
description: >
  Use this skill for ANY task related to the AutoTest AI application — a Node.js
  modular monolith that migrated from Python (FastAPI + LangChain + SQLAlchemy +
  Celery) to Node.js (Fastify + LangChain.js + Prisma + BullMQ). Trigger this skill
  when the user mentions: adding a new module, modifying routes, working on the
  Playwright execution engine, the LangChain.js RAG chain, the Salesforce MCP
  integration, the self-healing engine, BullMQ workers, Prisma schema changes,
  or any architectural decision about this application. Also trigger for questions
  about module boundaries, queue contracts, API contract preservation, or migrating
  any remaining Python logic. When in doubt, use this skill — it contains the full
  architectural blueprint that must be respected on every code change.
---

# AutoTest AI — Node.js Modular Monolith

AI-driven Playwright test generation platform. Single Node.js backend on port 4000,
structured as independent modules. Frontend is Next.js (unchanged). Postgres + Redis
(unchanged).

---

## Architecture at a glance

```
autotest-ai/
├── apps/
│   └── web/                          ← Next.js frontend — DO NOT MODIFY
├── services/
│   └── api/                          ← Single Node.js backend (:4000)
│       ├── src/
│       │   ├── index.ts              ← Fastify entry, registers all modules
│       │   ├── modules/
│       │   │   ├── project/
│       │   │   ├── test-generation/
│       │   │   ├── execution/
│       │   │   ├── salesforce/
│       │   │   ├── self-healing/
│       │   │   ├── analytics/
│       │   │   └── notification/
│       │   ├── shared/
│       │   │   ├── db/               ← Prisma client singleton
│       │   │   ├── queue/            ← BullMQ setup + queue name constants
│       │   │   ├── logger/           ← pino
│       │   │   ├── auth/             ← JWT middleware
│       │   │   └── types/            ← shared Zod schemas + TS interfaces
│       │   └── workers/
│       │       ├── execution.worker.ts
│       │       ├── healing.worker.ts
│       │       └── notification.worker.ts
│       ├── prisma/schema.prisma
│       ├── package.json
│       ├── Dockerfile
│       └── .env.example
└── docker-compose.yml
```

---

## Tech stack

| Layer | Library |
|---|---|
| HTTP server | Fastify + @fastify/jwt + @fastify/cors + @fastify/helmet |
| Validation | Zod (all request/response schemas) |
| ORM | Prisma (`prisma db pull` from existing Postgres) |
| Queue | BullMQ over Redis |
| AI / RAG | LangChain.js (`@langchain/core`, `@langchain/openai`, `@langchain/anthropic`) |
| MCP | `@modelcontextprotocol/sdk` |
| Test runner | `@playwright/test` (headless, inside execution.worker.ts only) |
| Logging | pino + pino-pretty (dev) |
| Tests | Vitest (unit) + supertest (routes) |

---

## Module responsibilities

### project (owns: Project, User, Integration, Credential tables)
- CRUD for projects, users, credentials, Jira/Salesforce integration config
- Routes: `/api/projects`, `/api/projects/:id/integrations`
- **Other modules call `project.service.ts` for project/credential data — never
  query these tables directly from another module**

### test-generation (owns: GeneratedScript table)
- Accepts natural language prompt + project context
- Calls `salesforce.service.ts` to enrich prompt with org metadata
- Runs LangChain.js RAG chain → generates Playwright test script
- Enqueues to `execution-queue` if auto-run enabled
- Routes: `POST /api/generate`, `GET /api/generate/:id`,
  `GET /api/projects/:id/scripts`
- **Does NOT run Playwright — only generates and enqueues**

### execution (owns: ExecutionResult, ExecutionStep tables)
- `execution.service.ts` enqueues to `execution-queue`
- `execution.worker.ts` consumes queue → runs Playwright headlessly
- Worker captures step logs, screenshots, traces → writes to DB
- On failure: worker enqueues to `healing-queue`
- Routes: `POST /api/execute`, `GET /api/executions/:id`,
  `GET /api/projects/:id/executions`
- **Only place in the codebase where Playwright runs**

### salesforce (owns: SalesforceSession table)
- Uses `@modelcontextprotocol/sdk` to connect to Salesforce MCP server
- Handles OAuth, credential refresh, MCP session lifecycle
- Routes: `GET /api/salesforce/metadata/:objectName`,
  `GET /api/salesforce/fields/:objectName`,
  `GET /api/salesforce/picklist/:objectName/:fieldName`
- **Any module needing Salesforce data imports `salesforce.service.ts` only**

### self-healing (owns: HealingSuggestion table)
- `healing.worker.ts` consumes from `healing-queue`
- Input: `{ failedLocator, screenshotBase64, htmlSnippet, testScriptId }`
- Runs LangChain.js vision chain → outputs `{ suggestedLocator, confidence, reasoning }`
- Auto-applies fix if `confidence > HEALING_THRESHOLD` (env var)
- Routes: `GET /api/heal/:executionId`
- **Never triggers executions — publishes to `notification-queue` on completion**

### analytics (read-only — no table ownership)
- Pure Prisma read queries, no writes
- Routes: `GET /api/analytics/projects/:id/summary`,
  `/flakiness`, `/coverage`

### notification (owns: NotificationLog table)
- `notification.worker.ts` consumes from `notification-queue`
- Sends Jira ticket updates, email, Slack webhooks
- Routes: `POST /api/notifications/test`
- **No other module sends notifications — they only enqueue to `notification-queue`**

---

## Module file conventions

Every module folder contains exactly three files:

```
<module>/
├── <module>.routes.ts    ← Fastify plugin, validates input, calls service
├── <module>.service.ts   ← All business logic. PUBLIC INTERFACE for other modules.
└── <module>.schema.ts    ← Zod schemas for request + response shapes
```

**Cross-module import rule:**
```ts
// ✅ ALLOWED — importing another module's service (public interface)
import { getProjectById } from '../project/project.service'

// ❌ FORBIDDEN — importing another module's routes or schema
import { projectRoutes } from '../project/project.routes'
import { CreateProjectSchema } from '../project/project.schema'
```

---

## Queue contracts

Defined in `shared/queue/queues.ts` (constants) and `shared/queue/job-types.ts`
(TypeScript interfaces). Both producer and consumer import from here — never
duplicate the shape.

| Queue name | Producer | Consumer |
|---|---|---|
| `execution-queue` | `execution.service.ts` | `execution.worker.ts` |
| `healing-queue` | `execution.worker.ts` | `healing.worker.ts` |
| `notification-queue` | `healing.worker.ts` | `notification.worker.ts` |

```ts
// shared/queue/queues.ts
export const QUEUES = {
  EXECUTION: 'execution-queue',
  HEALING:   'healing-queue',
  NOTIFICATION: 'notification-queue',
} as const

// shared/queue/job-types.ts
export interface ExecutionJob {
  testScriptId: string
  projectId: string
  triggeredBy: 'manual' | 'auto'
}
export interface HealingJob {
  executionId: string
  testScriptId: string
  failedLocator: string
  screenshotBase64: string
  htmlSnippet: string
}
export interface NotificationJob {
  projectId: string
  event: 'test-failed' | 'test-healed' | 'test-passed'
  executionId: string
}
```

---

## API contract rules (non-negotiable)

The Next.js frontend must require **zero changes**. Every route must match the
original Python FastAPI implementation exactly:

- URL paths identical
- Request JSON shape identical
- Response JSON shape identical
- HTTP status codes identical

Use Zod schemas in `shared/types/` to lock down contracts at compile time.
When porting a Python endpoint, always check the original route first.

---

## Python → Node.js dependency map

| Python | Node.js |
|---|---|
| FastAPI | Fastify + Zod |
| SQLAlchemy + Alembic | Prisma (`prisma db pull` first) |
| LangChain | LangChain.js |
| playwright (Python) | `@playwright/test` |
| Celery + Redis | BullMQ + Redis |
| MCP Python client | `@modelcontextprotocol/sdk` |
| Pydantic | Zod |
| python-jose | `@fastify/jwt` |
| loguru | pino |

---

## Prisma setup (first-time)

**Always introspect from the live DB — never hand-write models.**

```bash
cd services/api
npx prisma db pull        # generates schema.prisma from existing Postgres
npx prisma generate       # generates typed client
```

Each module only queries the Prisma models it owns. This is enforced by convention,
not by DB ACL — reviewers must catch violations.

---

## Adding a new feature — checklist

Before writing any code, answer these five questions:

1. **Which module does this belong to?** If it touches multiple modules, split
   the logic — each module owns its slice.
2. **Am I about to import from another module's `.routes.ts` or `.schema.ts`?**
   If yes — stop. Import from `.service.ts` only.
3. **Is this synchronous (Fastify route) or asynchronous (BullMQ worker)?**
   Long-running work (Playwright, LLM calls, MCP calls) must go through a worker.
4. **Does the API path and response shape exactly match the Python original?**
   Check before writing. Breaking the contract breaks the frontend.
5. **Have I added a Vitest test for the service layer?**
   Routes need a supertest integration test. Service functions need a Vitest unit test.

---

## Future extraction to microservices (Strangler Fig)

When a module needs to become its own service:

1. Move `modules/<name>/` into a new `services/<name>-service/` project
2. In callers, replace the direct `.service.ts` import with an HTTP `fetch` call
3. Move the module's worker from `workers/` into the new service
4. Add the new service to `docker-compose.yml` with its own port
5. Update `api-gateway` routing if present

Because module boundaries are already clean, extraction is a **move + HTTP wrapper**,
not a refactor.

---

## Environment variables

```bash
# Server
PORT=4000
NODE_ENV=development

# Database
DATABASE_URL=postgresql://user:pass@localhost:5432/autotest

# Redis
REDIS_URL=redis://localhost:6379

# Auth
JWT_SECRET=your-secret-here
JWT_EXPIRES_IN=7d

# LLM
OPENAI_API_KEY=
ANTHROPIC_API_KEY=
LLM_PROVIDER=anthropic           # 'openai' | 'anthropic'
LLM_MODEL=claude-opus-4-5

# Vector store
VECTOR_STORE_PROVIDER=chroma     # 'chroma' | 'pinecone'
CHROMA_URL=http://localhost:8000
PINECONE_API_KEY=
PINECONE_INDEX=

# Salesforce MCP
SALESFORCE_MCP_SERVER_URL=
SALESFORCE_CLIENT_ID=
SALESFORCE_CLIENT_SECRET=
SALESFORCE_INSTANCE_URL=

# Self-healing
HEALING_THRESHOLD=0.85           # auto-apply if confidence >= this value

# Notifications
JIRA_BASE_URL=
JIRA_API_TOKEN=
JIRA_PROJECT_KEY=
SLACK_WEBHOOK_URL=
SMTP_HOST=
SMTP_PORT=587
SMTP_USER=
SMTP_PASS=
```

---

## Common patterns

### Registering a module in index.ts
```ts
import { projectRoutes } from './modules/project/project.routes'
import { generationRoutes } from './modules/test-generation/generation.routes'

app.register(projectRoutes,    { prefix: '/api' })
app.register(generationRoutes, { prefix: '/api' })
```

### Fastify route with Zod validation
```ts
// generation.routes.ts
import { GenerateRequestSchema, GenerateResponseSchema } from './generation.schema'

export async function generationRoutes(app: FastifyInstance) {
  app.post('/generate', {
    schema: {
      body: zodToJsonSchema(GenerateRequestSchema),
      response: { 200: zodToJsonSchema(GenerateResponseSchema) }
    }
  }, async (req, reply) => {
    const body = GenerateRequestSchema.parse(req.body)
    const result = await generateTest(body)   // delegates to service
    return reply.send(result)
  })
}
```

### Enqueuing a BullMQ job
```ts
// execution.service.ts
import { Queue } from 'bullmq'
import { QUEUES } from '../../shared/queue/queues'
import type { ExecutionJob } from '../../shared/queue/job-types'
import { redis } from '../../shared/queue'

const executionQueue = new Queue<ExecutionJob>(QUEUES.EXECUTION, { connection: redis })

export async function enqueueExecution(job: ExecutionJob) {
  await executionQueue.add('run-test', job, { attempts: 3, backoff: { type: 'exponential', delay: 2000 } })
}
```

### BullMQ worker
```ts
// workers/execution.worker.ts
import { Worker } from 'bullmq'
import { QUEUES } from '../shared/queue/queues'
import type { ExecutionJob } from '../shared/queue/job-types'

new Worker<ExecutionJob>(QUEUES.EXECUTION, async (job) => {
  const { testScriptId, projectId } = job.data
  // run Playwright here — the ONLY place in the codebase
}, { connection: redis, concurrency: 3 })
```

### LangChain.js RAG chain
```ts
import { ChatAnthropic } from '@langchain/anthropic'
import { ChatPromptTemplate } from '@langchain/core/prompts'
import { LLMChain } from 'langchain/chains'

const chain = new LLMChain({
  llm: new ChatAnthropic({ model: process.env.LLM_MODEL }),
  prompt: ChatPromptTemplate.fromMessages([
    ['system', SYSTEM_PROMPT],   // same prompt as Python version
    ['human', '{userInput}']
  ])
})
const result = await chain.invoke({ userInput: enrichedPrompt })
```

### Salesforce MCP call
```ts
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const client = new Client({ name: 'autotest-ai', version: '1.0.0' })
await client.connect(new StdioClientTransport({ command: 'node', args: ['sf-mcp-server.js'] }))
const result = await client.callTool({ name: 'get_object_metadata', arguments: { objectName } })
```