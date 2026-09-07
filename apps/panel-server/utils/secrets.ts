import fs from "node:fs";

export function readSecret(name: string): string | null {
  const filePath = process.env[`${name}_FILE`];
  if (filePath) {
    const value = fs.readFileSync(filePath, "utf8").replace(/\r?\n$/, "");
    if (!value) {
      throw new Error(`${name}_FILE points to an empty secret file`);
    }
    return value;
  }

  return process.env[name] || null;
}
