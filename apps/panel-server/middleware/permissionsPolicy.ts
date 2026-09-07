const DENIED_FEATURES = [
  "camera",
  "microphone",
  "geolocation",
  "usb",
  "midi",
  "payment",
  "picture-in-picture",
  "publickey-credentials-get",
  "screen-wake-lock",
  "sync-xhr",
  "interest-cohort", // FLoC opt-out; harmless to keep even now FLoC is retired.
] as const;

const POLICY_VALUE = DENIED_FEATURES.map((feature) => `${feature}=()`).join(
  ", ",
);

interface HeaderResponse {
  setHeader(name: string, value: string): void;
}

export function permissionsPolicy(): (
  req: unknown,
  res: HeaderResponse,
  next: () => void,
) => void {
  return (_req, res, next) => {
    res.setHeader("Permissions-Policy", POLICY_VALUE);
    next();
  };
}
