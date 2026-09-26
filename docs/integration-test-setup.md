# Integration Test Environment Setup Guide

This guide walks through spinning up a complete local integration test environment for Aura Vault Protocol — including the Stellar testnet sandbox, PostgreSQL 16, Redis 7, and the backend API — on a clean Ubuntu 22.04 installation.

> All steps have been verified on Ubuntu 22.04 LTS (clean install). Estimated setup time: 20–30 minutes.

---

## Table of Contents

1. [Prerequisites](#1-prerequisites)
2. [Starting Docker Compose Services](#2-starting-docker-compose-services)
3. [Running Database Migrations](#3-running-database-migrations)
4. [Deploying the Contract to Local Stellar Sandbox](#4-deploying-the-contract-to-local-stellar-sandbox)
5. [Setting Environment Variables](#5-setting-environment-variables)
6. [Running Integration Tests](#6-running-integration-tests)
7. [Teardown](#7-teardown)
8. [Troubleshooting](#8-troubleshooting)

---

## 1. Prerequisites

Install the following tools before proceeding. All commands assume `sudo` access.

### Node.js 22+

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs
node --version   # must be >= 22.0.0
npm --version
```

### Rust + `wasm32-unknown-unknown` target

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
source "$HOME/.cargo/env"
rustup default stable
rustup target add wasm32-unknown-unknown
cargo --version   # must be >= 1.78
```

### Docker Engine + Docker Compose v2

```bash
sudo apt-get install -y ca-certificates curl gnupg
sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
sudo chmod a+r /etc/apt/keyrings/docker.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo usermod -aG docker $USER
newgrp docker
docker --version          # must be >= 24.0
docker compose version    # must be >= 2.0
```

### PostgreSQL client (`psql`)

```bash
sudo apt-get install -y postgresql-client
psql --version   # used for migration verification and health checks
```

### Stellar CLI

```bash
cargo install --locked stellar-cli --features opt
stellar --version   # must be >= 21.0.0
```

> **Note:** The `stellar` CLI install may take several minutes on first run due to compilation.

### Playwright browsers (for E2E tests)

```bash
cd /path/to/aura-vault-protocol
npx playwright install --with-deps chromium firefox webkit
```

---

## 2. Starting Docker Compose Services

The test environment requires PostgreSQL 16 and Redis 7. A dedicated test compose file is provided to avoid conflicts with the production compose configuration.

### Start services

```bash
# From the repository root
cd /path/to/aura-vault-protocol

# Start PostgreSQL and Redis for integration testing
docker compose -f docker-compose.test.yml up -d

# Verify all containers are healthy
docker compose -f docker-compose.test.yml ps
```

Expected output:

```
NAME                    IMAGE               STATUS
aura-postgres-test      postgres:16-alpine  Up (healthy)
aura-redis-test         redis:7-alpine      Up (healthy)
```

### Wait for health checks

Both containers expose health checks. Poll until both report `healthy`:

```bash
until [ "$(docker inspect --format='{{.State.Health.Status}}' aura-postgres-test)" = "healthy" ] && \
      [ "$(docker inspect --format='{{.State.Health.Status}}' aura-redis-test)" = "healthy" ]; do
  echo "Waiting for services to be healthy..."
  sleep 2
done
echo "All services healthy."
```

### Service connection details (test environment)

| Service | Host | Port | Credentials |
|---|---|---|---|
| PostgreSQL 16 | `localhost` | `5433` | `postgres` / `postgres` / db: `aura_test` |
| Redis 7 | `localhost` | `6380` | no password (test only) |

> Port offsets (`5433`, `6380`) prevent conflicts with any locally running production instances on the default ports.

---

## 3. Running Database Migrations

The backend ships a migration runner at `backend/src/migrations/runner.ts`. Migrations are numbered SQL files in `backend/migrations/`.

### Install backend dependencies

```bash
cd backend
npm install
```

### Configure test database connection

Create a test-specific `.env.test` if it does not already exist:

```bash
cp .env.example .env.test
```

Edit `.env.test` and set at minimum:

```env
DATABASE_URL=postgresql://postgres:postgres@localhost:5433/aura_test
REDIS_URL=redis://localhost:6380
JWT_SECRET=test-integration-secret-do-not-use-in-production
NODE_ENV=test
```

### Run migrations

```bash
# From backend/
DATABASE_URL=postgresql://postgres:postgres@localhost:5433/aura_test \
  npx tsx src/migrations/cli.ts up
```

Expected output:

```
[migrations] Running migration: 001_create_vault_positions.sql ✓
[migrations] Running migration: 002_create_vault_events.sql    ✓
[migrations] Running migration: 002_create_transaction_jobs.sql ✓
[migrations] Running migration: 003_create_referrals.sql       ✓
[migrations] Running migration: 003_vault_positions_indexes.sql ✓
[migrations] Running migration: 004_create_yield_calculations.sql ✓
[migrations] Running migration: 008_create_admin_audit_log.sql ✓
[migrations] Running migration: 009_create_audit_logs.sql      ✓
[migrations] Running migration: 010_create_vaults_registry.sql ✓
[migrations] Running migration: 010_create_alert_subscriptions.sql ✓
[migrations] Running migration: 011_contract_events_fts.sql    ✓
[migrations] All migrations applied successfully.
```

### Verify schema

```bash
psql postgresql://postgres:postgres@localhost:5433/aura_test \
  -c "\dt"
```

Expected tables: `vault_positions`, `vault_events`, `transaction_jobs`, `referrals`, `yield_calculations`, `audit_logs`, `vaults_registry`, `alert_subscriptions`, `contract_events`, `schema_migrations`.

---

## 4. Deploying the Contract to Local Stellar Sandbox

### Start the Stellar local sandbox

The Stellar sandbox runs a local Soroban-enabled network in Docker:

```bash
docker run --rm -d \
  --name stellar-sandbox \
  -p 8000:8000 \
  stellar/quickstart:latest \
  --local \
  --enable-soroban-rpc
```

Wait for the sandbox to initialise (approximately 30 seconds):

```bash
until curl -sf http://localhost:8000/health | grep -q '"status":"healthy"'; do
  echo "Waiting for Stellar sandbox..."
  sleep 3
done
echo "Stellar sandbox ready."
```

### Build the contract

```bash
cd aura-vault
cargo build --target wasm32-unknown-unknown --release
```

Output artifact: `aura-vault/target/wasm32-unknown-unknown/release/aura_vault.wasm`

### Generate a test keypair

```bash
stellar keys generate test-admin --network local
stellar keys address test-admin   # note the public key
```

Fund the test account via the sandbox friendbot:

```bash
ADMIN_ADDRESS=$(stellar keys address test-admin)
curl "http://localhost:8000/friendbot?addr=${ADMIN_ADDRESS}"
```

### Upload and deploy the contract

```bash
# Upload Wasm bytecode
WASM_HASH=$(stellar contract upload \
  --wasm target/wasm32-unknown-unknown/release/aura_vault.wasm \
  --source test-admin \
  --network local \
  --rpc-url http://localhost:8000/soroban/rpc \
  --network-passphrase "Standalone Network ; February 2017")

echo "Wasm hash: ${WASM_HASH}"

# Deploy contract instance
CONTRACT_ID=$(stellar contract deploy \
  --wasm-hash "${WASM_HASH}" \
  --source test-admin \
  --network local \
  --rpc-url http://localhost:8000/soroban/rpc \
  --network-passphrase "Standalone Network ; February 2017")

echo "Contract ID: ${CONTRACT_ID}"
```

### Deploy a test SEP-41 token

```bash
# Deploy the Stellar native token wrapper (USDC-equivalent for testing)
TOKEN_ID=$(stellar contract deploy \
  --wasm-hash $(stellar contract install \
    --wasm ~/.stellar/sep41-token.wasm \
    --source test-admin \
    --network local \
    --rpc-url http://localhost:8000/soroban/rpc \
    --network-passphrase "Standalone Network ; February 2017") \
  --source test-admin \
  --network local \
  --rpc-url http://localhost:8000/soroban/rpc \
  --network-passphrase "Standalone Network ; February 2017")
```

> **Shortcut:** For integration tests, the test suite automatically deploys mock contracts using `soroban_sdk::testutils`. The manual deployment above is only needed for end-to-end backend integration tests that hit a live local network.

### Initialise the vault

```bash
stellar contract invoke \
  --id "${CONTRACT_ID}" \
  --source test-admin \
  --network local \
  --rpc-url http://localhost:8000/soroban/rpc \
  --network-passphrase "Standalone Network ; February 2017" \
  -- initialize \
  --admin "${ADMIN_ADDRESS}" \
  --underlying_token "${TOKEN_ID}" \
  --signers "[\"${ADMIN_ADDRESS}\"]" \
  --decimals 7
```

---

## 5. Setting Environment Variables

### Backend `.env.test`

The backend requires the following variables for integration tests. Start from the example:

```bash
cd backend
cp .env.example .env.test
```

Populate `.env.test`:

```env
# Server
NODE_ENV=test
PORT=3001

# Auth
JWT_SECRET=test-integration-secret-do-not-use-in-production
JWT_REFRESH_SECRET=test-refresh-secret-do-not-use-in-production
JWT_ACCESS_EXPIRY=15m
JWT_REFRESH_EXPIRY=30d

# Database
DATABASE_URL=postgresql://postgres:postgres@localhost:5433/aura_test
DATABASE_REPLICA_URL=postgresql://postgres:postgres@localhost:5433/aura_test

# Redis
REDIS_URL=redis://localhost:6380

# Stellar / Soroban
SOROBAN_RPC_URL=http://localhost:8000/soroban/rpc
NETWORK_PASSPHRASE=Standalone Network ; February 2017
VAULT_CONTRACT_ID=<CONTRACT_ID from step 4>
HORIZON_URL=http://localhost:8000

# Cache TTLs (short for tests)
CACHE_API_TTL=5
CACHE_DEFI_PRICE_TTL=5

# Feature flags (disable external calls in test)
DISABLE_EMAIL=true
DISABLE_EXTERNAL_PRICE_FEED=true
```

### Playwright `.env.test`

```bash
# From repository root
cat > .env.playwright.test << 'EOF'
PLAYWRIGHT_BASE_URL=http://localhost:3000
EOF
```

### Loading env in tests

The Vitest configuration picks up `.env.test` automatically. For manual CLI usage:

```bash
export $(grep -v '^#' backend/.env.test | xargs)
```

---

## 6. Running Integration Tests

### Smart contract unit + integration tests (Cargo)

```bash
cd aura-vault
cargo test -- --test-threads=4
```

Expected: all 22+ tests pass. Test names include `test_first_deposit_mints_one_to_one`, `test_harvest_non_dilution`, `test_deposit_overflow_returns_math_overflow`, etc.

For verbose output:

```bash
cargo test -- --nocapture
```

### Backend unit tests (Vitest)

```bash
cd backend
npm test
```

### Backend integration tests

```bash
cd backend
NODE_ENV=test \
  DATABASE_URL=postgresql://postgres:postgres@localhost:5433/aura_test \
  REDIS_URL=redis://localhost:6380 \
  npm run test:integration
```

> If no `test:integration` script exists, run: `npx vitest run --testPathPattern='integration'`

### Start the backend for E2E tests

The frontend and E2E tests require a running backend:

```bash
cd backend
NODE_ENV=test node -r dotenv/config dist/index.js dotenv_config_path=.env.test &
BACKEND_PID=$!

# Wait for backend readiness
until curl -sf http://localhost:3001/api/health | grep -q '"status":"ok"'; do
  sleep 1
done
echo "Backend ready."
```

### Start the frontend for E2E tests

```bash
cd frontend
npm run build
npm start &
FRONTEND_PID=$!

until curl -sf http://localhost:3000 > /dev/null; do
  sleep 1
done
echo "Frontend ready."
```

### Playwright E2E tests

```bash
# From repository root
PLAYWRIGHT_BASE_URL=http://localhost:3000 \
  npx playwright test --project=chromium
```

Run all projects (cross-browser):

```bash
PLAYWRIGHT_BASE_URL=http://localhost:3000 npx playwright test
```

Run a specific test file:

```bash
PLAYWRIGHT_BASE_URL=http://localhost:3000 \
  npx playwright test playwright/keeper-harvest.spec.ts
```

### Cypress integration tests

```bash
# From repository root
npx cypress run --headless
```

### Full test suite (sequential)

```bash
#!/usr/bin/env bash
set -euo pipefail

echo "=== Smart Contract Tests ==="
(cd aura-vault && cargo test)

echo "=== Backend Unit Tests ==="
(cd backend && npm test)

echo "=== Playwright E2E Tests ==="
PLAYWRIGHT_BASE_URL=http://localhost:3000 npx playwright test --project=chromium

echo "=== Cypress Integration Tests ==="
npx cypress run --headless

echo "All tests passed."
```

---

## 7. Teardown

Stop background processes and remove Docker containers:

```bash
# Stop backend and frontend if started above
kill $BACKEND_PID $FRONTEND_PID 2>/dev/null || true

# Stop and remove test Docker containers + volumes
docker compose -f docker-compose.test.yml down -v

# Stop Stellar sandbox
docker stop stellar-sandbox 2>/dev/null || true

# Optional: remove built Wasm artifacts
cd aura-vault && cargo clean
```

Verify teardown:

```bash
docker compose -f docker-compose.test.yml ps   # should show no running services
```

---

## 8. Troubleshooting

### Port conflicts

**Symptom:** `docker compose up` fails with `port is already allocated`.

**Resolution:**
```bash
# Find the process using the port (e.g., 5433)
sudo lsof -i :5433
sudo kill -9 <PID>

# Or stop any existing local PostgreSQL
sudo systemctl stop postgresql
```

### Migration fails: `relation already exists`

**Symptom:** Re-running migrations on an existing database produces errors.

**Resolution:** Drop and recreate the test database:
```bash
psql postgresql://postgres:postgres@localhost:5433/postgres \
  -c "DROP DATABASE IF EXISTS aura_test; CREATE DATABASE aura_test;"
```

Then re-run migrations.

### Stellar CLI: `stellar: command not found` after install

**Resolution:** Source the Cargo environment:
```bash
source "$HOME/.cargo/env"
# Or add to ~/.bashrc:
echo 'source "$HOME/.cargo/env"' >> ~/.bashrc && source ~/.bashrc
```

### Stellar sandbox unhealthy

**Symptom:** The sandbox health check never returns `healthy`.

**Resolution:**
```bash
# Check container logs
docker logs stellar-sandbox --tail 50

# Try pulling a fresh image
docker pull stellar/quickstart:latest
docker stop stellar-sandbox && docker rm stellar-sandbox

# Restart with explicit port binding
docker run --rm -d \
  --name stellar-sandbox \
  -p 8000:8000 \
  stellar/quickstart:latest \
  --local \
  --enable-soroban-rpc \
  --protocol-version 21
```

### `VaultError::NotInitialized` on contract calls

**Symptom:** All contract invocations fail with `NotInitialized`.

**Resolution:** The contract must be initialised after deployment. Run the `initialize` step from [Section 4](#4-deploying-the-contract-to-local-stellar-sandbox) with the correct admin address and token ID.

### Backend fails to connect to PostgreSQL

**Symptom:** `ECONNREFUSED` on port 5433.

**Resolution:**
```bash
# Verify container is running and healthy
docker compose -f docker-compose.test.yml ps

# Check container logs
docker logs aura-postgres-test --tail 20

# Test connection manually
psql postgresql://postgres:postgres@localhost:5433/aura_test -c "SELECT 1;"
```

### `cargo test` fails: `overflow error` in release build

**Symptom:** Tests pass in debug but fail in release with integer overflow.

**Resolution:** The Cargo.toml sets `overflow-checks = true` for the release profile — this is intentional. If you see overflow in tests, it likely indicates a genuine arithmetic bug. Examine the failing test case and the corresponding checked arithmetic path.

### Playwright tests timeout or fail to find elements

**Symptom:** `locator.click: Timeout 30000ms exceeded`.

**Resolution:**
1. Verify the frontend is running: `curl http://localhost:3000`
2. Check `PLAYWRIGHT_BASE_URL` is set correctly.
3. Run in headed mode to observe the failure: `npx playwright test --headed`
4. Increase individual test timeouts in `playwright.config.ts` for slow CI environments.

### Redis connection refused

**Symptom:** Backend logs `connect ECONNREFUSED 127.0.0.1:6380`.

**Resolution:**
```bash
# Verify Redis container
docker compose -f docker-compose.test.yml ps aura-redis-test

# Test manually
docker exec aura-redis-test redis-cli ping   # should return PONG
```

---

## CI Pipeline Reference

The integration test environment described in this guide is exercised by the `.github/workflows/integration-tests.yml` pipeline. In CI:

- Docker Compose services start via `docker compose -f docker-compose.test.yml up -d`.
- Migrations run automatically before any test suite.
- The Stellar sandbox runs as a Docker service within the CI job.
- Playwright runs headless against `http://localhost:3000`.

See `.github/workflows/integration-tests.yml` for the authoritative CI configuration.

---

*Guide covers: [#975](https://github.com/soterika/aura-vault-protocol/issues/975)*
