#!/bin/sh
# Restore a Viewpoint Arena backup (batch BY). Run from the install folder:
#
#   deploy/backup/restore.sh db-20260926-020000.sql.gz --yes
#
# The file is looked up in the db-backups volume. This REPLACES the current database
# with the backup's, so it refuses to run without --yes. The services that talk to the
# database are stopped while it restores and started again afterwards. Model files are
# not touched; restore those with:
#   docker compose run --rm -v "$PWD":/out db-backup tar -xzf /backups/models-<stamp>.tar.gz -C /models
set -eu

file="${1:-}"
confirm="${2:-}"
if [ -z "$file" ] || [ "$confirm" != "--yes" ]; then
  echo "usage: deploy/backup/restore.sh <db-YYYYMMDD-HHMMSS.sql.gz> --yes"
  echo "This replaces the current database with the backup. Nothing is changed without --yes."
  exit 2
fi
case "$file" in
  db-*.sql.gz) ;;
  *) echo "Not a database backup name: $file"; exit 2 ;;
esac

echo "Checking the backup exists..."
docker compose run --rm --no-deps --entrypoint sh db-backup -c "test -s /backups/$file" \
  || { echo "No such backup in the db-backups volume: $file"; exit 1; }

echo "Stopping the services that use the database..."
docker compose stop api rest realtime auth partykit

echo "Restoring $file (this can take a while)..."
docker compose run --rm --no-deps --entrypoint sh db-backup -c \
  "gunzip -c /backups/$file | psql -v ON_ERROR_STOP=0 -q -d postgres >/dev/null"

echo "Starting them again..."
docker compose up -d api rest realtime auth partykit
echo "Restored from $file."
