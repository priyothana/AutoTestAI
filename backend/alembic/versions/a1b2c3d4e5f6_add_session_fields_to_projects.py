"""add session fields to projects

Revision ID: a1b2c3d4e5f6
Revises: dd3a5323ee4a
Create Date: 2026-03-03 16:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'a1b2c3d4e5f6'
down_revision: Union[str, None] = '6bbfdf4dd676'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column('projects', sa.Column('ui_session_active', sa.Boolean(), nullable=True, server_default='false'))
    op.add_column('projects', sa.Column('ui_session_last_created_at', sa.DateTime(), nullable=True))
    op.add_column('projects', sa.Column('ui_session_source', sa.String(length=20), nullable=True))


def downgrade() -> None:
    op.drop_column('projects', 'ui_session_source')
    op.drop_column('projects', 'ui_session_last_created_at')
    op.drop_column('projects', 'ui_session_active')
