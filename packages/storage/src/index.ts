export { Disk } from './disk.js';
export { DriveFile, DriveFile as StorageFile } from './file.js';
export { DriveDirectory, DriveDirectory as StorageDirectory } from './directory.js';
export { DriveManager, DriveManager as StorageManager } from './manager.js';
export { FakeDisk } from './fake-disk.js';
export { KeyNormalizer } from './key-normalizer.js';
export * as errors from './errors.js';
export * from './errors.js';
export * from './types.js';

export { S3Driver } from './drivers/s3.js';
export type { S3DriverOptions, S3DriverBaseOptions } from './drivers/s3.js';

export { FSDriver } from './drivers/fs.js';
export type { FSDriverOptions } from './drivers/fs.js';
