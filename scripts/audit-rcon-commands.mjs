import fs from "fs";
import path from "path";

const root = path.resolve(process.argv[2] || ".");
const supportedFile = process.argv[3];

const SKIP_DIRS = new Set(["tests", "node_modules", "__fixtures__", "data", "database"]);

function collectJsFiles(dir, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      collectJsFiles(path.join(dir, entry.name), out);
    } else if (entry.isFile() && (entry.name.endsWith(".js") || entry.name.endsWith(".ts"))) {
      out.push(path.join(dir, entry.name));
    }
  }
  return out;
}

const serverDir = path.join(root, "apps/panel-server");
const files = collectJsFiles(serverDir, []);

const pattern = /execute\w*\(\s*[`"']([a-zA-Z]+)/g;

const found = new Map();
for (const file of files) {
  const text = fs.readFileSync(file, "utf8");
  for (const m of text.matchAll(pattern)) {
    const rel = path.relative(root, file).replace(/\\/g, "/");
    if (!found.has(m[1])) found.set(m[1], rel);
  }
}

const varPattern = /(?:let|const)\s+(\w+)\s*=\s*[`"']([a-zA-Z]+)/g;
for (const file of files) {
  const text = fs.readFileSync(file, "utf8");
  for (const m of text.matchAll(varPattern)) {
    const [, varName, word] = m;
    if (found.has(word)) continue;
    if (new RegExp(`execute\\w*\\(\\s*${varName}\\b`).test(text)) {
      const rel = path.relative(root, file).replace(/\\/g, "/");
      found.set(word, rel);
    }
  }
}

const MIN_COMMANDS = 20;
if (found.size < MIN_COMMANDS) {
  console.error(
    `ERROR: found only ${found.size} distinct command(s) across apps/panel-server/ ` +
    `(expected at least ${MIN_COMMANDS}). The extraction pattern or the file walk is ` +
    `almost certainly broken -- fix it before trusting this script's output.`,
  );
  process.exit(1);
}

console.log(`panel sends ${found.size} distinct commands (across ${files.length} files scanned under apps/panel-server/)`);

if (!supportedFile) {
  console.log(
    "\nNo supported-commands file given -- printing the panel-side denominator only. " +
    "Pass a real server's `help` RCON output (one command per line) as the 2nd argument " +
    "to check these against what the server actually supports:",
  );
  for (const [command, file] of [...found.entries()].sort()) {
    console.log(`  ${command} (${file})`);
  }
  process.exit(0);
}

const supported = new Set(
  fs
    .readFileSync(supportedFile, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean),
);

const unsupported = [...found.keys()].filter((c) => !supported.has(c)).sort();
const ok = [...found.keys()].filter((c) => supported.has(c)).sort();

console.log(`server reports ${supported.size} commands`);
console.log(`VERIFIED: ${ok.join(", ")}`);
console.log(`NOT IN SERVER COMMAND LIST: ${unsupported.length ? unsupported.map((c) => `${c} (${found.get(c)})`).join(", ") : "none"}`);
