#!/bin/sh
set -e

# Ensure data directories exist and are writable by the navilist user
# Runs as root before dropping privileges
if [ "$(id -u)" = "0" ]; then
  mkdir -p /app/data/logs
  chown -R navilist:navilist /app/data
  exec su-exec navilist "$@"
else
  exec "$@"
fi
