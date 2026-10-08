# Panel client

The web app. React 19, TanStack Router and Query, Tailwind 4 and coss ui on
Base UI.

## Design system

- `src/components/ui` holds the coss ui components. Build screens from them.
  Add a missing one with the coss registry (`components.json`), and change
  these files only to fix a real bug for every caller.
- `src/styles/tokens.css` holds the raw colors and radius for light and dark.
  `src/styles/theme.css` turns them into Tailwind utilities. Use those
  utilities. Lint rejects arbitrary colors such as `bg-[#123456]`.
- Colors carry meaning: success, warning, destructive and info are statuses.
  Everything else stays neutral.
- `src/styles/utilities.css` is for the few utilities Tailwind can't express.
  Don't add page CSS files or global selectors.
- Shared app pieces live in `src/components`: `PageHeader`, `EmptyState`,
  `DisabledReason`, `PasswordInput`, `HelpTip`, `settings-layout`.

## Pages

Each page lives in `src/pages/<name>/` with its route in `src/routes`. Keep
tab and view state in typed search params (`validateSearch`) so links work.
Server data goes through `lib/api.ts` and React Query. Each selected server
has its own query client, so switching servers swaps the cache.

## Checking UI changes

`pnpm screenshots <label> --routes=/console,/console@Commands` captures
routes in demo mode, light and dark, desktop and phone, into `.screenshots/`.
Demo data lives in `src/lib/demo.ts`. Add to it when a page needs data to
render.
