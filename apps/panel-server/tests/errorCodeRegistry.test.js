import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { ErrorCode } from "../utils/errorCodes.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = path.join(__dirname, "..");

const CODE_LITERAL_RE = /\bcode:\s*(["'])([^"']+)\1/g;

function listServerFiles(dir) {
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".js") || f.endsWith(".ts"))
    .map((f) => path.join(dir, f));
}

const SCANNED_FILES = [
  ...listServerFiles(path.join(SERVER_DIR, "routes")),
  ...listServerFiles(path.join(SERVER_DIR, "services")),
  ...listServerFiles(path.join(SERVER_DIR, "middleware")),
  path.join(SERVER_DIR, "index.js"),
];

function findCodeLiterals() {
  const found = [];
  for (const file of SCANNED_FILES) {
    const source = fs.readFileSync(file, "utf8");
    const relFile = path.relative(SERVER_DIR, file).replace(/\\/g, "/");
    let match;
    CODE_LITERAL_RE.lastIndex = 0;
    while ((match = CODE_LITERAL_RE.exec(source))) {
      const line = source.slice(0, match.index).split("\n").length;
      found.push({ file: relFile, line, value: match[2] });
    }
  }
  return found;
}

const CODE_MEMBER_RE = /\bErrorCode\.([A-Z][A-Z0-9_]*)\b/g;

function findMemberReferences() {
  const found = new Set();
  for (const file of SCANNED_FILES) {
    const source = fs.readFileSync(file, "utf8");
    let match;
    CODE_MEMBER_RE.lastIndex = 0;
    while ((match = CODE_MEMBER_RE.exec(source))) {
      found.add(match[1]);
    }
  }
  return found;
}

const KNOWN_INTENTIONALLY_UNREFERENCED = new Set([
  "WRITABLE_PATH_ERROR",
  "DIRECTORY_READ_FAILED",
  "RCON_CONNECT_FAILED",
]);

const KNOWN_CLIENT_ONLY_LOCALE_KEYS = new Set([
  // apps/panel-client/src/lib/errorMessage.ts's wrapUncodedServerError() wraps ANY
  // ApiError with status >= 500 and no code that resolves to a registered
  // translation (2026-08-26: the panelBridge.js/server.ts generic
  // catch-all convention -- uncoded 500s stay uncoded by design). It
  // exists for every route file's uncoded catch-all at once, so unlike
  // every other entry in this registry it has no single server call site
  // to point at.
  "UNEXPECTED_SERVER_ERROR",
]);

describe("server error codes: registry membership (structure, not meaning)", () => {
  it("every `code:` literal used in apps/panel-server/routes, apps/panel-server/services, apps/panel-server/middleware and apps/panel-server/index.js is a registered ErrorCode value", () => {
    const registryValues = new Set(Object.values(ErrorCode));
    const literals = findCodeLiterals();
    const unregistered = literals.filter((l) => !registryValues.has(l.value));

    expect(
      unregistered,
      unregistered.length
        ? `Found ${unregistered.length} code literal(s) not in apps/panel-server/utils/errorCodes.ts -- ` +
            "add each one to the ErrorCode registry (with a comment saying where " +
            "it's used) instead of leaving it a bare string literal:\n" +
            unregistered
              .map((l) => `  ${l.file}:${l.line} -> "${l.value}"`)
              .join("\n")
        : "",
    ).toEqual([]);
  });

  it("sanity check: the scan actually finds the codes known to exist today (guards against the regex silently matching nothing)", () => {
    const literals = findCodeLiterals();
    expect(literals.length).toBeGreaterThan(20);
    expect(literals.map((l) => l.value)).toContain("SETUP_TOKEN_REQUIRED");
    expect(literals.map((l) => l.value)).toContain("server_running");
  });

  it("every registered ErrorCode value is referenced at least once (as a `code:` literal or an `ErrorCode.NAME` member access) in apps/panel-server/routes, apps/panel-server/services, apps/panel-server/middleware or apps/panel-server/index.js", () => {
    const literalValues = new Set(findCodeLiterals().map((l) => l.value));
    const memberNames = findMemberReferences();

    const unused = Object.keys(ErrorCode).filter(
      (name) =>
        !KNOWN_INTENTIONALLY_UNREFERENCED.has(name) &&
        !memberNames.has(name) &&
        !literalValues.has(ErrorCode[name]),
    );

    expect(
      unused,
      unused.length
        ? `${unused.length} ErrorCode entr(y/ies) registered but never emitted: ${unused.join(", ")}. ` +
            "Remove from errorCodes.ts and its locale entries, or wire it up. If it's " +
            "intentionally kept (e.g. split into narrower variants), add it to " +
            "KNOWN_INTENTIONALLY_UNREFERENCED above with a comment explaining why, the " +
            "way WRITABLE_PATH_ERROR and DIRECTORY_READ_FAILED already are."
        : "",
    ).toEqual([]);
  });

  const localeEnPath = path.join(
    SERVER_DIR,
    "..",
    "client",
    "src",
    "locales",
    "en",
    "errors.json",
  );

  if (fs.existsSync(localeEnPath)) {
    it("every registered ErrorCode has a matching key in apps/panel-client/src/locales/en/errors.json", () => {
      const localeKeys = new Set(
        Object.keys(JSON.parse(fs.readFileSync(localeEnPath, "utf8"))),
      );
      const missing = Object.keys(ErrorCode).filter(
        (name) => !localeKeys.has(name),
      );

      expect(
        missing,
        missing.length
          ? `apps/panel-client/src/locales/en/errors.json is missing an entry for: ${missing.join(", ")}. ` +
              "The locale key is the ErrorCode CONSTANT NAME, not its wire value " +
              "(see apps/panel-server/utils/errorCodes.ts for why those two differ for the " +
              "legacy codes)."
          : "",
      ).toEqual([]);
    });

    it("every key in apps/panel-client/src/locales/en/errors.json is a registered ErrorCode value (no stale entries for a removed/renamed code)", () => {
      const localeKeys = Object.keys(
        JSON.parse(fs.readFileSync(localeEnPath, "utf8")),
      );
      const registryNames = new Set(Object.keys(ErrorCode));
      const stale = localeKeys.filter(
        (key) =>
          !registryNames.has(key) && !KNOWN_CLIENT_ONLY_LOCALE_KEYS.has(key),
      );

      expect(
        stale,
        stale.length
          ? `apps/panel-client/src/locales/en/errors.json has entries for removed/renamed codes: ${stale.join(", ")}`
          : "",
      ).toEqual([]);
    });
  } else {
    it.skip(
      "every registered ErrorCode has a matching key in apps/panel-client/src/locales/en/errors.json -- " +
        "SKIPPED: apps/panel-client/src/locales/en/errors.json does not exist yet. This test starts " +
        "enforcing automatically the moment that file is created; no change needed here.",
      () => {},
    );
    it.skip(
      "every key in apps/panel-client/src/locales/en/errors.json is a registered ErrorCode value -- " +
        "SKIPPED: apps/panel-client/src/locales/en/errors.json does not exist yet. This test starts " +
        "enforcing automatically the moment that file is created; no change needed here.",
      () => {},
    );
  }
});
