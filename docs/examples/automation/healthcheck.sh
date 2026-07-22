#!/usr/bin/env bash
# Probe a running ocpp-cp-sim daemon. Usage: ./healthcheck.sh [base-url]
set -euo pipefail
BASE="${1:-http://127.0.0.1:9700}"
curl -fsS "$BASE/v1/healthz" && echo " <- healthz OK"
# Daemon gated with --web-console-basic-auth-user/-pass? Authenticate:
#   curl -fsS -u admin:secret "$BASE/v1/healthz"
