# Haitian Creole (ht) translation glossary

This glossary defines the shared vocabulary for the Haitian Creole locale.
**Use these renderings** so every namespace uses the same terms.

None of us is a native Kreyòl speaker, and the operator knows that going in. This glossary is a
best-effort, consistent starting point for a native-speaker review pass — not a claim of fluency.
Where a term below is a guess rather than an established word, it says so.

## Orthography

Use standard Haitian Creole orthography (IPN — Enstitisyon Pedagojik Nasyonal spelling, the one
taught in Haitian schools and used by Haitian government documents), not French-influenced spelling:

- `k` not `c`/`qu`, `w` not `oi`, no `x`, no silent letters.
- Nasal vowels written `an`, `en`, `on` (not `an`/`in`/`on` with a French nasal mark).
- `è` and `ò` are real, distinct letters (`sèvè`, `mòd`) — do not drop the grave accent, the same
  way `Región` in Spanish is not optional.
- Apostrophes mark real elisions only (`m'ap`, `pa gen anyen pou'w fè`) — do not add one just
  because a word "looks like" it needs one.

## Do not translate

Product and protocol names stay as they are:

`Project Zomboid`, `SteamCMD`, `Steam`, `Workshop`, `Workshop ID`, `Docker`, `RCON`, `OIDC`,
`PanelBridge`, `Discord`, `SFTP`, `Lua`, `INI`, `UID`, `GID`, `URL`, `API`, `mod`, `chunk`, `sandbox`,
`token` (the technical login token — see below for the recovery-code sense, which *is* translated).

`mod` and `chunk` stay in English deliberately, same reasoning as the other locales: these are what
Kreyòl-speaking Project Zomboid players already call them, not concepts with a natural local word.

Also never translated: file paths, folder names, environment variable names, error codes (`EACCES`),
command names, cron expressions, and anything inside `{{double braces}}`.

## Core vocabulary

| English | ht | Note |
| --- | --- | --- |
| server | sèvè | |
| the panel | panèl la | this application, as distinct from the game server |
| dashboard | tablo | short for "tablo bòd" — avoid the longer form, it reads like a car dashboard |
| player | jwè | |
| save (verb, "save changes") | sove | the everyday Kreyòl verb for saving a document/file, distinct from *sovgad* below |
| save / savegame (noun, the world's save data) | sovgad | |
| backup (noun, a copy of a save) | kopi sovgad | "backup copy" — kept two words on purpose so it never collides with plain *sovgad* |
| restore (verb) | retabli | |
| world | mond | |
| world map | kat mond lan | |
| region | rejyon | |
| template | modèl | |
| scheduled task | tach pwograme | |
| schedule (noun) | orè | |
| console | konsòl | |
| log | jounal | |
| diagnostics | dyagnostik | |
| settings | paramèt | |
| conflict | konfli | |
| dependency | depandans | |
| folder | dosye | |
| path | chemen | |
| wipe (destructive) | efase nèt | "erase completely" — never *reyinisyalize* (reset), see Style rules |
| vehicle | machin | |
| spawn (verb, materialize an item/vehicle/entity in-world) | fè parèt | "make appear" — descriptive, no established single-word Kreyòl gaming term found |
| scan (verb, query the live server via PanelBridge) | eskane | |
| process-detection scan (noun, the OS-level mechanism that checks whether the PZ server process is running — distinct from the *eskane* verb above, which queries the live server through PanelBridge) | eskanaj deteksyon pwosesis | **uncertain** — compound noun built from *eskane* (scan) + *deteksyon pwosesis* (process detection); no established precedent for this exact noun form in the glossary or elsewhere in ht. First use: errors.json `SERVER_STATE_UNKNOWN` (2026-08-24, re-translating a key that had gone stale against a same-day English rewrite). Flagged for review if a native speaker becomes available. |
| catalog | katalòg | |
| Safehouse (Project Zomboid mechanic) | kay sekirize | **uncertain** — descriptive translation ("secured house"), not a known established Kreyòl gaming term. Flagged for native-speaker review; if a real Kreyòl PZ community term exists, it should replace this. |

## Access control

| English | ht | Note |
| --- | --- | --- |
| user | itilizatè | |
| role | wòl | |
| permission | otorizasyon | **judgment call**, not the only defensible choice — *pèmisyon* is also heard in casual Kreyòl. Picked *otorizasyon* because it is the term used in Haitian official/legal Kreyòl and reads as less of a raw English borrowing. Whoever reviews this should feel free to override, but every namespace must agree. |
| capability | kapasite | one tickable row in the rights matrix |
| administrator | administratè | |
| moderator | moderatè | |
| technician | teknisyen | |
| sign in | konekte | |
| sign out | dekonekte | |
| password | modpas | |
| session | sesyon | |
| single sign-on | koneksyon inik | "unique/single connection" — SSO has no established Kreyòl abbreviation, spelled out every time |
| recovery token | jeton rekiperasyon | |
| recovery code | kòd rekiperasyon | the *code*, distinct from the *token* above — the panel's login flow uses both words for two different things and the translation must keep them apart |
| account | kont | |

## Actions

| English | ht | Note |
| --- | --- | --- |
| start (a server/service) | demare | |
| stop | sispann | |
| restart | redemare | |
| install | enstale | |
| update (verb) | mete ajou | |
| update (noun) | mizajou | |
| verify | verifye | |
| enable / disable | aktive / dezaktive | |
| kick (a player) | mete deyò | "put out" — no established single-word Kreyòl gaming term found; flagged as a judgment call |
| ban / unban | bani / retire baniman | |
| whitelist | lis blan | |
| delete | efase | |
| apply | aplike | |
| retry | eseye ankò | |
| reset (password) | reyinisyalize | technical "re-initialize" register, deliberately distinct from *efase nèt* (wipe) — resetting a password is not destructive to data, wiping a server is |

## Status words

| English | ht |
| --- | --- |
| succeeded / completed | fini |
| failed | echwe |
| error | erè |
| warning | avètisman |
| running | ap fonksyone |
| stopped | sispann |
| unavailable | pa disponib |
| not configured | poko konfigire |
| unknown | enkoni |

## Style rules

- **Address the reader as `ou`.** Haitian Creole does not have a French *tu/vous* or Spanish
  *tú/usted* distinction — `ou` is the only second-person singular pronoun, for every register. There
  is no formality choice to make here the way there was for German/Spanish/French; use `ou`
  everywhere, including instructions and button labels. Plural "you" (addressing all panel accounts
  at once, rare in this UI) is `nou`.
- **Register is controlled by vocabulary, not pronoun.** Where a sentence *could* lean on a heavily
  French-derived word or a plainer everyday Kreyòl one, prefer the plain one — this is a tool an
  admin runs for their own game server, not enterprise software. `sove` over a more formal
  alternative for "save," `demare`/`sispann` over stiffer options for "start"/"stop."
- **Keep destructive wording destructive.** A wipe/delete confirmation that reads mild in Kreyòl
  when it was alarming in English is a bug, the same lesson the French locale already learned the
  hard way once (see `GLOSSARY.es.md`). `efase nèt` for "wipe," never a softer verb.
- **Straight ASCII quotes inside a JSON string value are a parse error, not a style choice.** If Kreyòl
  prose needs a quotation mark inside a string, use `\"` (escaped) or curly quotes (`" "`), never an
  unescaped straight `"`. `JSON.parse` every file before calling it done.

## Placeholders and tags are structural, not text

Every `{{name}}`-style interpolation placeholder must appear in the Kreyòl string, spelled
byte-for-byte identically to the English source. Every `<tag>...</tag>` or self-closing `<1/>` must
also survive. The parity test checks both, per key, in both directions. Word order around a
placeholder or tag should change to fit natural Kreyòl phrasing — that is the point of translating —
but the token itself never does. Example: English `Deleted {{name}}` could become
`{{name}} efase` (placeholder moved to the front, which reads more naturally in Kreyòl) — never
`Item efase` (placeholder dropped) or `{{Name}} efase` (placeholder respelled).

## Latin abbreviations and single-letter markers: check what the badge actually is

RULING (2026-08-23, revised same day — requested by the operator's own question before Pam wrote a
word). The first version of this ruling said "keep all four as-is" on the strength of a plausible-sounding
principle, not the evidence. Rechecked directly against what fr/es/de actually do for each one; the
correct rule is CHECK WHAT THE BADGE ACTUALLY IS, not a blanket keep-or-translate:

| Marker | Where it shows up | Verdict |
| --- | --- | --- |
| `{{count}}s` / `m` / `h` / `d` (time-unit suffixes) | dashboard, mods, console namespaces | KEEP — space-constrained UI markers, read the same way across technical interfaces; a translated single letter is ambiguous where the original is not |
| `B{{n}}` (Basement) | worldMap | **TRANSLATE to `S{{n}}`** — fr and es both render this as `S{{n}}` (Sous-sol / Sótano), de as `K{{n}}` (Keller). `B` is OUR English convention for "Basement," not a Project Zomboid term the reader is matching against the game's own display — the first ruling asserted that without checking and was wrong. `S{{n}}` for Soubasman matches the two Latin-script locales exactly. |
| `WS` (Workshop) | mods | KEEP — fr, de and es all keep `WS` too. Workshop is a brand (already on the do-not-translate list above), not an ordinary-word abbreviation. |
| `RM` (Remote) | shell | KEEP — de and es keep `RM`; fr translates it (`DIS`). Two of three keep it, so ht keeps it too. |

**Condition, and this is the part that matters:** wherever a badge like this has a tooltip, aria-label,
or expanded form nearby, *that* gets translated normally. The abbreviation is a marker; the expanded
text next to it is prose. Example: keep `{{count}}m` in the badge itself, but translate its
`aria-label="X minutes remaining"` fully into Kreyòl.

## Translate the explanation, never the token being explained

A general rule, not specific to Discord or access levels, established by re-reading how the French
locale already (inconsistently, but correctly in spirit) handles `players.json`: it translates
*Moderateur*/*Observateur* as prose labels, but leaves `Overseer` and `GM` alone (PZ's own in-game
terms) and keeps the literal words `User` and `None` inside parentheticals that are telling the
operator which exact string to pick on their build.

**The test:** if a string exists so the reader can match it against a literal value the game, a
config file, or another piece of software displays — a build name, an access-level dropdown option, a
config key, a chat tag — that string is a *token*, not prose, even if it happens to be an ordinary
English word. Translate the sentence around it; never the token itself. The `Overseer / Observer / GM`
ruling above is the concrete instance of this rule; it will come up again.

## Discord and PanelBridge

| English | ht | Note |
| --- | --- | --- |
| Bot (the Discord bot) | bot | stays as-is |
| Guild (Server) ID | ID Sèvè (Guild) | keep the Guild parenthetical, Discord's own Developer Portal term |
| Intents / Privileged Gateway Intents | Intents / Privileged Gateway Intents | leave in English — literal Discord Developer Portal checkbox names |
| bridge (generic, lowercase) | pon | but **PanelBridge** the product name stays literal |
| GM | GM | do not expand |
| Overseer / Observer | Overseer / Observer | **settled, not a coin flip** — RULING (2026-08-23): stays untranslated. The five existing locales disagree with each other (fr even translates it inconsistently across its own file), so there is no house convention to match. These labels tell the operator which literal string their build's access-level dropdown accepts — the code's own comment notes `none` does nothing on some builds while `user` works — so the label exists to be matched against what the game displays in English, not to read naturally in Kreyòl. A translated label that drifts from its token defeats the label's purpose. See "Translate the explanation, never the token" below. |

Left untranslated as game-literal tokens, same reasoning as the other locales: Project Zomboid's chat
scopes (General, Say, Local, Shout, Q shouts), the `[ADMIN]` / `[SAY]` / `[FACTION]` / `[SAFEHOUSE]`
chat tags, `SERVER.INI` and `SANDBOX` section labels.

## If you need a term that is not here

Add it to this file in the same commit as the strings that use it, so the next agent to hit the same
word finds it already settled instead of inventing a second answer.
