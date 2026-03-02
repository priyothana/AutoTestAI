# High-Level Design (HLD) - AutoTest AI

## 1. System Overview
AutoTest AI is a no-code, AI-powered test automation platform designed to generate, execute, and analyze tests for web applications. It leverages Large Language Models (LLMs) to convert natural language prompts and user stories into executable Cypress test scripts.

## 2. Architecture Diagram (Conceptual)
```mermaid
graph TD
    User[User (Web/Mobile)] -->|HTTPS| CDN[CDN / Load Balancer]
    CDN --> Frontend[Frontend (Next.js)]
    Frontend -->|REST API| API_Gateway[API Gateway / Backend (FastAPI)]
    
    subgraph Backend Services
        API_Gateway --> Auth[Auth Service]
        API_Gateway --> Projects[Project Service]
        API_Gateway --> AI_Service[AI Agent Service]
        API_Gateway --> Exec_Service[Execution Service]
    end
    
    subgraph Data & Storage
        Projects --> DB[(PostgreSQL)]
        Auth --> DB
        Exec_Service --> DB
        Exec_Service --> Storage[Object Storage (S3/MinIO/Local)]
    end
    
    subgraph External
        AI_Service --> OpenAI[OpenAI API]
        Exec_Service --> Cypress[Cypress Runner (Local/Container)]
        Exec_Service --> BrowserStack[BrowserStack/SauceLabs (Future)]
    end
```

## 3. Component Description

### 3.1 Frontend (Presentation Layer)
- **Tech**: Next.js 15, React 19, TypeScript, Tailwind CSS.
- **Responsibility**: User interface for project management, test creation (No-code/AI), dashboard, and reporting.
- **Key Features**:
  - Test Editor: Drag-and-drop steps, Natural Language input.
  - Recorder Stub: Interface to receive events from a browser extension (future).
  - Dashboard: Visualization of test results.

### 3.2 Backend (Application Layer)
- **Tech**: Python 3.12, FastAPI.
- **Responsibility**: REST API handling, logic processing, orchestration.
- **Modules**:
  - **Auth**: User registration, login (JWT), role management.
  - **Projects**: Manage workspaces, projects, and environments.
  - **Test Management**: CRUD for test cases, steps, and suites.
  - **AI Service**: Interface with LLMs to generate and optimize tests.
  - **Execution Service**: Manages test runs, triggers Cypress, captures logs/video.

### 3.3 Database (Data Layer)
- **Tech**: PostgreSQL 16.
- **Responsibility**: Persistent storage of users, projects, tests, execution history, and logs.

### 3.4 Async Task Queue (Execution Layer)
- **Tech**: Celery + Redis.
- **Responsibility**: Handling long-running tasks like test generation and test execution (Cypress runs).

## 4. Data Flow

### 4.1 Test Generation Flow
1. User enters prompt: "Verify login with valid user".
2. Frontend sends prompt to `POST /api/tests/generate`.
3. AI Service constructs a prompt for OpenAI, including context setup.
4. OpenAI returns a structured list of test steps (JSON).
5. AI Service maps steps to internal "Universal Step Definition".
6. Tests are saved to DB.

### 4.2 Test Execution Flow
1. User clicks "Run" or Schedule triggers run.
2. Execution Service pushes job to Celery queue.
3. Worker picks up job:
   - Fetches test steps from DB.
   - Converts steps to dynamic Cypress code (`.cy.ts`).
   - Spawns Cypress process (Docker/Local).
   - Monitors stdout/stderr.
4. On completion, parses results (Junit/JSON report), uploads assets (video/screenshots).
5. Updates execution status in DB.

## 5. Non-Functional Requirements
- **Scalability**: Microservices ready; execution engine can scale horizontally via more workers.
- **Security**: JWT for auth; secrets management for API keys; isolated execution containers.
- **Performance**: Async processing for heavy tasks; Next.js for optimized frontend delivery.
