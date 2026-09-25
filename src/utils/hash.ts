import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Streams file content and returns its deterministic SHA-256 hash hex string.
 * Does not buffer the entire file into memory.
 */
export function hashFile(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = fs.createReadStream(filePath);

    stream.on('data', (chunk) => {
      hash.update(chunk);
    });

    stream.on('end', () => {
      resolve(hash.digest('hex'));
    });

    stream.on('error', (err) => {
      reject(err);
    });
  });
}

export interface DirectoryEntryDescriptor {
  relativePath: string;
  type: 'file' | 'directory' | 'symlink' | 'other';
  size?: number;
  contentHash?: string;
  symlinkTarget?: string;
}

/**
 * Recursively collects deterministic structural and content information for a directory.
 * Symlinks are never traversed or followed outside the directory tree.
 */
export async function collectDirectoryEntries(
  rootDir: string,
  currentSubDir = '',
): Promise<DirectoryEntryDescriptor[]> {
  const targetDir = currentSubDir ? path.join(rootDir, currentSubDir) : rootDir;
  let dirents: fs.Dirent[];

  try {
    dirents = await fs.promises.readdir(targetDir, { withFileTypes: true });
  } catch (err) {
    throw new Error(
      `Failed to read directory '${targetDir}': ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // Stable sort dirents by name
  dirents.sort((a, b) => a.name.localeCompare(b.name));

  const entries: DirectoryEntryDescriptor[] = [];

  for (const dirent of dirents) {
    const relativeEntryPath = currentSubDir ? `${currentSubDir}/${dirent.name}` : dirent.name;
    const fullEntryPath = path.join(rootDir, relativeEntryPath);

    if (dirent.isSymbolicLink()) {
      const symlinkTarget = await fs.promises.readlink(fullEntryPath);
      entries.push({
        relativePath: relativeEntryPath,
        type: 'symlink',
        symlinkTarget,
      });
      // Do NOT follow symlinks into directories
      continue;
    }

    if (dirent.isDirectory()) {
      entries.push({
        relativePath: relativeEntryPath,
        type: 'directory',
      });
      // Recurse into subdirectory
      const nestedEntries = await collectDirectoryEntries(rootDir, relativeEntryPath);
      entries.push(...nestedEntries);
      continue;
    }

    if (dirent.isFile()) {
      const stat = await fs.promises.lstat(fullEntryPath);
      const contentHash = await hashFile(fullEntryPath);
      entries.push({
        relativePath: relativeEntryPath,
        type: 'file',
        size: stat.size,
        contentHash,
      });
      continue;
    }

    entries.push({
      relativePath: relativeEntryPath,
      type: 'other',
    });
  }

  return entries;
}

/**
 * Computes a deterministic SHA-256 hash for a directory structure and its contents.
 * Symlinks are not followed.
 */
export async function hashDirectory(dirPath: string): Promise<string> {
  const entries = await collectDirectoryEntries(dirPath);

  // Stable sort all entries by relativePath
  entries.sort((a, b) => a.relativePath.localeCompare(b.relativePath));

  const hash = createHash('sha256');

  for (const entry of entries) {
    const record = [
      entry.relativePath,
      entry.type,
      entry.size ?? 0,
      entry.contentHash ?? '',
      entry.symlinkTarget ?? '',
    ].join(':');

    hash.update(record + '\n');
  }

  return hash.digest('hex');
}

/**
 * Deterministically hashes a file, directory, or symlink target at targetPath.
 */
export async function hashPath(targetPath: string): Promise<string> {
  const stat = await fs.promises.lstat(targetPath);

  if (stat.isSymbolicLink()) {
    const target = await fs.promises.readlink(targetPath);
    return createHash('sha256').update(`symlink:${target}`).digest('hex');
  }

  if (stat.isDirectory()) {
    return hashDirectory(targetPath);
  }

  return hashFile(targetPath);
}
