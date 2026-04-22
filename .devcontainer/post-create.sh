#!/usr/bin/env bash
set -euo pipefail

[ -f .env ] || cp .env.sample .env
yarn install --immutable
