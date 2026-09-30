declare const ARGUS_LUA_B64: string;

export function getEmbeddedArgusLua(): string | null {
  return typeof ARGUS_LUA_B64 !== "undefined" && ARGUS_LUA_B64
    ? Buffer.from(ARGUS_LUA_B64, "base64").toString("utf8")
    : null;
}
