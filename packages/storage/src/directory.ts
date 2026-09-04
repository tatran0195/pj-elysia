import { basename } from 'node:path';

export class DriveDirectory {
  isFile = false;
  isDirectory = true;
  name: string;

  constructor(public prefix: string) {
    this.name = basename(this.prefix);
  }
}

export { DriveDirectory as StorageDirectory };
