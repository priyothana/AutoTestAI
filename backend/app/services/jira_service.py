"""
Jira Cloud REST API Service
Handles authentication, board retrieval, and issue fetching via Jira Cloud REST API.
Uses Basic Auth (email:api_token) — credentials are passed per-request, not stored.
"""
import httpx
import base64
from typing import List, Dict, Any, Optional


API_TIMEOUT = 15.0  # seconds


def _build_auth_header(email: str, api_token: str) -> Dict[str, str]:
    """Build Basic Auth header for Jira Cloud API."""
    credentials = base64.b64encode(f"{email}:{api_token}".encode()).decode()
    return {
        "Authorization": f"Basic {credentials}",
        "Accept": "application/json",
        "Content-Type": "application/json",
    }


def _normalize_domain(domain: str) -> str:
    """Ensure domain is a proper Jira Cloud URL without trailing slash."""
    domain = domain.strip()
    if not domain.startswith("http"):
        domain = f"https://{domain}"
    # Remove any path after the domain (e.g. /o/12345...)
    from urllib.parse import urlparse
    parsed = urlparse(domain)
    base = f"{parsed.scheme}://{parsed.netloc}"
    return base.rstrip("/")


def _validate_domain(domain: str) -> str:
    """Validate the Jira domain and return the normalized URL."""
    normalized = _normalize_domain(domain)

    # Check for common mistakes
    from urllib.parse import urlparse
    parsed = urlparse(normalized)
    hostname = parsed.hostname or ""

    # home.atlassian.com is the org admin page, not a Jira instance
    if "home.atlassian.com" in hostname:
        raise ValueError(
            "You entered the Atlassian organization URL. "
            "Please use your Jira site URL instead, e.g. https://yoursite.atlassian.net"
        )

    # id.atlassian.com is the login page
    if "id.atlassian.com" in hostname:
        raise ValueError(
            "You entered the Atlassian login URL. "
            "Please use your Jira site URL, e.g. https://yoursite.atlassian.net"
        )

    # Must contain atlassian.net for cloud, or be a custom domain
    # Just warn if it looks suspicious but don't block
    return normalized


async def connect(domain: str, email: str, api_token: str) -> Dict[str, Any]:
    """
    Validate Jira credentials by calling /rest/api/3/myself.
    Returns user info on success, raises on failure.
    """
    base_url = _validate_domain(domain)
    headers = _build_auth_header(email, api_token)

    try:
        async with httpx.AsyncClient(timeout=API_TIMEOUT) as client:
            response = await client.get(
                f"{base_url}/rest/api/3/myself",
                headers=headers,
            )
    except httpx.ConnectError:
        raise ValueError(
            f"Cannot connect to {base_url}. Please check the domain is correct, "
            "e.g. https://yoursite.atlassian.net"
        )
    except httpx.TimeoutException:
        raise ValueError(
            f"Connection to {base_url} timed out. Please verify the domain and try again."
        )

    if response.status_code == 401:
        raise ValueError("Invalid Jira credentials. Please check your email and API token.")
    if response.status_code == 403:
        raise ValueError("Access denied. Please verify your Jira permissions.")
    if response.status_code >= 400:
        raise ValueError(f"Jira API error ({response.status_code}): {response.text[:200]}")

    # Validate we got JSON back (not an HTML page from wrong domain)
    content_type = response.headers.get("content-type", "")
    if "application/json" not in content_type:
        raise ValueError(
            f"Unexpected response from {base_url}. "
            "Please ensure this is your Jira Cloud URL (e.g. https://yoursite.atlassian.net)"
        )

    data = response.json()
    return {
        "display_name": data.get("displayName", ""),
        "email": data.get("emailAddress", email),
        "account_id": data.get("accountId", ""),
    }


async def get_boards(
    domain: str, email: str, api_token: str, max_results: int = 50
) -> List[Dict[str, Any]]:
    """
    Fetch Jira boards via the Agile API.
    Returns list of {id, name, type}.
    """
    base_url = _validate_domain(domain)
    headers = _build_auth_header(email, api_token)

    boards = []
    start_at = 0

    try:
        async with httpx.AsyncClient(timeout=API_TIMEOUT) as client:
            # Fetch up to max_results boards (with pagination)
            while len(boards) < max_results:
                response = await client.get(
                    f"{base_url}/rest/agile/1.0/board",
                    headers=headers,
                    params={
                        "startAt": start_at,
                        "maxResults": min(50, max_results - len(boards)),
                    },
                )

                if response.status_code == 401:
                    raise ValueError("Invalid Jira credentials.")
                if response.status_code >= 400:
                    raise ValueError(
                        f"Failed to fetch boards ({response.status_code}): {response.text[:200]}"
                    )

                data = response.json()
                values = data.get("values", [])
                if not values:
                    break

                for board in values:
                    boards.append({
                        "id": str(board.get("id", "")),
                        "name": board.get("name", "Unnamed Board"),
                        "type": board.get("type", ""),
                    })

                # Check if there are more pages
                if data.get("isLast", True):
                    break
                start_at += len(values)
    except httpx.ConnectError:
        raise ValueError(f"Cannot connect to {base_url}. Check the domain.")
    except httpx.TimeoutException:
        raise ValueError(f"Connection to {base_url} timed out.")

    return boards


async def get_board_issues(
    domain: str,
    email: str,
    api_token: str,
    board_id: str,
    max_results: int = 50,
) -> List[Dict[str, Any]]:
    """
    Fetch user stories (issue type = Story) from a specific board.
    Returns list of {key, summary, description}.
    """
    base_url = _validate_domain(domain)
    headers = _build_auth_header(email, api_token)

    try:
        async with httpx.AsyncClient(timeout=API_TIMEOUT) as client:
            response = await client.get(
                f"{base_url}/rest/agile/1.0/board/{board_id}/issue",
                headers=headers,
                params={
                    "maxResults": max_results,
                    "fields": "summary,description,issuetype,status",
                },
            )
    except httpx.ConnectError:
        raise ValueError(f"Cannot connect to {base_url}. Check the domain.")
    except httpx.TimeoutException:
        raise ValueError(f"Connection to {base_url} timed out.")

    if response.status_code == 401:
        raise ValueError("Invalid Jira credentials.")
    if response.status_code == 404:
        raise ValueError(f"Board with ID '{board_id}' not found.")
    if response.status_code >= 400:
        raise ValueError(
            f"Failed to fetch issues ({response.status_code}): {response.text[:200]}"
        )

    data = response.json()
    issues = []

    for issue in data.get("issues", []):
        fields = issue.get("fields", {})
        # Extract plain-text description from ADF (Atlassian Document Format)
        description = ""
        desc_field = fields.get("description")
        if isinstance(desc_field, str):
            description = desc_field
        elif isinstance(desc_field, dict):
            # ADF format — extract text content recursively
            description = _extract_adf_text(desc_field)

        issues.append({
            "key": issue.get("key", ""),
            "summary": fields.get("summary", ""),
            "description": description,
        })

    return issues


def _extract_adf_text(node: dict) -> str:
    """Recursively extract plain text from Atlassian Document Format (ADF)."""
    if not isinstance(node, dict):
        return ""

    text_parts = []

    if node.get("type") == "text":
        text_parts.append(node.get("text", ""))

    for child in node.get("content", []):
        text_parts.append(_extract_adf_text(child))

    return " ".join(part for part in text_parts if part).strip()
