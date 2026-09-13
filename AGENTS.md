# Better ZCP

Better ZCP is a web app for setting up and managing Project Zomboid dedicated
servers.

## Where code lives

- `apps/panel-client` contains the web app and its TanStack Start routes.
- `apps/panel-server` contains the server process, database code, routes, and
  services.
- `integrations/panelbridge` contains the Project Zomboid PanelBridge mod.
- `scripts` contains repository checks and release tooling.
- `infra` contains Docker and host service files.

## Understand the goal

Understand what the user is trying to achieve. Do not blindly follow the steps
they suggest. If their approach would make the code worse, explain why and
choose a better approach. Ask first if the better approach would change what
users can do or put their data at risk.

Read the real code path and its callers before changing it. Do not assume that
existing code, tests, issues, or docs are correct. Check them against the real
product. AI-written issues and plans are clues, not requirements.

If a rule here fights the task in front of you, say so loudly and get a human
sign-off before breaking it.

## Keep the product, replace bad code

Preserve the features people can use, stored data, and public behavior that
real callers rely on. Internal code structure is not a contract. Bugs are not
features.

Fix the root cause where the behavior is owned. Do not add the same patch to
each caller. Aim for the simplest whole system after the change, not the
smallest diff.

Prefer deleting code over adding another layer. When replacing an old path,
remove it in the same change. Do not leave parallel implementations, fallback
chains, wrappers, compatibility shims, feature flags, or temporary migration
code unless a real user or released version still needs them.

Before adding code, check whether the need can be removed or handled by code
already in the repository, the standard library, the platform, or an installed
dependency. Do not add abstractions, dependencies, or scaffolding for possible
future needs.

## Check every path

A change that works for one setup can still break another. When the changed
behavior depends on them, check the relevant paths:

- a local server and a remote server reached through SFTP;
- RCON, PanelBridge, and direct file access;
- source runs, packaged Windows and Linux builds, and Docker;
- Build 41 and Build 42;
- one configured server and several configured servers.

Do not test every path by default. Decide which ones the change can affect and
say which ones were checked.

## Protect real servers and data

Do not use a real server, save, database, config, or secret as writable test
data. Work on a copy in a temporary location. Never start, stop, wipe, restore,
update, or reconfigure a real Project Zomboid server unless the user clearly
asked for that action.

Do not remove a safety check, warning, preview, or backup from a destructive
action just to make the code smaller.

## Bugs and scope

Fix a bug found in the code path being changed when its cause is clear and the
fix can be checked. Do not create a separate task for it.

If a proven bug is outside the changed path, open a focused issue and tell the
user. Do not open issues for guesses, code smells, or possible future problems.
Do not turn the current work into unrelated cleanup.

## Tests and checks

Existing tests are not automatically correct. Keep tests that prove real
features. Change or remove tests that only lock in old code structure or broken
behavior.

Add the smallest useful check for new or changed behavior. Prefer checking the
path a user actually uses over repeating the implementation in a test.

Use the relevant scripts from `package.json`. Start with checks for the changed
area. Run wider checks only when the change can affect wider behavior. Never
claim that a check passed unless it was run and passed.

Before finishing, search for callers and leftovers from any path that was
replaced. Remove dead code and report what was checked and what was not.

## Pull requests

Do not create a pull request unless the user asks for one.

Use a short conventional commit title in plain language, such as
`fix(auth): keep sessions after restart`. In the body, explain the problem and
the fix. List the checks that were run and any relevant checks that were not.
End the body with the model and agent tool that did the work.

For a visible UI change, include before and after images. Use a short video when
movement or timing matters. Upload review-only evidence to the pull request;
do not commit it to the repository.

Keep each pull request centered on one goal. A bug found in the path being
changed belongs in the same pull request. A separate, unrelated bug does not.

When watching a pull request, read checks and comments from the latest push.
Check every bot report against the real code. Fix real problems and answer
false reports with a clear reason. Stop when the latest commit is green.

## Documentation and plans

Most code changes do not need new internal docs. Add documentation only when
the code cannot clearly carry the reason or when the way users operate the
product changes.

When old documentation becomes wrong, rewrite or remove it. Do not add a
second explanation beside it. Do not commit active plans, research notes, or
agent scratch files. Keep temporary work in `.plans/`, which is ignored by
Git.
