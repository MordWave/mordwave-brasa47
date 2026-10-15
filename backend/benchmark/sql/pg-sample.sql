-- One CSV line per call (psql -At -F,). READ-ONLY.
select now()::timestamptz(0) as ts,
  count(*) as total,
  count(*) filter (where state = 'active') as active,
  count(*) filter (where state = 'idle') as idle,
  count(*) filter (where state like 'idle in transaction%') as idle_in_tx,
  count(*) filter (where wait_event_type = 'Lock') as waiting_lock,
  (select setting::int from pg_settings where name = 'max_connections') as max_conn,
  (select xact_commit from pg_stat_database where datname = current_database()) as xact_commit,
  (select xact_rollback from pg_stat_database where datname = current_database()) as xact_rollback,
  (select blks_hit from pg_stat_database where datname = current_database()) as blks_hit,
  (select blks_read from pg_stat_database where datname = current_database()) as blks_read,
  (select deadlocks from pg_stat_database where datname = current_database()) as deadlocks,
  (select round(pg_database_size(current_database()) / 1048576.0, 1)) as db_mb
from pg_stat_activity
where datname = current_database() and backend_type = 'client backend' and pid <> pg_backend_pid();
