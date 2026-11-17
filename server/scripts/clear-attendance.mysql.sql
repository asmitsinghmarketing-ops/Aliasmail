-- Clear all AliasMail attendance history and active clock-ins.
-- Stop the AliasMail server first, run this single statement, then restart it.
-- Attendance is JSON in app_state; all other application data is left unchanged.

UPDATE app_state
SET v = '{"sessions":[]}'
WHERE k = 'attendance';
