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
