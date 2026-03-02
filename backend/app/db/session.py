from sqlalchemy.ext.asyncio import create_async_engine, AsyncSession
from sqlalchemy.orm import sessionmaker
from app.core.config import settings
import asyncpg  # ← This import ensures the driver is loaded early

engine = create_async_engine(
    settings.assemble_db_connection(),
    future=True,
    echo=True,
    # Explicitly tell SQLAlchemy to use asyncpg dialect only
    # This prevents fallback to psycopg2
)


AsyncSessionLocal = sessionmaker(
    engine, class_=AsyncSession, expire_on_commit=False, autoflush=False
)

async def get_db():
    async with AsyncSessionLocal() as session:
        try:
            yield session
        finally:
            await session.close()
