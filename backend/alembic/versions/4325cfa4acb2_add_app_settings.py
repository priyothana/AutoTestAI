from alembic import op
import sqlalchemy as sa

revision = '4325cfa4acb2'
down_revision = '32acecc08c8b'
branch_labels = None
depends_on = None

def upgrade():
    op.create_table(
        'app_settings',
        sa.Column('id', sa.Integer(), primary_key=True),
        sa.Column('default_timeout', sa.Integer(), server_default='30000'),
        sa.Column('parallel_execution', sa.Boolean(), server_default='false'),
        sa.Column('retry_count', sa.Integer(), server_default='0'),
        sa.Column('screenshot_mode', sa.String(), server_default='on-failure'),
        sa.Column('base_url', sa.String(), nullable=True),
        sa.Column('browser', sa.String(), server_default='chromium'),
        sa.Column('device', sa.String(), server_default='desktop'),
        sa.Column('variables', sa.JSON(), server_default='{}'),
        sa.Column('slack_webhook', sa.String(), nullable=True),
        sa.Column('email_notifications', sa.Boolean(), server_default='false'),
        sa.Column('webhook_callback', sa.String(), nullable=True),
    )

def downgrade():
    op.drop_table('app_settings')
