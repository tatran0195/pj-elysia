import { join } from 'node:path';
import { AssertionError } from 'node:assert';
import { Disk } from './disk.js';
import { FSDriver } from './drivers/fs.js';
import type { DriveManagerOptions } from './types.js';

export class FakeDisk extends Disk {
  declare driver: FSDriver;
  #restoreFn: (() => void) | undefined;

  constructor(
    public disk: string,
    fakesConfig: Exclude<DriveManagerOptions<Record<string, () => never>>['fakes'], undefined>,
  ) {
    super(
      new FSDriver({
        location:
          typeof fakesConfig.location === 'string'
            ? join(fakesConfig.location, disk)
            : new URL(disk, fakesConfig.location),
        visibility: 'public',
        urlBuilder: fakesConfig.urlBuilder,
      }),
    );
  }

  onRestore(fn: () => void) {
    this.#restoreFn = fn;
    return this;
  }

  [Symbol.dispose]() {
    this.#restoreFn?.();
  }

  assertExists(paths: string | string[]) {
    const pathsToVerify = Array.isArray(paths) ? paths : [paths];
    for (const filePath of pathsToVerify) {
      if (!this.driver.existsSync(filePath)) {
        throw new AssertionError({
          message: `Expected "${filePath}" to exist, but file not found.`,
        });
      }
    }
  }

  assertMissing(paths: string | string[]) {
    const pathsToVerify = Array.isArray(paths) ? paths : [paths];
    for (const filePath of pathsToVerify) {
      if (this.driver.existsSync(filePath)) {
        throw new AssertionError({
          message: `Expected "${filePath}" to be missing, but file exists`,
        });
      }
    }
  }

  clear() {
    this.driver.clearSync();
  }
}
