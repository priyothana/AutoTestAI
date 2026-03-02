"""Add use_session_reuse to app_settings

Revision ID: 6bbfdf4dd676
Revises: dd3a5323ee4a
Create Date: 2026-02-26 16:07:35.600769

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '6bbfdf4dd676'
down_revision: Union[str, None] = 'dd3a5323ee4a'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column('app_settings', sa.Column('use_session_reuse', sa.Boolean(), server_default='true', nullable=True))


def downgrade() -> None:
    op.drop_column('app_settings', 'use_session_reuse')
