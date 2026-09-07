# Default Local Filesystem Storage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Set the default object storage driver in `apps/api` to local filesystem (`fs`), decoupling local development, test suites, and default Docker Compose deployments from MinIO while retaining full S3 compatibility via `STORAGE_DRIVER=s3`.

**Architecture:** Update `apps/api/src/shared/storage.ts` to inspect `STORAGE_DRIVER` (defaulting to `'fs'`) and instantiate `FSDriver` with `STORAGE_PATH` (defaulting to `./storage`). Decouple MinIO from `docker-compose.dev.yml`, `docker-compose.test.yml`, and production compose files by mounting a persistent `storage-data:/app/storage` volume in `api`.

**Tech Stack:** Bun, Elysia, `@repo/storage` (Flydrive-based `FSDriver` & `S3Driver`), Docker Compose.

## Global Constraints

- Runtime is Bun.
- Follow KISS and YAGNI; avoid overengineering.
- Write minimal comments explaining why, never what.
- Conventional commit format for commit messages (do not commit unless requested).
- All workspace checks must pass: `bun run typecheck`, `bun run lint`, `bun run test`.

---

### Task 1: Update `apps/api/src/shared/storage.ts` for Local FS Default & S3 Support

**Files:**
- Modify: `apps/api/src/shared/storage.ts`
- Create: `apps/api/src/shared/__tests__/storage.test.ts`

**Interfaces:**
- Consumes: `FSDriver`, `S3Driver`, `Disk` from `@repo/storage`
- Produces:
  - `getStorage(): Disk`
  - `storage: Disk`
  - `readStream(key: string): Promise<StorageStream>`
  - `deleteMany(keys: string[]): Promise<void>`
  - `resetStorageForTest(): void` (for test suite driver reinitialization)

- [ ] **Step 1: Write unit tests for storage driver resolution**

Create `apps/api/src/shared/__tests__/storage.test.ts`:
```ts
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { getStorage, resetStorageForTest } from '../storage';
import { FSDriver, S3Driver } from '@repo/storage';

describe('storage driver configuration', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    resetStorageForTest();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    resetStorageForTest();
  });

  it('defaults to FSDriver when STORAGE_DRIVER is unset', () => {
    delete process.env.STORAGE_DRIVER;
    delete process.env.STORAGE_PATH;
    const disk = getStorage();
    expect(disk.driver).toBeInstanceOf(FSDriver);
  });

  it('uses FSDriver when STORAGE_DRIVER=fs with custom STORAGE_PATH', () => {
    process.env.STORAGE_DRIVER = 'fs';
    process.env.STORAGE_PATH = './custom-storage';
    const disk = getStorage();
    expect(disk.driver).toBeInstanceOf(FSDriver);
  });

  it('throws an error if STORAGE_DRIVER=s3 and required env vars are missing', () => {
    process.env.STORAGE_DRIVER = 's3';
    delete process.env.S3_ENDPOINT;
    delete process.env.S3_BUCKET;
    delete process.env.S3_ACCESS_KEY_ID;
    delete process.env.S3_SECRET_ACCESS_KEY;
    expect(() => getStorage()).toThrow('S3 storage is not configured');
  });

  it('uses S3Driver when STORAGE_DRIVER=s3 and credentials are provided', () => {
    process.env.STORAGE_DRIVER = 's3';
    process.env.S3_ENDPOINT = 'http://localhost:9000';
    process.env.S3_BUCKET = 'test-bucket';
    process.env.S3_ACCESS_KEY_ID = 'minioadmin';
    process.env.S3_SECRET_ACCESS_KEY = 'minioadmin';
    const disk = getStorage();
    expect(disk.driver).toBeInstanceOf(S3Driver);
  });

  it('throws an error on unsupported STORAGE_DRIVER', () => {
    process.env.STORAGE_DRIVER = 'gcs';
    expect(() => getStorage()).toThrow('Unsupported STORAGE_DRIVER "gcs"');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test apps/api/src/shared/__tests__/storage.test.ts`
Expected: FAIL (missing `resetStorageForTest` or default behavior not yet implemented)

- [ ] **Step 3: Update `apps/api/src/shared/storage.ts` implementation**

Update `apps/api/src/shared/storage.ts`:
```ts
import { resolve } from 'node:path';
import { Disk, FSDriver, S3Driver, type StorageStream } from '@repo/storage';

let cachedDisk: Disk | null = null;

export function resetStorageForTest(): void {
  cachedDisk = null;
}

export function getStorage(): Disk {
  if (cachedDisk) return cachedDisk;

  const driverName = (process.env.STORAGE_DRIVER || 'fs').toLowerCase();

  if (driverName === 'fs') {
    const rawPath = process.env.STORAGE_PATH || './storage';
    const location = resolve(process.cwd(), rawPath);
    const driver = new FSDriver({ location });
    cachedDisk = new Disk(driver);
    return cachedDisk;
  }

  if (driverName === 's3') {
    const endpoint = process.env.S3_ENDPOINT;
    const bucket = process.env.S3_BUCKET;
    const accessKeyId = process.env.S3_ACCESS_KEY_ID;
    const secretAccessKey = process.env.S3_SECRET_ACCESS_KEY;
    if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) {
      throw new Error(
        'S3 storage is not configured: set S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY.',
      );
    }

    const driver = new S3Driver({
      endpoint,
      bucket,
      region: process.env.S3_REGION || 'us-east-1',
      credentials: { accessKeyId, secretAccessKey },
      forcePathStyle: process.env.S3_FORCE_PATH_STYLE !== 'false',
    });

    cachedDisk = new Disk(driver);
    return cachedDisk;
  }

  throw new Error(`Unsupported STORAGE_DRIVER "${driverName}". Supported drivers: "fs", "s3".`);
}

export const storage = new Proxy({} as Disk, {
  get(_target, prop, receiver) {
    const disk = getStorage();
    const val = Reflect.get(disk, prop, receiver);
    return typeof val === 'function' ? val.bind(disk) : val;
  },
});

export async function readStream(key: string): Promise<StorageStream> {
  return storage.readStream(key);
}

export async function deleteMany(keys: string[]): Promise<void> {
  await Promise.all(
    keys.map((key) =>
      storage.delete(key).catch((err: unknown) => {
        console.error(`[storage] failed to delete object ${key}:`, err);
      }),
    ),
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test apps/api/src/shared/__tests__/storage.test.ts`
Expected: PASS

---

### Task 2: Environment Templates & Git Configuration

**Files:**
- Modify: `.gitignore`
- Modify: `.env.example`
- Modify: `.env.test.example`

- [ ] **Step 1: Update `.gitignore`**

Ensure `/storage` and `/.storage-test` are listed in `.gitignore`:
```gitignore
# Local storage
/storage
/.storage-test
```

- [ ] **Step 2: Update `.env.example`**

Replace the S3/MinIO required section with:
```env
# ── Object storage: attachments, avatars, skill uploads ──
# Driver: "fs" (default, local filesystem) or "s3" (AWS S3, MinIO, Cloudflare R2).
STORAGE_DRIVER=fs
# Local filesystem root (relative to working directory or absolute).
STORAGE_PATH=./storage

# S3 settings (required only if STORAGE_DRIVER=s3):
# S3_ENDPOINT=http://localhost:9000
# S3_BUCKET=planner-attachments
# S3_ACCESS_KEY_ID=minioadmin
# S3_SECRET_ACCESS_KEY=minioadmin
# S3_REGION=us-east-1
# S3_FORCE_PATH_STYLE=false
```

- [ ] **Step 3: Update `.env.test.example`**

Set:
```env
STORAGE_DRIVER=fs
STORAGE_PATH=./.storage-test
```
And comment or remove mandatory `S3_*` values.

---

### Task 3: Integration Tests Update for Local FS Storage

**Files:**
- Modify: `apps/api/src/modules/attachments/__tests__/integration/attachments.test.ts`

- [ ] **Step 1: Update comments and ensure clean test execution**

Ensure `attachments.test.ts` tests execute against the configured storage (`fs` by default). Add cleanup in `resetDb()` or test teardown if needed.

- [ ] **Step 2: Run attachments integration test**

Run: `bun --filter=api test src/modules/attachments`
Expected: All tests pass without needing a running MinIO server.

---

### Task 4: Update Docker Compose Configurations

**Files:**
- Modify: `docker-compose.dev.yml`
- Modify: `docker-compose.yml`
- Modify: `docker-compose.coolify.yml`
- Modify: `docker-compose.coolify-images.yml`
- Modify: `docker-compose.test.yml`

- [ ] **Step 1: Update `docker-compose.dev.yml`**
Remove `minio` and `minio-init` services and volume `minio-dev-data`. Keep only `postgres`.

- [ ] **Step 2: Update `docker-compose.yml`**
- Remove `minio` and `minio-init` services.
- Remove `minio-init` from `api.depends_on`.
- Add `storage-data:/app/storage` volume to `api`.
- Add `STORAGE_DRIVER: ${STORAGE_DRIVER:-fs}` and `STORAGE_PATH: ${STORAGE_PATH:-/app/storage}` to `api.environment`.
- Make `S3_*` env vars optional in `api.environment` (`${S3_ACCESS_KEY_ID:-}`).
- Replace `minio-data` in `volumes` with `storage-data`.
- Remove `S3_ACCESS_KEY_ID` and `S3_SECRET_ACCESS_KEY` from required `.env` comment list.

- [ ] **Step 3: Update `docker-compose.coolify.yml` & `docker-compose.coolify-images.yml`**
Apply the identical changes from Step 2 to keep the three deploy compose files synchronized.

- [ ] **Step 4: Update `docker-compose.test.yml`**
- Remove `minio-test` and `minio-test-init`.
- Remove `minio-test-init` from `api-test.depends_on`.
- Set `STORAGE_DRIVER: fs` and `STORAGE_PATH: /tmp/storage-test` in `api-test.environment`.

---

### Task 5: Documentation Updates

**Files:**
- Modify: `AGENTS.md`
- Modify: `apps/api/AGENTS.md`
- Modify: `docs/self-hosting.md`

- [ ] **Step 1: Update root `AGENTS.md`**
- In "First run": `docker compose -f docker-compose.dev.yml up -d` brings up dev Postgres (remove MinIO mention).
- In compose files table: update descriptions.

- [ ] **Step 2: Update `apps/api/AGENTS.md`**
- In "Tests setup": update notes to mention default `STORAGE_DRIVER=fs` and remove MinIO prerequisite.

- [ ] **Step 3: Update `docs/self-hosting.md`**
- Update storage sections to describe default local filesystem storage with named volume `storage-data:/app/storage` and optional S3 driver.

---

### Task 6: Full Verification

- [ ] **Step 1: Run typecheck across the workspace**
Run: `bun run typecheck`
Expected: 0 errors

- [ ] **Step 2: Run linter across the workspace**
Run: `bun run lint`
Expected: 0 errors

- [ ] **Step 3: Run full test suite**
Run: `bun run test`
Expected: All tests pass
