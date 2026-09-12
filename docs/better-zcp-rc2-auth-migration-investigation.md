# Better ZCP rc2 auth and migration investigation

Date: 2026-09-12
Version reviewed: `2.0.0-rc2` (`f1b39d15`)
Scope: user screenshots, current source, release build, and an isolated local run

## Conclusion

This is a confirmed application defect in the rc2 HTTP/authentication flow. The
screenshots do not indicate that the login credentials are wrong, or that the
Project Zomboid servers were deleted.

The first authentication check is a TanStack Start server-function request. In
the affected browser flow it receives neither `Sec-Fetch-Site`, `Origin`, nor
`Referer`. TanStack Start's default CSRF middleware therefore returns `403
Forbidden` before the auth-status function runs.

The client then hides that failure. `AuthContext` catches every bootstrap error
and sets `authEnabled: false` (`apps/panel-client/src/contexts/AuthContext.tsx:74-137`).
The app interprets that state as “authentication is disabled,” skips the Login
screen, and renders the dashboard (`apps/panel-client/src/App.tsx:477-500`).
Subsequent protected requests have no token and correctly return `401`, which
produces the error storm shown in the screenshots.

In short:

```text
Start auth check → 403 CSRF rejection
                 → client treats failure as auth disabled
                 → Login is skipped
                 → protected API/server-function calls have no token
                 → 401s, offline indicators, and connection error
```

## Evidence

### User screenshots

The supplied screenshots show:

- `http://192.168.0.25:3004`, UI `v2.0.0-rc2`.
- Repeated `GET /_serverFn/... 403 (Forbidden)` responses.
- `GET /api/panel/update-status 401`, `GET /api/server/update-check/status 401`,
  and `GET /api/server/console-log/error-count 401`.
- The dashboard shell is visible, but there is no Login or Setup screen.
- “No server configured” and offline badges are displayed.
- The `Permissions-Policy` warnings for `interest-cohort` and
  `attribution-reporting` are browser compatibility warnings, not the cause of
  the authentication failure.

The `fe7ba392...` server-function request in the screenshots maps to the
client's `getAuthStatus` function in the generated rc2 build.

### Local release-build reproduction

I built the current rc2 client and ran the panel against an isolated temporary
data directory. No user data or Project Zomboid server directory was used.

| Request | Result |
| --- | --- |
| `GET /api/auth/status` | `200`; the public API route is reachable |
| `GET /_serverFn/fe7ba392...` with only `x-tsr-serverFn: true` | `403 Forbidden`, body `Forbidden` |
| Same server function with `Sec-Fetch-Site: same-origin` | `200` |
| Same server function with a same-origin `Referer` | `200` |

I also loaded the release build in a browser. The native HTTP proxy observed
the server-function requests arriving without `Origin`, `Referer`, or
`Sec-Fetch-Site`, matching the failing condition in the screenshot.

As a controlled check, a temporary proxy changed only the response's
`Referrer-Policy` to `strict-origin-when-cross-origin` and preserved the
external host. The public auth server function changed from `403` to `200`,
while protected functions changed from `403` to the expected `401`. This
isolates the failure to the Start CSRF/header boundary rather than the
database, RCON, or server profiles.

### Code path

- `apps/panel-client/src/lib/serverAuth.ts:39-47` invokes `getAuthStatus` as a
  Start server function.
- `apps/panel-client/src/lib/serverAuth.server.ts:372-384` contains the public
  auth-status implementation; it is not supposed to require a logged-in user.
- `apps/panel-server/http/panelWeb.ts:301` sends `Referrer-Policy: no-referrer`.
  The same handler forwards `/_serverFn/` requests to TanStack Start at
  `apps/panel-server/http/panelWeb.ts:602-620`.
- The generated rc2 Start server bundle applies the default CSRF middleware to
  server functions. It accepts same-origin `Sec-Fetch-Site`, `Origin`, or
  `Referer`; when none is present it returns `403`.
- Public API equivalents still exist in
  `apps/panel-server/http/startApiDispatcher.ts:74-89`, including
  `/api/auth/status`, `/api/auth/oidc/status`, and `/api/auth/recovery-status`.

## Why migration history matters

The current behavior is the result of two migration changes interacting:

1. `fbeb1276` originally moved auth status to TanStack Start but added a
   fallback to the public `/api/auth/status` endpoint.
2. `74d6afa3` (“finish sqlite cutover and remove api fallbacks”) removed that
   fallback and changed `AuthContext` to call the Start function directly. It
   also removed the equivalent OIDC, recovery, and current-user fallbacks.
3. `6a34928b` (“make TanStack Start the sole HTTP owner”) introduced the native
   HTTP host and its `no-referrer` security header.

The fallback removal did not create the CSRF rejection, but it removed the
existing recovery path. The native header and Start CSRF behavior then became a
blocking failure for this browser/request shape.

## Data migration assessment

The database migration is a separate risk, but it cannot be diagnosed reliably
until the auth bootstrap works.

The rc2 default is SQLite at `data/db.sqlite`. An older `data/db.json` is not
silently imported or replaced. The repository documentation requires an
explicit importer, or temporary startup with `PANEL_DATABASE_DRIVER=json`.
The active data directory is resolved from the executable location and
`paths.config.json` (`apps/panel-server/utils/paths.ts:14-19,64-77`). Two
installations can therefore point at different panel databases even when the
Project Zomboid server folders are unchanged.

The dashboard's “No server configured” message is not proof that the server
profiles were lost: the failing unauthenticated requests prevent the client
from reading them. After the transport fix, `/api/auth/status` is the useful
check:

- `needsSetup: false` means the selected panel database has users.
- `needsSetup: true` means the selected database is empty/new, or the legacy
  database has not been imported.

## Test results

- `pnpm install --frozen-lockfile`: passed.
- `pnpm --filter @better-zcp/panel-client build`: passed.
- Targeted HTTP/Start tests: 242 passed across 4 files.
- Full server suite: 4,186 passed, 1 failed, 75 skipped. The one failure was
  the unrelated kernel-level `ETXTBSY` timing test in
  `serverManagerJvmExecutableBusy.test.ts`; rerunning the targeted set passed.
- The full client suite was started but stopped after it continued through the
  long-running jsdom tests; it was not used as evidence for or against this
  defect.

Existing tests cover header copying and fake Start handlers, but do not cover a
real generated Start server function through the native handler with the
current `no-referrer` policy. There is also no AuthContext test asserting that
an auth-bootstrap transport failure must not be treated as disabled auth.

## Recommended remediation

1. Fix the shared native Start/CSRF boundary. Configure Start to validate the
   actual same-origin native request, or use a compatible same-origin referrer
   policy. Do not disable CSRF globally or allow arbitrary requests without an
   origin check.
2. Restore a direct public-route fallback (or use the existing public routes
   directly) for auth status, OIDC status, and recovery status. This is a small
   resilience measure and uses routes already present in rc2.
3. Change `AuthContext` so an auth bootstrap failure produces a connection/
   retry state. Only a successful response that says `authEnabled: false` may
   disable authentication.
4. Add a packaged-release smoke test that loads the browser and checks the
   first auth request, plus a client test for the bootstrap-failure state.

## Safe next steps for the installation

Do not uninstall either ZCP copy, delete `data`, wipe a server, or apply a
database import yet.

After a patched build is available:

1. Stop Better ZCP and make a copy of its panel `data` directory, including
   `db.sqlite`, `db.json` if present, `backups`, and secret files.
2. Verify the active `paths.config.json`/data directory for the Better ZCP
   executable rather than assuming it is the old ZCP directory.
3. Check `/api/auth/status` on the panel's actual address.
4. If only `db.json` contains the old users and servers, preview the documented
   JSON-to-SQLite import, then apply it only with the panel stopped. Keep the
   original JSON and backups until the new panel shows the expected profiles.

No user-device files were inspected or changed during this investigation, and
no Project Zomboid process or server data was modified.
