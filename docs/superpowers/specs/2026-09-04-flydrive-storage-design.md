# Flydrive 2.x Storage Refactor & Integration Design

## Overview
Port Flydrive 2.x core and drivers into `packages/storage` (`@repo/storage`) as a zero-external-utility, pure TypeScript workspace package, and replace `#shared/s3.ts` in `apps/api` with `#shared/storage.ts` using the new `Disk` API.

## Architecture

### 1. `packages/storage` (@repo/storage)
The storage package exposes a multi-driver file storage abstraction adapted from Flydrive 2.x:
- **Core Abstractions**:
  - `Disk`: High-level unified API (`put`, `get`, `getBytes`, `getStream`, `getMetaData`, `delete`, `deleteAll`, `copy`, `move`, `exists`, `listAll`, `getUrl`, `getSignedUrl`).
  - `DriveManager`: Named service registry and testing fakes.
  - `DriveFile` & `DriveDirectory`: Represent files and directories returned by operations.
  - `KeyNormalizer`: Normalizes paths, enforces unix slashes, trims redundant dots and slashes, and protects against path traversal.
  - `RangeUtils`: Validates and parses HTTP byte range requests.
  - `Errors`: Standardized typed errors (`E_CANNOT_WRITE_FILE`, `E_CANNOT_READ_FILE`, `E_CANNOT_DELETE_FILE`, `E_UNALLOWED_CHARACTERS`, `E_PATH_TRAVERSAL_DETECTED`, etc.).
- **Drivers**:
  - `S3Driver`: S3-compatible driver using `@aws-sdk/client-s3` and `@aws-sdk/s3-request-presigner` (supports AWS S3, MinIO, Cloudflare R2, etc.).
  - `FSDriver`: Local filesystem driver using `node:fs/promises`.
  - `FakeDisk`: In-memory test disk.
- **Utilities**:
  - Pure native TypeScript replacements for `@poppinss/utils` (string whitespace condensing, unix path normalization, human-readable time durations to seconds, and standard custom error classes).

### 2. `apps/api` Integration
- Add dependency `"@repo/storage": "workspace:*"` to `apps/api/package.json`.
- Replace `apps/api/src/shared/s3.ts` with `apps/api/src/shared/storage.ts`.
- `apps/api/src/shared/storage.ts`:
  - Instantiates `Disk` with `S3Driver` configured from environment variables (`S3_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_REGION`, `S3_FORCE_PATH_STYLE`).
  - Exports `storage` (the `Disk` instance).
  - Exports `readStream(key)` returning `{ body: ReadableStream, contentType: string, contentLength?: number }` for Elysia raw file delivery.
  - Exports `deleteMany(keys)` for concurrent best-effort deletions.
- Refactor call sites in `apps/api`:
  - `modules/attachments/index.ts` & `service.ts`
  - `modules/avatars/index.ts` & `service.ts`
  - `modules/chat-attachments/index.ts` & `service.ts`
  - `modules/issues/index.ts`
  - `modules/projects/copy.ts`
  - `modules/agents/skills/service.ts`

### 3. Dockerfiles & Workspace Manifests
- In all Dockerfiles that install dependencies (`apps/api/Dockerfile`, `apps/web/Dockerfile`, `apps/worker/Dockerfile`, `apps/bot/Dockerfile`):
  Add `COPY packages/storage/package.json ./packages/storage/` so `bun install --frozen-lockfile` succeeds.

## Verification
- Unit and integration tests for `@repo/storage`:
  - Key normalization and security checks (path traversal prevention).
  - S3 and FS drivers basic put, get, stream, delete, exists operations.
- Full API integration tests: `bun run --filter=api test` (running attachment and avatar tests against MinIO).
- Typecheck and Lint: `bun run typecheck` and `bun run lint`.
