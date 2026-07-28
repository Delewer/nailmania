import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

export function listBundleFiles(directory) {
  if (!existsSync(directory) || !statSync(directory).isDirectory()) {
    throw new Error(`Release bundle directory does not exist: ${directory}`);
  }

  const files = [];
  const visit = (currentDirectory) => {
    for (const entry of readdirSync(currentDirectory, { withFileTypes: true })) {
      const absolute = path.join(currentDirectory, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile()) files.push(absolute);
      else throw new Error(`Release bundle contains an unsupported filesystem entry: ${absolute}`);
    }
  };
  visit(directory);
  files.sort((left, right) => left.localeCompare(right));
  return files;
}

export function releaseBundleDigest(directory) {
  const files = listBundleFiles(directory);
  const digest = createHash('sha256');
  for (const file of files) {
    digest.update(path.relative(directory, file).replaceAll('\\', '/'));
    digest.update('\0');
    digest.update(createHash('sha256').update(readFileSync(file)).digest('hex'));
    digest.update('\n');
  }
  return {
    files,
    bundleSha256: digest.digest('hex'),
  };
}
