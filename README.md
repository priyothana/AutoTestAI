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
- **Backend**: Python 3.12, FastAPI, SQLAlchemy, AsyncPG.
- **Database**: PostgreSQL 16.
- **Infrastructure**: Docker, Docker Compose.

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
