# AutoTest AI

AutoTest AI is a no-code, AI-powered test automation platform that helps users generate, execute, and analyze tests for web applications.

## Features

- **Project Management**: Organize tests by project (Web, Mobile, API).
- **AI Test Generation**: Generate test steps from natural language prompts.
- **No-Code Editor**: Drag-and-drop interface for managing test steps.
- **Execution Engine**: Run tests in the background (simulated Cypress integration).
- **Reporting**: View detailed execution logs and results.
- **Authentication**: Secure login and signup.

## Tech Stack

- **Frontend**: Next.js 15, React 19, TypeScript, Tailwind CSS, Shadcn/UI.
- **Backend**: Node.js 22, Fastify, Prisma, BullMQ, LangChain.js (migrated from Python FastAPI).
- **Salesforce Engine**: JSforce (TypeScript, ~500 lines) — replaces the legacy Python engine.
- **Database**: PostgreSQL 16.
- **Queue**: Redis + BullMQ.
- **Infrastructure**: Docker, Docker Compose.

## Salesforce Engine

The Salesforce integration is handled entirely by **JSforce** within the Node.js API service.

> The Python Salesforce engine (≈240K lines) has been **fully replaced**. The Python service is no longer required.

Key capabilities:
- `GET /api/salesforce/metadata/:objectName` — object describe with field + record type data
- `GET /api/salesforce/fields/:objectName` — typed field descriptors
- `GET /api/salesforce/picklist/:objectName/:fieldName` — picklist values
- `GET /api/salesforce/picklist-dependent/:objectName/:controller/:dependent` — bitmap-decoded dependent picklists
- `GET /api/salesforce/objects` — global describe (queryable objects)
- `GET /api/salesforce/record-types/:objectName` — record type infos
- `POST /api/salesforce/cache/invalidate` — targeted in-process cache eviction (JWT-auth required)

Connection pool features:
- One persistent JSforce connection per project (password + OAuth2 flows)
- Health-check eviction every 30 minutes via `conn.identity()`
- Concurrent-request deduplication — only one login per project at a time
- Graceful drain on SIGTERM (`conn.logout()` for all pooled connections)

To run the parity verification against a Python engine (if still available):

```bash
PROJECT_ID=<your-project-id> npx tsx scripts/sf-parity-check.ts
```


## Getting Started

### Prerequisites

- Node.js 22+ and npm
- Docker and Docker Compose (recommended for database and Redis)

### Running the Application (with Docker)

1. Clone the repository.
2. Navigate to the project root:
   ```bash
   cd AutoTestAI
   ```
3. Set up environment variables:
   - Create a `.env` file in the root directory (matching the variables in `.env.example` in `services/api`) and make sure to populate `OPENAI_API_KEY` and `ANTHROPIC_API_KEY`.
4. Start the services:
   ```bash
   docker compose up --build
   ```

5. Access the application:
   - **Frontend**: [http://localhost:3002](http://localhost:3002)
   - **Backend API**: [http://localhost:4000](http://localhost:4000)
   - **Health Check**: [http://localhost:4000/health](http://localhost:4000/health)

### Default User

You can sign up a new user via the UI at `/signup` or login using the default seed administrator:
- **Email**: `admin@autotest.ai`
- **Password**: `password`

---

## Running Without Docker (Manual Setup)

If you clone this repo on a new system and want to run it without Docker:

### Prerequisites

- A running PostgreSQL 16 database.
- A running Redis server.

### Backend Setup

```bash
cd services/api

# Copy environment variables template
cp .env.example .env

# Install Node.js dependencies
npm install

# Generate the Prisma client
npm run db:generate

# Push the schema to your PostgreSQL database
npm run db:push

# Install Playwright browsers (needed for test execution)
npx playwright install --with-deps

# Run the backend API server
npm run dev
```

### Frontend Setup

```bash
cd frontend

# Copy environment variables template
cp .env.example .env.local

# Install Node.js dependencies
npm install

# Run the frontend
npm run dev
```

By default, the local development server starts at [http://localhost:3000](http://localhost:3000). To run it on port 3002 (matching Docker setup configuration), use:
```bash
npm run dev -- -p 3002
```

### Database Initial Seed (Optional)

If you prefer to initialize the database schema and seed data manually via SQL:

```bash
psql -U <username> -d <database> -f scripts/init.sql
```

---

## Development

- **Frontend**: `cd frontend && npm run dev`
- **Backend API**: `cd services/api && npm run dev`
- **BullMQ Workers**: The backend API service automatically boots the required background workers (execution, healing, notification, metadata-sync) in development. They can also be run individually in production:
  - Execution Worker: `npm run worker:execution`
  - Healing Worker: `npm run worker:healing`
  - Notification Worker: `npm run worker:notification`
  - Metadata Sync Worker: `npm run worker:metadata-sync`
