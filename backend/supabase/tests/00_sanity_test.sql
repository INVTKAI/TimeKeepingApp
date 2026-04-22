-- Sanity: core tables exist. If this fails, the migrations didn't apply.
BEGIN;
SELECT plan(4);

SELECT has_table('public', 'tenants',             'tenants table exists');
SELECT has_table('public', 'users',               'public.users table exists');
SELECT has_table('public', 'audit_events',        'audit_events table exists');
SELECT has_table('public', 'login_failure_counters', 'login_failure_counters table exists');

SELECT * FROM finish();
ROLLBACK;
