#!/usr/bin/env bash
set -e
cd "$(dirname "$0")"
# Invoke uvicorn through the venv's own interpreter so it always uses the
# venv's site-packages, regardless of how PATH resolves the bare `uvicorn`.
exec .venv/bin/python -m uvicorn main:app --reload --port 3001
