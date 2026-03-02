from typing import List, Dict, Any, Optional
import json
from openai import AsyncOpenAI
from app.core.config import settings
from app.schemas.test_case import StepModel

# Supported model providers and their default models
MODEL_PROVIDERS = {
    "openai": {
        "default_model": "gpt-4o-mini",
        "models": ["gpt-4o-mini", "gpt-4o", "gpt-4-turbo"],
    },
    "claude": {
        "default_model": "claude-sonnet-4-20250514",
        "models": ["claude-sonnet-4-20250514", "claude-3-7-sonnet-20250219", "claude-3-5-haiku-20241022"],
    },
}

# ─── System Prompts (shared across providers) ───────────────────────

STANDARD_SYSTEM_PROMPT = """
You are an expert QA Automation Engineer specialized in Playwright test automation.

Your task is to convert a natural language test case into a structured Playwright-compatible JSON test definition that can be executed directly by a Playwright runner.

IMPORTANT CONTEXT:
- The application base URL is managed separately in the Project configuration.
- NEVER use mock URLs like "https://example.com".
- For NAVIGATE steps:
  - Use relative paths like "/login", "/dashboard", "/accounts"
  - If no specific path is mentioned, use "/" or leave value empty ""
  - The Playwright runner will automatically prepend the Project Base URL

-------------------------
GENERAL RULES
-------------------------
1. Output ONLY valid JSON (no explanations, no comments).
2. Ensure all steps are executable and valid for Playwright automation.
3. Use stable, real-world selectors (prefer id, name, data-testid, role, text, placeholder).
4. Avoid fragile selectors like nth-child unless absolutely necessary.
5. Always include appropriate WAIT steps before ASSERT_TEXT or CLICK if the element loads dynamically.
6. Ensure selectors are valid CSS or Playwright text selectors.

-------------------------
SUPPORTED ACTIONS
-------------------------
Each step must use ONLY one of the following actions:

- NAVIGATE
- CLICK
- TYPE
- ASSERT_TEXT
- WAIT

-------------------------
STEP FORMAT
-------------------------
Each step must follow this structure:

{
  "id": "1",
  "action": "NAVIGATE | CLICK | TYPE | ASSERT_TEXT | WAIT",
  "target": "valid selector (required except NAVIGATE and WAIT)",
  "value": "url | text | input value | wait time (seconds)"
}

-------------------------
ACTION RULES
-------------------------

1. NAVIGATE
   - Only needs "value" (URL)
   - Do not include target

2. WAIT
   - value must be number of seconds as string (e.g. "3")
   - Use WAIT after navigation or before assertion when UI loads

3. TYPE
   - target must be input selector
   - value is the text to type

4. CLICK
   - target must be button/link selector

5. ASSERT_TEXT
   - DO NOT put text inside target
   - target must be a valid selector (like h1, .title, #loginBtn)
   - value must be the expected visible text

   ✅ Correct:
   { "action": "ASSERT_TEXT", "target": "h1", "value": "Welcome Back" }

   ❌ Wrong:
   { "action": "ASSERT_TEXT", "target": "Welcome Back" }

-------------------------
TEXT MATCHING RULE
-------------------------
When asserting visible text:
- Use simple selectors like:
  h1, h2, .title, .header, button, span, etc.
- Put the visible text in "value"
- Ensure text exactly matches UI (case sensitive)

-------------------------
SALESFORCE SPECIFIC RULES
-------------------------
If the URL contains "salesforce.com" OR is a Salesforce org login page:

Automatically generate steps for Salesforce login flow:

1. NAVIGATE to login page
2. TYPE username into "#username"
3. TYPE password into "#password"
4. CLICK "#Login"
5. WAIT "5"
6. ASSERT_TEXT on ".slds-global-header" or ".oneAppNavContainer"

-------------------------
OUTPUT FORMAT
-------------------------
Return JSON in this structure:

{
  "name": "Concise Test Case Name",
  "description": "Detailed description of what is being tested",
  "priority": "low" | "medium" | "high",
  "preconditions": ["List of preconditions"],
  "steps": [
    {
      "id": "1",
      "action": "NAVIGATE",
      "value": "https://example.com"
    }
  ],
  "expected_outcome": "Clear expected final result"
}

-------------------------
QUALITY REQUIREMENTS
-------------------------
- Steps must execute successfully in Playwright without syntax errors
- No invalid selectors
- No malformed quotes
- No empty targets
- No text inside selector
- Always ensure the final ASSERT_TEXT validates successful page load

Generate test steps that will PASS successfully in Playwright runner.
"""

RAG_SYSTEM_PROMPT = """
You are an expert QA Automation Engineer specialized in Salesforce testing with Playwright.

Your task is to convert a natural language test case into a structured Playwright-compatible JSON test definition, using REAL Salesforce org metadata provided below.

IMPORTANT CONTEXT:
- You are given actual metadata from the user's Salesforce org (objects, fields, flows, validation rules, LWC components).
- Use the REAL field API names, object names, and flow names from the metadata.
- The application base URL is managed separately in the Project configuration.
- For NAVIGATE steps, use relative paths like "/lightning/o/ObjectName/list" or "/lightning/r/ObjectId/view"

-------------------------
METADATA CONTEXT
-------------------------
{rag_context}

-------------------------
GENERAL RULES
-------------------------
1. Output ONLY valid JSON (no explanations, no comments).
2. Use the ACTUAL Salesforce field API names from the metadata context above.
3. Generate selectors that work with Salesforce Lightning UI:
   - Use data-field-id, data-target-selection-name for fields
   - Use .slds-* classes for SLDS components
   - Use [title="FieldLabel"] or text-based selectors for buttons
   - Use role-based selectors: [role="option"], [role="combobox"], etc.
4. Include WAIT steps after navigation and before assertions (Salesforce UI is heavy).
5. If validation rules exist in the metadata, include NEGATIVE test steps that trigger them.
6. If required fields exist, include steps that verify they cannot be left empty.
7. If flows exist in the metadata, include steps to trigger and verify the flow.

-------------------------
SUPPORTED ACTIONS
-------------------------
- NAVIGATE
- CLICK
- TYPE
- ASSERT_TEXT
- WAIT

-------------------------
STEP FORMAT
-------------------------
Each step must follow this structure:
{
  "id": "1",
  "action": "NAVIGATE | CLICK | TYPE | ASSERT_TEXT | WAIT",
  "target": "valid selector (required except NAVIGATE and WAIT)",
  "value": "url | text | input value | wait time (seconds)"
}

-------------------------
SALESFORCE-SPECIFIC PATTERNS
-------------------------
1. Record Creation:
   - Navigate to object list view
   - Click "New" button
   - Fill in required fields (use metadata field names)
   - Click "Save"
   - Assert success message

2. Validation Rule Testing:
   - Enter values that violate the rule
   - Click "Save"
   - Assert error message matches the rule's error message

3. Flow Testing:
   - Navigate to the record
   - Trigger the flow action
   - Complete flow steps
   - Verify outcome

4. LWC Testing:
   - Navigate to page containing the component
   - Interact with component elements
   - Verify component renders correctly

-------------------------
OUTPUT FORMAT
-------------------------
Return JSON in this structure:

{
  "name": "Concise Test Case Name",
  "description": "Detailed description of what is being tested",
  "priority": "low" | "medium" | "high",
  "preconditions": ["List of preconditions"],
  "steps": [
    {
      "id": "1",
      "action": "NAVIGATE",
      "value": "/lightning/o/Account/list"
    }
  ],
  "expected_outcome": "Clear expected final result"
}

Generate test steps that use REAL metadata from the context above.
"""


# ─── Provider-specific LLM callers ─────────────────────────────────

async def _call_openai(system_prompt: str, user_prompt: str, model: Optional[str] = None) -> Dict[str, Any]:
    """Call OpenAI API and return parsed JSON response."""
    if not settings.OPENAI_API_KEY:
        raise Exception("OPENAI_API_KEY is not set")

    client = AsyncOpenAI(api_key=settings.OPENAI_API_KEY)
    model_name = model or MODEL_PROVIDERS["openai"]["default_model"]

    response = await client.chat.completions.create(
        model=model_name,
        messages=[
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ],
        response_format={"type": "json_object"},
        temperature=0.7,
    )

    content = response.choices[0].message.content
    if not content:
        raise Exception("Empty response from OpenAI")
    return json.loads(content)


async def _call_claude(system_prompt: str, user_prompt: str, model: Optional[str] = None) -> Dict[str, Any]:
    """Call Anthropic Claude API and return parsed JSON response."""
    if not settings.ANTHROPIC_API_KEY:
        raise Exception("ANTHROPIC_API_KEY is not set. Please add it to your .env file.")

    try:
        import anthropic
    except ImportError:
        raise Exception("anthropic package not installed. Run: pip install anthropic")

    client = anthropic.AsyncAnthropic(api_key=settings.ANTHROPIC_API_KEY)
    model_name = model or MODEL_PROVIDERS["claude"]["default_model"]

    response = await client.messages.create(
        model=model_name,
        max_tokens=4096,
        system=system_prompt,
        messages=[
            {"role": "user", "content": user_prompt + "\n\nIMPORTANT: Respond with ONLY valid JSON. No explanations or markdown."},
        ],
        temperature=0.7,
    )

    content = response.content[0].text
    if not content:
        raise Exception("Empty response from Claude")

    # Claude may sometimes wrap JSON in ```json blocks — strip them
    cleaned = content.strip()
    if cleaned.startswith("```"):
        # Remove opening ```json and closing ```
        lines = cleaned.split("\n")
        lines = [l for l in lines if not l.strip().startswith("```")]
        cleaned = "\n".join(lines)

    return json.loads(cleaned)


async def _call_llm(
    system_prompt: str,
    user_prompt: str,
    provider: str = "openai",
    model: Optional[str] = None,
) -> Dict[str, Any]:
    """Route to the correct LLM provider."""
    provider = provider.lower().strip()

    if provider == "openai":
        return await _call_openai(system_prompt, user_prompt, model)
    elif provider == "claude":
        return await _call_claude(system_prompt, user_prompt, model)
    else:
        raise ValueError(f"Unsupported model provider: '{provider}'. Use 'openai' or 'claude'.")


# ─── AIService (public interface) ──────────────────────────────────

class AIService:
    @staticmethod
    async def generate_test_case(
        prompt: str,
        provider: str = "openai",
        model: Optional[str] = None,
    ) -> Dict[str, Any]:
        """
        Generates a detailed test case structure from a natural language prompt.
        Supports both OpenAI and Claude providers.

        Args:
            prompt: Natural language test case description
            provider: "openai" (default) or "claude"
            model: Specific model name (optional, uses provider default)
        """
        try:
            return await _call_llm(STANDARD_SYSTEM_PROMPT, prompt, provider, model)
        except Exception as e:
            print(f"[{provider}] generation error: {str(e)}")
            raise e

    @staticmethod
    async def generate_test_case_with_rag(
        prompt: str,
        rag_context: str,
        provider: str = "openai",
        model: Optional[str] = None,
    ) -> Dict[str, Any]:
        """
        Generates test case steps using RAG-retrieved Salesforce metadata context.
        Supports both OpenAI and Claude providers.

        Args:
            prompt: Natural language test case description
            rag_context: RAG-retrieved metadata context string
            provider: "openai" (default) or "claude"
            model: Specific model name (optional, uses provider default)
        """
        system_prompt = RAG_SYSTEM_PROMPT.replace("{rag_context}", rag_context)

        try:
            return await _call_llm(system_prompt, prompt, provider, model)
        except Exception as e:
            print(f"[{provider}] RAG generation error: {str(e)}")
            raise e
