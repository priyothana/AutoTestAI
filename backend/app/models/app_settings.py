from sqlalchemy import Column, Integer, String, Boolean, JSON, Float
from app.db.base import Base

class AppSettings(Base):
    __tablename__ = "app_settings"

    id = Column(Integer, primary_key=True, index=True)
    
    # General Settings
    default_timeout = Column(Integer, default=30000)
    parallel_execution = Column(Boolean, default=False)
    retry_count = Column(Integer, default=0)
    screenshot_mode = Column(String, default="on-failure")
    use_session_reuse = Column(Boolean, default=True)
    
    # Environment Settings
    base_url = Column(String, nullable=True)
    browser = Column(String, default="chromium")
    device = Column(String, default="desktop")
    variables = Column(JSON, default={})
    
    # Integrations
    slack_webhook = Column(String, nullable=True)
    email_notifications = Column(Boolean, default=False)
    webhook_callback = Column(String, nullable=True)
