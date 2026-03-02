# Database Schema (PostgreSQL)

```mermaid
erDiagram
    USERS {
        UUID id PK
        VARCHAR email UK
        VARCHAR password_hash
        VARCHAR role
        TIMESTAMP created_at
    }

    PROJECTS {
        UUID id PK
        VARCHAR name
        VARCHAR type
        UUID user_id FK
        TIMESTAMP created_at
    }

    TEST_CASES {
        UUID id PK
        UUID project_id FK
        VARCHAR title
        JSONB steps
        TIMESTAMP created_at
        TIMESTAMP updated_at
    }

    EXECUTIONS {
        UUID id PK
        UUID test_case_id FK
        VARCHAR status
        JSONB result_metadata
        TIMESTAMP started_at
        TIMESTAMP completed_at
    }

    USERS ||--o{ PROJECTS : owns
    PROJECTS ||--o{ TEST_CASES : contains
    TEST_CASES ||--o{ EXECUTIONS : has
```

## SQL Definition (Draft)

```sql
CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email VARCHAR(255) UNIQUE NOT NULL,
    hashed_password VARCHAR(255) NOT NULL,
    is_active BOOLEAN DEFAULT TRUE,
    role VARCHAR(50) DEFAULT 'TESTER'
);

CREATE TABLE projects (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    title VARCHAR(255) NOT NULL,
    project_type VARCHAR(50),
    owner_id UUID REFERENCES users(id)
);

CREATE TABLE test_cases (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID REFERENCES projects(id),
    title VARCHAR(255) NOT NULL,
    steps JSONB DEFAULT '[]', -- List of steps
    created_at TIMESTAMP DEFAULT now()
);

CREATE TABLE test_runs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    test_case_id UUID REFERENCES test_cases(id),
    status VARCHAR(50) DEFAULT 'PENDING', -- PENDING, RUNNING, PASSED, FAILED
    logs TEXT,
    video_url VARCHAR(500),
    created_at TIMESTAMP DEFAULT now()
);
```
