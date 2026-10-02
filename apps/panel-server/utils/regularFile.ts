import fs from "node:fs";

export function openRegularFile(file: string, flags = fs.constants.O_RDONLY): number {
  const fd = fs.openSync(file, flags | (fs.constants.O_NOFOLLOW || 0));
  try {
    const opened = fs.fstatSync(fd), current = fs.lstatSync(file);
    if (!opened.isFile() || !current.isFile() || opened.ino !== current.ino || opened.dev !== current.dev) {
      throw new Error("File is not a regular file or changed while opening.");
    }
    return fd;
  } catch (error) { fs.closeSync(fd); throw error; }
}

export function readRegularFile(file: string, limit: number): string {
  const fd = openRegularFile(file);
  try {
    if (fs.fstatSync(fd).size > limit) throw new Error("File exceeds the read limit.");
    const buffer = Buffer.alloc(limit + 1), count = fs.readSync(fd, buffer, 0, buffer.length, 0);
    if (count > limit) throw new Error("File exceeds the read limit.");
    return buffer.subarray(0, count).toString("utf8");
  } finally { fs.closeSync(fd); }
}
