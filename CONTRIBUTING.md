# Contributing to better-zcp

Thanks for helping improve better-zcp. Small, focused pull requests are easiest
to review and safest to merge.

## Development setup

Requirements: Node.js 22 or newer and the pinned pnpm version from
`package.json`.

```bash
corepack enable
corepack install
pnpm install
pnpm dev
```

Before opening a pull request, run the checks relevant to your change:

```bash
pnpm lint:server
pnpm --filter pz-server-manager-client lint
pnpm --filter pz-server-manager-client typecheck
pnpm test
pnpm build
```

## Pull requests

- Explain the user-visible or maintenance problem being solved.
- Keep unrelated cleanup out of feature and bug-fix pull requests.
- Add or update tests when behavior changes.
- Update user-facing documentation when commands, configuration, or support
  behavior changes.
- Never commit credentials, private logs, database files, or generated build
  output.

## Licensing

better-zcp is distributed under the GNU Affero General Public License,
version 3 only (AGPL-3.0-only). By contributing, you agree that your
contribution is licensed under the same terms. Existing upstream and
third-party notices remain in effect.

Please report security vulnerabilities privately as described in
[`SECURITY.md`](SECURITY.md).
