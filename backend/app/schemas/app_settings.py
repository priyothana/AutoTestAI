from pydantic import BaseModel
from typing import Optional, Dict, Any

class AppSettingsBase(BaseModel):
    default_timeout: int = 30000
    parallel_execution: bool = False
    retry_count: int = 0
    screenshot_mode: str = "on-failure" # always, on-failure, never
    
    # Environment Default
    base_url: Optional[str] = None
    browser: str = "chromium"
    device: str = "desktop"
    variables: Dict[str, Any] = {}
    
    # Integrations
    slack_webhook: Optional[str] = None
    email_notifications: bool = False
    webhook_callback: Optional[str] = None

class AppSettingsUpdate(AppSettingsBase):
    pass

class AppSettingsResponse(AppSettingsBase):
    id: int

    class Config:
        from_attributes = True
