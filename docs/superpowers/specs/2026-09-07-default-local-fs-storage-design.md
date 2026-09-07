# Default Local Filesystem Storage Design

## Overview
Switch default object storage from S3/MinIO to the local filesystem (`FSDriver` from `@repo/storage`) across `apps/api`, Docker Compose configurations, and test environments, while keeping S3 support available via `STORAGE_DRIVER=s3`.

## Architecture & API Configuration

### 1. `apps/api/src/shared/storage.ts`
- Read driver from `process.env.STORAGE_DRIVER || 'fs'`.
- Supported drivers:
  - `'fs'` (default):
    - Location resolved from `process.env.STORAGE_PATH || './storage'`.
    - Relative paths are resolved against `process.cwd()`.
    - Instantiates `FSDriver({ location: resolvedPath })` wrapped in `new Disk(driver)`.
  - `'s3'`:
    - Validates presence of `S3_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`.
    - Instantiates `S3Driver` with endpoint, credentials, region, and path style settings, wrapped in `new Disk(driver)`.
  - Any other value: throws an error: `Unsupported STORAGE_DRIVER "<value>". Supported drivers: "fs", "s3".`
- Preserve existing exports and signatures:
  - `storage: Disk`
  - `readStream(key: string): Promise<StorageStream>`
  - `deleteMany(keys: string[]): Promise<void>`

## Infrastructure & Docker Compose

### 1. `docker-compose.dev.yml`
- Remove `minio` and `minio-init` services and the `minio-dev-data` volume.
- Dev compose stack manages PostgreSQL only. Local API processes store assets directly in `./storage`.

### 2. Production Composes (`docker-compose.yml`, `docker-compose.coolify.yml`, `docker-compose.coolify-images.yml`)
- Remove `minio` and `minio-init` service blocks.
- Remove `minio-init` dependency condition from `api`.
- Add persistent volume `storage-data:/app/storage` to `api`.
- Add environment variables to `api`:
  - `STORAGE_DRIVER: ${STORAGE_DRIVER:-fs}`
  - `STORAGE_PATH: ${STORAGE_PATH:-/app/storage}`
- Retain optional S3 environment variable passthroughs (`S3_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_REGION`, `S3_FORCE_PATH_STYLE`) without requiring them in `.env`.
- Replace `minio-data` in `volumes` with `storage-data`.

### 3. Test Gate (`docker-compose.test.yml`)
- Remove `minio-test` and `minio-test-init` services.
- `api-test` depends only on `postgres-test`.
- Run `api-test` with `STORAGE_DRIVER: fs` and `STORAGE_PATH: /tmp/storage-test`.

## Environment & Testing

### 1. Environment Templates
- `.env.example`:
  - Set `STORAGE_DRIVER=fs` and `STORAGE_PATH=./storage` as default configuration.
  - Document S3 settings as commented/optional overrides when `STORAGE_DRIVER=s3`.
- `.env.test.example`:
  - Set `STORAGE_DRIVER=fs` and `STORAGE_PATH=./.storage-test`.

### 2. Git Configuration
- Ensure `/storage` and `/.storage-test` are present in `.gitignore`.

### 3. Test Suite
- `attachments.test.ts` runs directly against `FSDriver` via API routes without requiring a running MinIO instance.
- Clean up test files created during integration test runs.

## Documentation
- Update root `AGENTS.md` "First run" instructions to remove the MinIO mention.
- Update `apps/api/AGENTS.md` and `docs/self-hosting.md` to reflect local filesystem default storage and volume configuration.
