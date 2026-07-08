-- Alter default value for column role in users table
ALTER TABLE users ALTER COLUMN role SET DEFAULT 'USER';

-- Update existing users to use the new 'USER' role instead of 'tester'
UPDATE users SET role = 'USER' WHERE role = 'tester';
