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

- Docker and Docker Compose installed.

### Running the Application

1. Clone the repository (if not already).
2. Navigate to the project root:
   ```bash
   cd "Auto Test AI"
   ```
3. Start the services:
   ```bash
   docker-compose up --build
   ```

4. Access the application:
   - **Frontend**: [http://localhost:3000](http://localhost:3000)
   - **Backend API Docs**: [http://localhost:8000/docs](http://localhost:8000/docs)

### Default User

You can sign up a new user via the UI at `/signup`.

## Running Without Docker (Manual Setup)

If you clone this repo on a new system and want to run it without Docker:

### Backend Setup

```bash
cd backend

# Create a virtual environment
python3 -m venv venv

# Activate it
source venv/bin/activate        # macOS/Linux
# venv\Scripts\activate          # Windows

# Install all dependencies
pip install -r requirements.txt

# Install Playwright browsers (needed for test execution)
playwright install

# Run the backend
uvicorn app.main:app --reload
```

### Frontend Setup

```bash
cd frontend

# Install Node.js dependencies
npm install

# Run the frontend
npm run dev
```

### Database

You'll need a PostgreSQL 16 instance running. Update the database connection string in your `.env` file accordingly. You can initialize the schema using:

```bash
psql -U <username> -d <database> -f scripts/init.sql
```

## Development

- **Frontend**: `cd frontend && npm run dev`
- **Backend**: `cd backend && uvicorn app.main:app --reload`
- **Database**: The `docker-compose` setup includes a PostgreSQL container.
