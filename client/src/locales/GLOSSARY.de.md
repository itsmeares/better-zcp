# German (de) translation glossary

The shared reference for German vocabulary and register. Read it before writing a
string and keep terminology consistent across namespaces. A parity test can verify
that keys exist, but not that the same concept is translated consistently.

German is not Spanish and it is not Chinese. Three things below have no analogue in
either: closed compounds, capitalised nouns, and case-and-gender agreement around
placeholders. The last of those is the trap; it has its own section at the bottom.

## Do not translate

Product and engine tokens, left exactly as they appear in English:

- Project Zomboid, SteamCMD, Steam Workshop, Steam, RCON, PanelBridge, OIDC, Docker
- **mod** (die Mod, plural die Mods), **chunk** (der Chunk), **sandbox** (die Sandbox),
  **token** (das Token), **Backup** (das Backup, die Backups), **Dashboard**,
  **Server**, **Whitelist**, **Single Sign-on**
- INI keys and any value the game itself writes to disk; the SERVER.INI and SANDBOX
  section labels
- Project Zomboid's chat scopes (General, Say, Local, Shout, Q shouts) and the
  [ADMIN] / [SAY] / [FACTION] / [SAFEHOUSE] chat tags
- *iso* in "iso regions" — the engine's own Iso* prefix
- GM, Admin — never expanded
- Intents / Privileged Gateway Intents — literal Discord Developer Portal checkbox names

Prefer **Backup** to *Sicherung* and **Dashboard** to *Übersicht* deliberately: both
are universal in German ops vocabulary and both are shorter, which matters (see the
length rule).

## Core vocabulary

| English | de | Note |
| --- | --- | --- |
| server | der Server | |
| the panel | das Panel | this application, as distinct from the game server |
| dashboard | das Dashboard | |
| player | der Spieler | generic; **no** Gendersternchen or :Innen forms — they break around placeholders and are not house style |
| save / savegame | der Spielstand | |
| world | die Welt | |
| world map | die Weltkarte | |
| region | die Region | |
| backup | das Backup | |
| template | die Vorlage | |
| scheduled task | geplante Aufgabe | |
| console | die Konsole | |
| log | das Protokoll | |
| diagnostics | die Diagnose | one check is *eine Prüfung* |
| settings | die Einstellungen | always plural |
| conflict | der Konflikt | |
| dependency | die Abhängigkeit | |
| folder | der Ordner | |
| path | der Pfad | |
| file | die Datei | |

## Access control

| English | de | Note |
| --- | --- | --- |
| user | der Benutzer | **not** *Nutzer* — pick one, this is it |
| role | die Rolle | |
| permission | die Berechtigung | |
| capability | das Recht | one tickable row in the rights matrix (die Rechtematrix) |
| administrator | Administrator | |
| moderator | Moderator | |
| technician | Techniker | |
| sign in / sign out | anmelden / abmelden | |
| password | das Passwort | |
| session | die Sitzung | |
| Overseer / Observer | Aufseher / Beobachter | Project Zomboid access levels |

## Actions — always the infinitive on a button

| English | de |
| --- | --- |
| start / stop | starten / stoppen |
| restart | neu starten (verb) · der Neustart (noun) |
| install | installieren |
| update | aktualisieren |
| verify | überprüfen |
| enable / disable | aktivieren / deaktivieren |
| kick | kicken |
| ban / unban | bannen / entbannen |
| wipe | unwiderruflich löschen — destructive, **never** *zurücksetzen* |
| delete | löschen |
| save (verb) | speichern |
| apply | anwenden |
| retry | erneut versuchen |
| cancel / close | abbrechen / schließen |

## Status words

| English | de |
| --- | --- |
| succeeded / completed | abgeschlossen |
| failed | fehlgeschlagen |
| error | Fehler |
| warning | Warnung |
| running | läuft |
| stopped | gestoppt |
| pending | ausstehend |
| unavailable | nicht verfügbar |
| not configured | nicht konfiguriert |
| unknown | unbekannt |

## Project Zomboid entities

| English | de | Note |
| --- | --- | --- |
| safehouse | das Safehouse (pl. die Safehouses) | **stays literal** — see the ruling below |
| faction | die Fraktion | |
| territory | das Gebiet | |
| claim (a safehouse) | beanspruchen | |
| respawn | der Respawn · respawnen | |

**Why safehouse stays English when fr, es and zh-CN all translated it.** Three reasons,
and the third is the decisive one:

1. German gaming idiom absorbs English feature names where French and Spanish resist
   them. The precedent from the other three locales does not transfer.
2. Length. *Safehouse* is nine characters; the honest German is fifteen, in table
   headers, chips and operation labels.
3. **The honest German reads as a description, not a feature name.** An attributive
   adjective stays lowercase, so it is *das sichere Haus* — "the safe house" — not
   *das Sichere Haus*. Sitting in an operations list next to *Fraktion*, a
   description-shaped label stops naming the claimable thing the operator manages.

Consistent with the [SAFEHOUSE] chat tag, which this glossary already leaves literal:
the word is on screen untranslated either way, and splitting one concept across two
words inside the same product is worse than a loanword.

Compounds hyphenate, because they mix an English token: *Safehouse-Besitzer*,
*Safehouse-Verwaltung*, *Safehouse-Mitglied*.

## Terms coined during the German pass

Decided from real strings as the buckets landed. Same rule as everything else here:
if you are about to coin one of these differently, do not.

| English | de | Note |
| --- | --- | --- |
| spawn point / spawn region | der Spawnpunkt / die Spawnregion | closed compound; *Spawn* is an adopted loanword |
| tile | die Kachel | world-map tile |
| disk | die Festplatte **in prose** · **Disk** in a terse stat label | *von der Festplatte löschen*; **not** *Datenträger* — see below |
| Mod Checker | der Mod-Checker | the feature's German name; **never** *Mod-Prüfung* |
| item (an in-game object you can spawn or drop) | **das Item**, pl. die Items | stays literal — a Project Zomboid entity, like *mod* and *chunk*; compounds hyphenate: *Item-Typ*, *Item-Liste* |
| item (a JSON array entry in a payload) | das Element | a different sense — this one is not a game object |
| itemType (the Project Zomboid item id) | itemType | a payload field name — stays literal |
| capability label | see below | |

**Capability labels are substituted into error sentences.** `roles.json`'s
`capabilities.<key>.label` entries are not only matrix row headings: the server throws
ROLE_LOCKOUT_LAST_MANAGER and ROLE_SELF_CAPABILITY_LOSS_CONFIRM with
`{ action: "roles.manage" }`, and the client resolves that key through the same
catalogue (see the comment at `server/services/permissions.js:568` and
`CAPABILITY_KEY_PARAM_NAMES` in `errorMessage.ts`). So every capability label must read
correctly **standalone, after a colon**, in a sentence it never sees:

```
Nach dieser Änderung hätte niemand mehr die Berechtigung: {{action}}
```

That is why the German for those two errors uses a colon construction rather than
*niemand könnte mehr {{action}}* — the placeholder carries a label, not an infinitive.

**Festplatte, not Datenträger — corrected after the fact.** I first recorded
*Datenträger* from the one bucket that had landed. Four agents then independently wrote
*Festplatte* in four other files, 35 occurrences against 5, and they are right:
*Datenträger* is Windows-dialog register and this panel says *von der Festplatte
löschen*. The five *Datenträger* occurrences are being corrected, not the thirty-five.
Worth remembering how the wrong term got here: it was ruled from the first sample, not
from the whole tree.

**Terse stat labels follow ops-tooling convention, not this glossary.** `servers.json`'s
resource row is a four-column grid — CPU / RAM / Netz / Disk — where each label has a
fixed narrow column and the set has to read as a parallel series. *Datenträger* is three
times the width of *Disk* and breaks the row. CPU and RAM are already untranslated there
for the same reason, and German ops tooling says *Disk* in exactly this context.

So the rule that wins depends on the surface: in a sentence it is *der Datenträger*; in a
stat chip, a column header or a metric label it is *Disk*. Do not "fix" one into the other.
This is the general shape of the collision between rule 5 (length) and cross-screen term
consistency, and length wins wherever the label has no room to be a word.

## Style rules

1. **Register: du, lowercase.** This panel is run by game-server operators, and the
   floor already ruled the informal form for Spanish. Same call here. Never *Sie*,
   never a mix. Carve-out: a pure statement of state has no addressee and stays
   impersonal — *Server läuft*, *Keine Backups vorhanden* — do not contort those into
   second person.
2. **Buttons and menu items take the infinitive**, not the imperative: *Speichern*,
   *Löschen*, *Neu starten*. Never *Speichere*.
3. **Every noun is capitalised.** This is the single most common defect in machine-
   assisted German and it is invisible to every test here. Re-read your own output for
   it before committing — including nouns inside a sentence and nouns formed from
   verbs (*das Löschen*, *beim Starten*).
4. **Compounds are written closed**, not spaced and not hyphenated: *Serverkonfiguration*,
   *Startparameter*, *Weltkarte*, *Rechtematrix*. Hyphenate only where a compound
   contains an English token or an abbreviation: *Mod-Ordner*, *Backup-Datei*,
   *RCON-Passwort*, *Steam-Workshop-Sammlung*.
5. **Length is a real constraint.** German runs roughly 30% longer than English. On
   buttons, badges, table headers, tabs and chips, choose the shortest correct word
   even where a richer one exists — the layout was built around English string widths
   and nothing on this floor renders your text before it ships.
6. **ß, German orthography** (not Swiss ss): *schließen*, *Größe*, *gelöscht*, but
   *muss*, *dass* — ss after a short vowel.
7. **Quotation marks in prose are „…“**. Straight quotes are fine inside code, paths
   and INI values.
8. Do not translate a string that is literally an INI key or a value the game writes
   to disk. Translate our explanation of what that setting does. Judge it per string
   and report anything genuinely ambiguous rather than guessing silently.

## A keyboard key takes its German key legend, not the German word

`Strg`, not *Steuerung*. `Umschalt` / `Umschalttaste`, not *Verschiebung*. `Entf`, `Eingabe`,
`Alt`, `Esc`, `Tab`. The label names a **physical key the operator is looking at**, and a
German keyboard has *Strg* printed on it.

This convention already existed in the tree before it was written down — `debug.json`
says *Strg+C* and *Strg+F*, `serverconfig.json` says *Strg+S*, `chunkCleaner.json` says
*Umschalttaste*, all written independently by different people. One site disagreed
(`worldMap.json` controlRail rendering *Steuerung* into a rail sized for four characters,
hard-clipped to STEUERL on screen), and it was the only one.

The generalisation is worth as much as the rule: **when several people independently
land on the same form and one site does not, the outlier is the bug.** Look for the
convention in the tree before inventing an answer.

Note *Steuerung* is correct for the CONCEPT — *Live-Steuerung*, *RCON-Steuerung*. It is
only wrong as the name of a key.

## Acronyms are capitalised in German even where English is inconsistent

RCON, GM, INI, OIDC, RAM, CPU, ID. English source strings are **internally inconsistent
about this** — the same file writes *RCON* in a label and *rcon* in a terse badge — and
translators have faithfully mirrored the inconsistency into German in at least three
files under three different owners.

Do not mirror it. German capitalises an acronym wherever it appears, so normalise to the
uppercase form even when the English value beside it is lowercase. The one exception is a
string mimicking a shell prompt or a literal command (`rcon $`, `/rcon`), where the
lowercase form *is* the thing being shown.

This is the general case of a rule worth stating once: **the English source is not
authoritative about German orthography.** Match its meaning, not its typography.

## The trap specific to German: case and gender around placeholders

English carries no agreement at all. German carries three genders and four cases, and
a placeholder that substitutes a **noun** makes every article and adjective around it
unresolvable. This is worse than the Spanish version of the same problem, because
German inflects the article as well as the ending.

```
WRONG   Der {{item}} wurde gelöscht.        <- wrong the moment {{item}} is feminine or neuter
WRONG   Möchtest du den {{item}} löschen?   <- and now the case is wrong too
RIGHT   Gelöscht: {{item}}
RIGHT   {{item}} wurde gelöscht.            <- participle after werden never inflects
RIGHT   Löschen: {{item}}?
```

The rule: **rewrite so that nothing agrees with the substituted word.** Do not guess a
gender. A colon construction, a leading participle, or putting the placeholder first
all work, and none of them commit to a gender the server never sends.

Two consequences worth stating separately:

- **_one and _other must genuinely differ.** German inflects plurals. In zh-CN both
  variants carry the same text because Chinese does not; carrying that habit into
  German would be wrong in every plural in the file.
- **A placeholder standing in for a word rather than a value is not a translation
  problem.** If a string cannot be made agreement-safe without changing what it says,
  report it. That is a server-side variant — two sentences — not something to solve in
  the locale file.

## Discord and PanelBridge

| English | de | Note |
| --- | --- | --- |
| Bot (the Discord bot) | der Bot | |
| Guild (Server) ID | Guild-ID (Server) | keep the Guild wording — Discord's own Developer Portal term |
| bridge (generic, lowercase) | die Brücke | linking form **Brücken-**: *Brückenpfad*, *Brückenordner*, *Brückendienst*. Never bare *Bridge* |
| PanelBridge (the product) | PanelBridge | **one word**, always — not *Panel Bridge* |
| channel | der Kanal | |
| webhook | der Webhook | |
