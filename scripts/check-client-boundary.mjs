#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';

const assetsDir = path.resolve(process.cwd(), 'apps/panel-client/dist/assets');
const forbiddenMarkers = [
  'execSync',
  'DatabaseSync',
  'node:fs',
  'node:child_process',
  'child_process',
  '__executeImplementation',
  '@aws-sdk/client-s3',
  'panel-server/services',
  'process.pkg',
  'node:sqlite',
  'ssh2-sftp-client',
];

function javascriptFiles(directory) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...javascriptFiles(entryPath));
    else if (entry.isFile() && entry.name.endsWith('.js'))
      files.push(entryPath);
  }
  return files;
}

if (!fs.existsSync(assetsDir)) {
  throw new Error(`Client asset directory does not exist: ${assetsDir}`);
}

const findings = [];
const files = javascriptFiles(assetsDir);
for (const file of files) {
  const source = fs.readFileSync(file, 'utf8');
  for (const marker of forbiddenMarkers) {
    if (source.includes(marker)) findings.push({ file, marker });
  }
}

if (findings.length > 0) {
  for (const finding of findings) {
    console.error(
      `Client/server boundary marker found: ${finding.marker} in ${path.relative(process.cwd(), finding.file)}`,
    );
  }
  process.exitCode = 1;
} else {
  console.log(
    `Client boundary passed: ${files.length} browser JavaScript assets scanned`,
  );
}
