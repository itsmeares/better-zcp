# Jar audit: verify against the real Project Zomboid B42 server

These scripts read the actual game server's own compiled Java classes and
Lua-callable API surface out of its shipped jar, so RCON/console commands
and Lua bridge (PanelBridge) calls can be checked against the shipped bytecode
instead of an external wiki. These are verification tools, not runtime code.

## What you need

A copy of `projectzomboid.jar` from a real B42 dedicated server install
(`<server-install>/java/projectzomboid.jar`). This repo does not ship one --
point every command below at wherever your own copy lives, e.g.:

```
/path/to/server-install/java/projectzomboid.jar
```

No other setup. `unzipper` (already a project dependency) reads the jar
directly; nothing shells out to an external `unzip`/`jar` binary.

## Scripts

### `classfile-parser.mjs`

Not a CLI -- the shared module the command scanners import. Parses a single Java
`.class` file's bytes into `{thisClass, superClass, interfaces, fields,
methods, classAnnotations, constantPool}`, plus a `listMethodRefs()` helper
that resolves every method the class's bytecode calls OUT to (as opposed to
`methods`, which is what the class itself declares). Reads the constant
pool and methods table STRUCTURALLY, per the real JVM class file format --
not a flat "extract printable strings" pass. That distinction is the whole
point: a strings dump mixes real method/field names in with every other
UTF8 constant in the file (log messages, exception text) with no way to
tell them apart afterward; reading the format properly means every name
this returns is a genuine declared method, nothing else.

### `scan-rcon-commands.mjs`

```
node scripts/jar-audit/scan-rcon-commands.mjs <path-to-projectzomboid.jar>
node scripts/jar-audit/scan-rcon-commands.mjs <jar> --json
node scripts/jar-audit/scan-rcon-commands.mjs <jar> --class BanUserCommand
```

Reads every `zombie/commands/serverCommands/*.class` and prints its real
`@CommandName`/`@CommandNames` (the literal RCON keyword -- often NOT the
same as the class name, e.g. `StatisticsCommand` -> `stats`), every
`@CommandArgs`/`@AltCommandArgs` variant (exact required/optional argument
shape), whether it's `@DisabledCommand` in this build, and its
`@RequiredCapability`. This is what caught `godmod`/`invisible` silently
targeting the wrong command, `kickuser`'s missing `-r` flag, and confirmed
`releasesafehouse` is unconditionally refused over RCON/console.

### `classify-response-shapes.mjs`

```
node scripts/jar-audit/classify-response-shapes.mjs <path-to-projectzomboid.jar>
```

Attempts to flag which of the ~44 commands `server/services/rcon.js` sends
return an informative reply (a list, a dump) versus an empty/short
acknowledgement, using ONLY the presence of `java.util.Iterator`/
`List`/`Map` enumeration calls in the class's constant pool as a signal.

**Read the "What this cannot tell you" section below before trusting this
one's output.** It correctly flagged the 3 commands already known to be
informative (`players`, `showoptions`, `stats`) and nothing else with
confidence. It also flagged one extra command (`reloadlua`), which turned out
on manual inspection to be a plausible
false positive (the loop is list housekeeping, not reply-building), and why
that one counter-example is reason enough not to trust this signal at
scale without hand-checking each hit.

### `scan-lua-calls.mjs` -- not included as a generic tool, see below

The PanelBridge Lua checker used for the Lua audit is NOT a clean, reusable
CLI the way the two RCON scripts are -- it depends on a hand-curated
`RECEIVER_CLASSES` map built by reading `pz-mod/PanelBridge/media/lua/
server/PanelBridge.lua`'s own variable assignments (e.g. knowing that the
Lua local `climate` came from `getClimateManager()`, which is
`zombie.iso.weather.ClimateManager`). That map goes stale the moment new
receiver variable names show up in the Lua file, and this repo doesn't
currently have a generic Lua-static-analysis pass that could rebuild it
automatically. If this needs to run again, rebuild the receiver map by hand
against the Lua file at that time using `classfile-parser.mjs` as the
verification half -- the pattern is documented in
  the audit notes, not shipped as a ready-to-run script,
because a stale receiver map that still runs without error is worse than
no script at all.

## What this technique CANNOT tell you

This is the main limitation:

**A method not found under one class is not proof the method doesn't
exist.** The first Lua-audit pass checked one class per receiver and got
47 "not found" out of 147 -- a third of the bridge looking broken. Nearly
all of those were checking the wrong link in the chain:

- **Interfaces carry methods too, not just superclasses.** B42's
  `SandboxOption` is an *interface* (metadata: name/tooltip/page)
  implemented by five concrete option classes, each of which ALSO extends
  a same-named `zombie.config.*ConfigOption` class (value/min/max/default).
  Checking only the declared/interface side, or only the superclass side,
  misses half the real method surface.
- **A method declared three superclasses up is still real.** `IsoPlayer`
  doesn't declare `getX()`/`setX()`/`sendObjectChange()` itself -- they're
  on `IsoMovingObject` and `IsoObject`, several levels up. `classInfo.
  superClass` gives you the next link; you have to walk it yourself, and
  there is no bound on how far up a given method actually lives.
- **A Lua receiver's *declared* return type is not always its *runtime*
  type.** `SandboxOptions.getOptionByIndex()` is declared to return the
  base `SandboxOption`, but the real object handed to Lua is always one of
  the five concrete subclasses (Java polymorphism) -- checking the base
  class alone gives a false negative for every value-accessor method.
- **This parser reads structure, not behavior.** It can tell you a method
  named `X` is declared on class `Y` with a given descriptor. It CANNOT
  tell you what a method's argument types actually resolve to for overload
  purposes, what it does when called, what it returns, or whether Lua's
  dynamic dispatch will actually reach it for a given runtime object (see
  `classify-response-shapes.mjs`'s honest limits above, and the Lua audit's
  4 `UNRESOLVED_RECEIVER` findings -- a square's content object is one of
  many `IsoObject` subclasses knowable only at runtime, and no static read
  of the jar can settle that).
- **Proving what a method RETURNS needs real bytecode decoding, not
  annotations or constant-pool presence.** `classify-response-shapes.mjs`
  exists because that gap turned out to matter (the RCON `execute()`
  drift-detection question) and there wasn't a good way to answer it
  without a full instruction-level bytecode reader -- a materially bigger
  build than this toolkit, and not attempted here.

**The fix, every time so far, has been the same: don't trust "not found"
from checking one class. Walk `superClass` AND `interfaces` until you hit
`java/lang/Object`, or until you find it.** `classfile-parser.mjs` gives you
the links (`superClass`, `interfaces` on every parsed class); walking the
chain and cross-referencing Lua call sites against the right concrete type
is still done by hand per audit, not automated -- that would need a real
Lua static analyzer this toolkit doesn't have.

## When to re-run this

The moment Build 43 ships. Re-running `scan-rcon-commands.mjs` and the
Lua-audit pattern against the new jar is the cheapest way to find every
command and Lua call it silently changed or removed -- that only works if
this tooling still exists and its limitations are still written down, which
is the entire reason it's committed here instead of a scratch directory.
