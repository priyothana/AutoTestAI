"""add execution learning and rag enhancements

Revision ID: d7e8f9a0b1c2
Revises: c6d8e9f0a1b2
Create Date: 2026-03-16 15:45:00.000000

"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

# revision identifiers, used by Alembic.
revision = 'd7e8f9a0b1c2'
down_revision = 'c6d8e9f0a1b2'
branch_labels = None
depends_on = None


def upgrade() -> None:
    # --- Create execution_learnings table ---
    op.create_table(
        'execution_learnings',
        sa.Column('id', postgresql.UUID(as_uuid=True), primary_key=True, index=True),
        sa.Column('project_id', postgresql.UUID(as_uuid=True), sa.ForeignKey('projects.id'), nullable=False),
        sa.Column('test_case_id', postgresql.UUID(as_uuid=True), sa.ForeignKey('test_cases.id'), nullable=True),
        sa.Column('test_run_id', postgresql.UUID(as_uuid=True), sa.ForeignKey('test_runs.id'), nullable=True),
        sa.Column('learning_type', sa.String(), nullable=False),
        sa.Column('object_name', sa.String(), nullable=True),
        sa.Column('field_name', sa.String(), nullable=True),
        sa.Column('field_type', sa.String(), nullable=True),
        sa.Column('action_attempted', sa.String(), nullable=True),
        sa.Column('correct_action', sa.String(), nullable=True),
        sa.Column('failure_reason', sa.Text(), nullable=True),
        sa.Column('steps_pattern', postgresql.JSONB(), nullable=True),
        sa.Column('extra_metadata', postgresql.JSONB(), nullable=True),
        sa.Column('created_at', sa.DateTime(), nullable=False),
    )

    # --- Add chunk_type to vector_embeddings ---
    op.add_column(
        'vector_embeddings',
        sa.Column('chunk_type', sa.String(), server_default='metadata', nullable=False),
    )

    # --- Add chunk_sources to rag_query_logs ---
    op.add_column(
        'rag_query_logs',
        sa.Column('chunk_sources', postgresql.JSONB(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column('rag_query_logs', 'chunk_sources')
    op.drop_column('vector_embeddings', 'chunk_type')
    op.drop_table('execution_learnings')
