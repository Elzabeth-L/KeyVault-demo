#!/bin/sh
set -eu

gunicorn backend.main:app \
  --worker-class uvicorn.workers.UvicornWorker \
  --bind 127.0.0.1:8000 \
  --workers "${API_WORKERS:-2}" &

cd /app/frontend
exec node server.js
