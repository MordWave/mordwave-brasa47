-- READ-ONLY snapshot to run before and after each level (psql -X -f). No secrets involved.
select 'version' as k, version() as v;
select 'max_connections' as k, setting as v from pg_settings where name = 'max_connections';
select 'shared_buffers' as k, setting || ' x ' || unit as v from pg_settings where name = 'shared_buffers';
select 'statement_timeout' as k, setting as v from pg_settings where name = 'statement_timeout';
select 'connections' as k, state as v, count(*) as n from pg_stat_activity where datname = current_database() group by state;
select 'cache_hit_ratio' as k,
       round(100.0 * blks_hit / nullif(blks_hit + blks_read, 0), 2) as v
  from pg_stat_database where datname = current_database();
select 'db' as k, xact_commit, xact_rollback, deadlocks, temp_files, conflicts from pg_stat_database where datname = current_database();
select 'table_sizes_mb' as k, relname, round(pg_total_relation_size(relid) / 1048576.0, 2) as mb
  from pg_stat_user_tables order by pg_total_relation_size(relid) desc limit 8;
select 'row_counts' as k,
       (select count(*) from orders) as orders, (select count(*) from order_items) as order_items,
       (select count(*) from audit_logs) as audit_logs, (select count(*) from table_sessions) as sessions;
select 'blocked_now' as k, count(*) as n from pg_stat_activity where wait_event_type = 'Lock';
select 'pg_stat_statements' as k, coalesce(to_regclass('pg_stat_statements')::text, 'not installed') as v;
select 'wal_dir' as k, count(*) as files, round(sum(size) / 1048576.0, 1) as mb from pg_ls_waldir();
select 'wal_settings' as k, name, setting || coalesce(unit, '') as v from pg_settings
 where name in ('min_wal_size', 'max_wal_size', 'wal_keep_size', 'checkpoint_timeout', 'wal_level', 'archive_mode', 'fsync', 'synchronous_commit');
select 'checkpointer' as k, num_timed, num_requested, write_time, sync_time, buffers_written from pg_stat_checkpointer;
select 'all_databases_mb' as k, round(sum(pg_database_size(datname)) / 1048576.0, 1) as mb from pg_database;
