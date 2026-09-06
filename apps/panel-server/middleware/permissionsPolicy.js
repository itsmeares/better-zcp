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
];

const POLICY_VALUE = DENIED_FEATURES.map((feature) => `${feature}=()`).join(
  ", ",
);

export function permissionsPolicy() {
  return (req, res, next) => {
    res.setHeader("Permissions-Policy", POLICY_VALUE);
    next();
  };
}
