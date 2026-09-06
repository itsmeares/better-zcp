
const ADDUSER_WITH_PASSWORD = /(\badduser\s+"[^"]*")\s+"[^"]*"/gi;

export function redactRconCommandSecrets(text) {
  if (typeof text !== "string") return text;
  return text.replace(ADDUSER_WITH_PASSWORD, '$1 "[REDACTED]"');
}
