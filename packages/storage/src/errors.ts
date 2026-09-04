export class StorageException extends Error {
  code: string;

  constructor(message: string, code: string, options?: ErrorOptions) {
    super(message, options);
    this.name = this.constructor.name;
    this.code = code;
  }
}

export function createError<Args extends unknown[] = []>(template: string, code: string) {
  return class extends StorageException {
    constructor(args?: Args, options?: ErrorOptions) {
      let formatted = template;
      if (args && args.length > 0) {
        let i = 0;
        formatted = template.replace(/%s/g, () => String(args[i++] ?? ''));
      }
      super(formatted, code, options);
    }
  };
}

export const E_CANNOT_WRITE_FILE = createError<[key: string]>(
  'Cannot write file at location "%s"',
  'E_CANNOT_WRITE_FILE',
);

export const E_CANNOT_READ_FILE = createError<[key: string]>(
  'Cannot read file from location "%s"',
  'E_CANNOT_READ_FILE',
);

export const E_CANNOT_DELETE_FILE = createError<[key: string]>(
  'Cannot delete file at location "%s"',
  'E_CANNOT_DELETE_FILE',
);

export const E_CANNOT_DELETE_DIRECTORY = createError<[key: string]>(
  'Cannot delete directory at location "%s"',
  'E_CANNOT_DELETE_DIRECTORY',
);

export const E_CANNOT_COPY_FILE = createError<[source: string, destination: string]>(
  'Cannot copy file from "%s" to "%s"',
  'E_CANNOT_COPY_FILE',
);

export const E_CANNOT_MOVE_FILE = createError<[source: string, destination: string]>(
  'Cannot move file from "%s" to "%s"',
  'E_CANNOT_MOVE_FILE',
);

export const E_CANNOT_CHECK_FILE_EXISTENCE = createError<[key: string]>(
  'Unable to check existence for file at location "%s"',
  'E_CANNOT_CHECK_FILE_EXISTENCE',
);

export const E_CANNOT_GET_METADATA = createError<[key: string]>(
  'Unable to retrieve metadata of file at location "%s"',
  'E_CANNOT_GET_METADATA',
);

export const E_CANNOT_SET_VISIBILITY = createError<[key: string]>(
  'Unable to set visibility for file at location "%s"',
  'E_CANNOT_SET_VISIBILITY',
);

export const E_CANNOT_GENERATE_URL = createError<[key: string]>(
  'Cannot generate URL for file at location "%s"',
  'E_CANNOT_GENERATE_URL',
);

export const E_UNALLOWED_CHARACTERS = createError<[key: string]>(
  'The key "%s" has unallowed characters',
  'E_UNALLOWED_CHARACTERS',
);

export const E_INVALID_KEY = createError<[key: string]>(
  'Invalid key "%s". After normalization results in an empty string',
  'E_INVALID_KEY',
);

export const E_PATH_TRAVERSAL_DETECTED = createError<[key: string]>(
  'Path traversal segment detected in key "%s"',
  'E_PATH_TRAVERSAL_DETECTED',
);

export const E_RANGE_UNSATISFIABLE = createError<[key: string]>(
  'The specified range is invalid or exceeds the file size for "%s"',
  'E_RANGE_UNSATISFIABLE',
);
