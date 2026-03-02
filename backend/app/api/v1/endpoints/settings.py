from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.future import select
from app.db.session import get_db
from app.models.app_settings import AppSettings
from app.schemas.app_settings import AppSettingsUpdate, AppSettingsResponse

router = APIRouter()

@router.get("/", response_model=AppSettingsResponse)
async def get_settings(db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(AppSettings).limit(1))
    settings = result.scalars().first()
    
    if not settings:
        # Create default settings if not exists
        settings = AppSettings()
        db.add(settings)
        await db.commit()
        await db.refresh(settings)
    
    return settings

@router.post("/", response_model=AppSettingsResponse)
async def update_settings(settings_data: AppSettingsUpdate, db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(AppSettings).limit(1))
    settings = result.scalars().first()
    
    if not settings:
        settings = AppSettings()
        db.add(settings)
    
    # Update fields
    for field, value in settings_data.model_dump().items():
        setattr(settings, field, value)
        
    await db.commit()
    await db.refresh(settings)
    return settings
