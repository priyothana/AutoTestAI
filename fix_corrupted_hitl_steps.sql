-- ============================================================
-- fix_corrupted_hitl_steps.sql
-- 
-- Repairs test case steps where a HITL "Apply & Resume" option
-- text was incorrectly stored as a NAVIGATE target URL.
--
-- Root cause: the frontend bug used raw option strings (e.g.,
-- "Insert CLICK '+ Add Account' only") as page.goto() URLs.
-- These strings were persisted to the DB via step_override or
-- insert_step when the user clicked "Apply & Resume".
--
-- Run this against your PostgreSQL DB:
--   psql -U postgres -d autotestdb -f fix_corrupted_hitl_steps.sql
-- ============================================================

-- 1. Find all test cases with corrupted NAVIGATE steps
-- (steps where action=NAVIGATE but target does not start with / or http)
SELECT
    id,
    name,
    steps::text
FROM test_cases
WHERE
    steps::text ILIKE '%"action":"NAVIGATE"%'
    AND steps::text NOT LIKE '%"target":"/%'
    AND steps::text NOT LIKE '%"target":"http%'
    AND steps::text LIKE '%"target":"%'
LIMIT 20;

-- 2. Specific fix: remove steps whose target looks like an option/instruction text
-- (contains spaces and is longer than a URL path would be)
-- CAUTION: review the SELECT above first before running the UPDATE.

-- Example manual fix for a specific test case (replace UUID with real ID):
-- UPDATE test_cases
-- SET steps = (
--     SELECT jsonb_agg(step)
--     FROM jsonb_array_elements(steps) AS step
--     WHERE NOT (
--         step->>'action' = 'NAVIGATE'
--         AND length(step->>'target') > 30
--         AND step->>'target' NOT LIKE '/%'
--         AND step->>'target' NOT LIKE 'http%'
--     )
-- )
-- WHERE id = '<your-test-case-id-here>';

-- 3. Bulk repair: fix all corrupted NAVIGATE steps by replacing
--    invalid targets with '' (empty = uses baseUrl) 
--    so the execution doesn't crash on page.goto()
UPDATE test_cases
SET steps = (
    SELECT jsonb_agg(
        CASE
            WHEN step->>'action' = 'NAVIGATE'
                AND length(step->>'target') > 30
                AND step->>'target' NOT LIKE '/%'
                AND step->>'target' NOT LIKE 'http%'
            THEN jsonb_set(step, '{target}', '""')
            ELSE step
        END
    )
    FROM jsonb_array_elements(steps) AS step
)
WHERE
    steps::text ILIKE '%"action":"NAVIGATE"%'
    AND steps::text NOT LIKE '%"target":"/%'
    AND steps::text LIKE '%"target":"%';

SELECT 'Repair complete. Corrupted NAVIGATE targets replaced with empty string.' AS result;
