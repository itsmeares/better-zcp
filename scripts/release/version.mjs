const RELEASE_IDENTIFIER = "(?:0|[1-9]\\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)";

export const RELEASE_VERSION_PATTERN = new RegExp(
  `^(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)(?:-${RELEASE_IDENTIFIER}(?:\\.${RELEASE_IDENTIFIER})*)?$`,
);

export function isValidReleaseVersion(value) {
  return typeof value === "string" && RELEASE_VERSION_PATTERN.test(value);
}
