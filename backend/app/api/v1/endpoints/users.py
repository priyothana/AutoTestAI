from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.future import select
import bcrypt
from app.db.session import get_db
from app.models.user import User
from app.schemas.user import UserCreate, UserResponse, UserLogin
import logging

router = APIRouter()
logger = logging.getLogger(__name__)

def verify_password(plain_password: str, hashed_password: str):
    return bcrypt.checkpw(plain_password.encode('utf-8'), hashed_password.encode('utf-8'))

def get_password_hash(password: str):
    salt = bcrypt.gensalt()
    return bcrypt.hashpw(password.encode('utf-8'), salt).decode('utf-8')

@router.post("/signup", response_model=UserResponse)
async def create_user(user: UserCreate, db: AsyncSession = Depends(get_db)):
    print(f"[AUTH] Signup triggered for username: {user.username}, email: {user.email}")
    
    # Check existing email
    result = await db.execute(select(User).where(User.email == user.email))
    existing_user_email = result.scalars().first()
    if existing_user_email:
        print(f"[AUTH] Signup failed: Email {user.email} already exists")
        raise HTTPException(status_code=400, detail="Email already registered")
        
    # Check existing username
    result = await db.execute(select(User).where(User.username == user.username))
    existing_user_username = result.scalars().first()
    if existing_user_username:
        print(f"[AUTH] Signup failed: Username {user.username} already exists")
        raise HTTPException(status_code=400, detail="Username already taken")
        
    hashed_password = get_password_hash(user.password)
    
    new_user = User(
        username=user.username,
        email=user.email,
        hashed_password=hashed_password,
        full_name=user.full_name,
        role="tester",
        is_active=True
    )
    db.add(new_user)
    await db.commit()
    await db.refresh(new_user)
    
    print(f"[AUTH] User successfully inserted into DB with ID: {new_user.id}")
    return new_user

@router.post("/login")
async def login(user_in: UserLogin, db: AsyncSession = Depends(get_db)):
    print(f"[AUTH] Login attempt for username: {user_in.username}")
    
    result = await db.execute(select(User).where(User.username == user_in.username))
    user = result.scalars().first()
    
    if not user:
        print(f"[AUTH] Login failed: Username {user_in.username} not found")
        raise HTTPException(status_code=400, detail="Incorrect username or password")
        
    if not verify_password(user_in.password, user.hashed_password):
        print(f"[AUTH] Login failed: Invalid password for {user_in.username}")
        raise HTTPException(status_code=400, detail="Incorrect username or password")
         
    print(f"[AUTH] Login successful for username: {user_in.username} (ID: {user.id})")
    return {"access_token": "fake-jwt-token-for-demo", "token_type": "bearer"}
