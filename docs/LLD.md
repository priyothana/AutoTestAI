# Low-Level Design (LLD) - AutoTest AI

## 1. Domain Models (Core Entities)

### Project
- `id`: UUID
- `name`: string
- `type`: enum (WEB, MOBILE, API)
- `base_url`: string

### Test Case
- `id`: UUID
- `project_id`: UUID
- `title`: string
- `description`: string
- `steps`: JSON (List of Step Objects)
- `status`: enum (DRAFT, ACTIVE)

### Step Object (JSON Schema)
```json
{
  "order": 1,
  "action": "CLICK", // CLICK, TYPE, NAVIGATE, ASSERT_TEXT, etc.
  "target": "submit-btn", // Locator (ID, XPath, CSS)
  "value": null, // For TYPE input
  "description": "Click the submit button"
}
```

### Execution
- `id`: UUID
- `test_case_id`: UUID
- `status`: enum (PENDING, RUNNING, PASSED, FAILED)
- `logs`: text/json
- `assets`: JSON (paths to screenshots/videos)
- `started_at`: timestamp
- `completed_at`: timestamp

## 2. AI Agent Design

### 2.1 Generator Agent
- **Input**: User Prompt (string), Context (Project type)
- **Process**:
  - Uses Few-Shot Prompting with OpenAI.
  - Examples provided: "Login" -> `[Navigate, Type User, Type Pass, Click Login, Assert Dashboard]`.
- **Output**: List of Step Objects.

### 2.2 Healer Agent (Self-Healing)
- **Input**: Failed Step info, DOM Snapshot (HTML), Screenshot.
- **Process**:
  - Compares old locator with current DOM.
  - Uses similarity search / LLM to find the new locator for the same element.
- **Output**: Updated Locator.

## 3. Cypress Conversion Logic (Backend)
The backend dynamically generates Cypress spec files based on the Step Objects.

**Pseudocode:**
```python
def generate_cypress_spec(test_case):
    lines = ["describe('Auto Generated Test', () => {"]
    lines.append(f"  it('{test_case.title}', () => {{")
    
    for step in test_case.steps:
        if step.action == 'NAVIGATE':
            lines.append(f"    cy.visit('{step.value}')")
        elif step.action == 'CLICK':
            lines.append(f"    cy.get('{step.target}').click()")
        elif step.action == 'TYPE':
            lines.append(f"    cy.get('{step.target}').type('{step.value}')")
        elif step.action == 'ASSERT_TEXT':
            lines.append(f"    cy.get('{step.target}').should('contain', '{step.value}')")
            
    lines.append("  })")
    lines.append("})")
    return "\n".join(lines)
```

## 4. API Endpoints (FastAPI)

- `POST /auth/login`: Returns access_token.
- `GET /projects/`: List user projects.
- `POST /tests/generate`: Accepts `{prompt: str}`, returns `{steps: List[Step]}`.
- `POST /tests/{id}/run`: Triggers execution.
- `GET /executions/{id}`: Polling for status and results.
