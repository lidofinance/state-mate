#!/usr/bin/env bash
set -euo pipefail

cp -n .env.sample .env 2>/dev/null || true
yarn install --immutable
