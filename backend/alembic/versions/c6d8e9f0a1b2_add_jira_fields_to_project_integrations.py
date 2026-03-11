"""Add Jira integration fields to project_integrations

Revision ID: c6d8e9f0a1b2
Revises: b5e7f8a9c0d1
Create Date: 2026-03-10 12:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'c6d8e9f0a1b2'
down_revision: Union[str, None] = 'b5e7f8a9c0d1'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column('project_integrations', sa.Column('jira_domain', sa.Text(), nullable=True))
    op.add_column('project_integrations', sa.Column('jira_email', sa.Text(), nullable=True))
    op.add_column('project_integrations', sa.Column('jira_token', sa.Text(), nullable=True))
    op.add_column('project_integrations', sa.Column('jira_board_id', sa.String(50), nullable=True))
    op.add_column('project_integrations', sa.Column('jira_board_name', sa.Text(), nullable=True))


def downgrade() -> None:
    op.drop_column('project_integrations', 'jira_board_name')
    op.drop_column('project_integrations', 'jira_board_id')
    op.drop_column('project_integrations', 'jira_token')
    op.drop_column('project_integrations', 'jira_email')
    op.drop_column('project_integrations', 'jira_domain')
