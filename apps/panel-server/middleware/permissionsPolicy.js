// Sets the Permissions-Policy header, disabling browser features this panel
// never uses. Helmet dropped its own Permissions-Policy support (the spec
// was too unstable to keep maintaining), so this is a small standalone
// middleware rather than a helmet option.
//
// Every listed feature is denied to every origin, including this one
// (`=()`, not `=(self)`): the panel has no legitimate use for the camera,
// microphone, geolocation, USB, etc., and denying them outright removes
// that surface from any future page (this one or an XSS-injected one)
// rather than trusting every future contributor to keep re-checking whether
// a new feature was added that needs one of these.
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
