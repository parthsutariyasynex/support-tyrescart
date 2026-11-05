// A small list kept in one JSON file instead of the database (the vehicle form's tyre sizes and custom makes / models /
// years). The file is the only source of truth: it is read on every request and changes are written back to it, so
// they stay after a restart and hand edits are picked up.
//
// Writes run one at a time (this server is a single process, see ecosystem.config.cjs), each re-reading the file first
// so nothing saved meanwhile is lost, and replace the file atomically (temp file + rename) so a crash mid-write never
// leaves half a file. A file that can't be read or parsed is reported and never overwritten.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { AppError } from './errors.js';
import { logEvent } from './logging.js';

export type JsonStore<T> = {
  read: () => Promise<T>;
  // Reads the current contents, lets `change` decide (throw to refuse), writes `next` when given
  update: <R>(change: (current: T) => { next?: T; result: R }) => Promise<R>;
};

export function jsonStore<T>(options: {
  file: () => string; // resolved against the server's folder
  empty: () => T; // a missing file: nothing saved yet (the first change creates it)
  parse: (data: unknown) => T; // throws when the contents aren't the expected shape
  serialize?: (data: T) => unknown; // what goes in the file (default: the data itself)
  what: string; // for messages and logs, e.g. "tyre size list"
  event: string; // log event prefix, e.g. "tyre_sizes"
}): JsonStore<T> {
  const file = () => path.resolve(options.file());

  async function read(): Promise<T> {
    const f = file();
    let text: string;
    try {
      text = await fs.readFile(f, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return options.empty();
      void logEvent({ level: 'ERROR', category: 'system', event: `${options.event}.read_failed`, message: `Couldn't read ${f}: ${(err as Error).message}` });
      throw new AppError(`Couldn't load the ${options.what}. Try again.`, 500, 'LIST_FILE_UNAVAILABLE');
    }
    try {
      return options.parse(JSON.parse(text));
    } catch (err) {
      void logEvent({ level: 'ERROR', category: 'system', event: `${options.event}.invalid_file`, message: `${f} is not valid: ${(err as Error).message}` });
      throw new AppError(`The ${options.what} file is damaged. Ask an admin to fix it.`, 500, 'LIST_FILE_INVALID');
    }
  }

  async function write(data: T) {
    const f = file();
    const temp = `${f}.${process.pid}.${Date.now()}.tmp`;
    try {
      await fs.mkdir(path.dirname(f), { recursive: true });
      await fs.writeFile(temp, `${JSON.stringify(options.serialize ? options.serialize(data) : data, null, 2)}\n`, 'utf8');
      await fs.rename(temp, f); // atomic: readers see the old file or the new one, never half of it
    } catch (err) {
      await fs.rm(temp, { force: true }).catch(() => {});
      void logEvent({ level: 'ERROR', category: 'system', event: `${options.event}.write_failed`, message: `Couldn't save ${f}: ${(err as Error).message}` });
      throw new AppError(`Couldn't save to the ${options.what}. Try again.`, 500, 'LIST_FILE_UNAVAILABLE');
    }
  }

  // One change at a time: two people adding at the same moment both end up in the file
  let queue: Promise<unknown> = Promise.resolve();
  function update<R>(change: (current: T) => { next?: T; result: R }): Promise<R> {
    const task = async () => {
      const { next, result } = change(await read());
      if (next !== undefined) await write(next);
      return result;
    };
    const run = queue.then(task, task);
    queue = run.catch(() => {});
    return run;
  }

  return { read, update };
}

// A list of names from a file, cleaned: strings only, trimmed, each once (by `key`), in the file's order
export function cleanList(list: unknown, key: (s: string) => string): string[] {
  if (!Array.isArray(list)) return [];
  const seen = new Set<string>();
  return list
    .filter((s): s is string => typeof s === 'string' && !!s.trim())
    .map((s) => s.trim())
    .filter((s) => (seen.has(key(s)) ? false : (seen.add(key(s)), true)));
}
