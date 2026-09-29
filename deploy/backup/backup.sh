#!/bin/sh
# Nightly backups for a Viewpoint Arena install (batch BY).
#
# Runs as the `db-backup` service in docker-compose.yml, on the same postgres image
# as `db` so pg_dumpall matches the server. Every BACKUP_INTERVAL_HOURS (default 24,
# and once at start) it writes
#   /backups/db-YYYYMMDD-HHMMSS.sql.gz        the whole database (pg_dumpall)
#   /backups/models-YYYYMMDD-HHMMSS.tar.gz    the imported model files, if BACKUP_MODELS=true
# to a temporary name first and renames it when complete, so a half-written file is
# never mistaken for a backup, and keeps the newest BACKUP_KEEP (default 14) of each.
#
# Why this exists: on 2026-09-26 a maintainer's own install lost reviews and meetings
# and there was nothing to restore from. A self-hosted product has to back itself up.
#
# The password comes from PGPASSWORD in the environment and is never printed.

set -u

BACKUP_DIR="${BACKUP_DIR:-/backups}"
INTERVAL_HOURS="${BACKUP_INTERVAL_HOURS:-24}"
KEEP="${BACKUP_KEEP:-14}"
MODELS="${BACKUP_MODELS:-true}"
MODELS_DIR="${BACKUP_MODELS_DIR:-/models}"
PGHOST="${PGHOST:-db}"
PGUSER="${PGUSER:-supabase_admin}"
export PGHOST PGUSER

# Keep only the newest $KEEP files matching a prefix. Names sort by time.
prune() {
  prefix="$1"
  # shellcheck disable=SC2012
  ls -1 "$BACKUP_DIR" 2>/dev/null | grep -E "^${prefix}-[0-9]{8}-[0-9]{6}\.(sql|tar)\.gz$" | sort -r \
    | tail -n "+$((KEEP + 1))" | while read -r old; do rm -f "$BACKUP_DIR/$old"; done
}

run_once() {
  stamp="$(date -u +%Y%m%d-%H%M%S)"
  mkdir -p "$BACKUP_DIR"

  db_file="$BACKUP_DIR/db-$stamp.sql.gz"
  # POSIX sh has no pipefail, so the dump's own exit status is written to a file.
  { pg_dumpall --clean --if-exists 2>/tmp/backup.err; echo $? > /tmp/backup.rc; } | gzip > "$db_file.tmp"
  if [ "$(cat /tmp/backup.rc 2>/dev/null)" = "0" ] && [ -s "$db_file.tmp" ]; then
    mv "$db_file.tmp" "$db_file"
    echo "backup ok: $(basename "$db_file") $(du -h "$db_file" | cut -f1)"
  else
    rm -f "$db_file.tmp"
    echo "backup FAILED: database dump did not complete ($(head -c 200 /tmp/backup.err | tr '\n' ' '))"
  fi

  if [ "$MODELS" = "true" ] && [ -d "$MODELS_DIR" ]; then
    models_file="$BACKUP_DIR/models-$stamp.tar.gz"
    if tar -czf "$models_file.tmp" -C "$MODELS_DIR" . 2>/dev/null; then
      mv "$models_file.tmp" "$models_file"
      echo "backup ok: $(basename "$models_file") $(du -h "$models_file" | cut -f1)"
    else
      rm -f "$models_file.tmp"
      echo "backup FAILED: model files could not be archived"
    fi
  fi

  prune db
  prune models
}

# One run and exit, for a test or an operator: `backup.sh once`.
if [ "${1:-}" = "once" ]; then
  run_once
  exit 0
fi

while true; do
  run_once
  sleep "$((INTERVAL_HOURS * 3600))"
done
