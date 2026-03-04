"""add mcp fields to project_integrations

Revision ID: b5e7f8a9c0d1
Revises: a1b2c3d4e5f6
Create Date: 2026-03-04 11:25:00.000000

"""
from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision = 'b5e7f8a9c0d1'
down_revision = 'a1b2c3d4e5f6'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column('project_integrations', sa.Column('security_token', sa.Text(), nullable=True))
    op.add_column('project_integrations', sa.Column('mcp_connected', sa.Boolean(), server_default='false', nullable=True))


def downgrade() -> None:
    op.drop_column('project_integrations', 'mcp_connected')
    op.drop_column('project_integrations', 'security_token')
