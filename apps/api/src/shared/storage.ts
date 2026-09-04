import { Disk, S3Driver, type StorageStream } from '@repo/storage';

let cachedDisk: Disk | null = null;

export function getStorage(): Disk {
  if (cachedDisk) return cachedDisk;
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
