# Spanish (es) translation glossary

This file is the shared Spanish vocabulary. **Use these renderings.** Consistency across
screens matters more than any single word being the nicest possible choice — an operator
who reads *servidor* on one screen and *host* on the next has to stop and work out whether
they mean the same thing.

Target is **neutral international Spanish**. No *vosotros*, no strongly regional vocabulary. If a
term differs between Spain and Latin America, pick the one that will be understood in both.

If you need a term that is not here and it will appear in more than one namespace, add it to this
file in the same commit as the strings that use it.

## Do not translate

Product and protocol names stay as they are:

`Project Zomboid`, `SteamCMD`, `Steam`, `Workshop`, `Workshop ID`, `Docker`, `RCON`, `OIDC`,
`PanelBridge`, `Discord`, `SFTP`, `Lua`, `INI`, `UID`, `GID`, `URL`, `API`, `mod`, `chunk`,
`sandbox`, `token`.

`mod` and `chunk` stay in English deliberately — both are what Spanish-speaking Project Zomboid
players actually say, and *modificación* / *fragmento* would read as a translation of a game the
reader already knows in English.

Also never translated: file paths, folder names, environment variable names, error codes (`EACCES`),
command names, and anything inside `{{double braces}}`.

## Core vocabulary

| English | es | Note |
| --- | --- | --- |
| server | servidor | |
| the panel | el panel | this application, as distinct from the game server |
| dashboard | el tablero | **not** *panel de control* — that would collide with the app's own name |
| player | jugador | |
| save / savegame | partida guardada | |
| world | mundo | |
| world map | mapa del mundo | |
| region | región | |
| backup | copia de seguridad | |
| template | plantilla | |
| scheduled task | tarea programada | |
| console | consola | |
| log | registro | |
| diagnostics | diagnóstico | |
| settings | ajustes | |
| conflict | conflicto | |
| dependency | dependencia | |
| folder | carpeta | |
| path | ruta | |

## Access control

| English | es | Note |
| --- | --- | --- |
| user | usuario | |
| role | rol | |
| permission | permiso | |
| capability | capacidad | one tickable row in the rights matrix |
| administrator | administrador | |
| moderator | moderador | |
| technician | técnico | |
| sign in | iniciar sesión | |
| sign out | cerrar sesión | |
| password | contraseña | |
| session | sesión | |
| single sign-on | inicio de sesión único | |

## Actions

| English | es | Note |
| --- | --- | --- |
| start | iniciar | |
| stop | detener | |
| restart | reiniciar | |
| install | instalar | |
| update | actualizar | |
| verify | verificar | |
| enable / disable | activar / desactivar | |
| kick | expulsar | |
| ban / unban | banear / desbanear | |
| whitelist | lista blanca | |
| wipe | borrar por completo | destructive — **never** *restablecer* or *reiniciar* |
| delete | eliminar | |
| save (verb) | guardar | |
| apply | aplicar | |
| retry | reintentar | |

## Status words

| English | es |
| --- | --- |
| succeeded / completed | completado |
| failed | fallido |
| error | error |
| warning | advertencia |
| running | en ejecución |
| stopped | detenido |
| unavailable | no disponible |
| not configured | sin configurar |
| unknown | desconocido |

## Style rules

- **Opening punctuation is mandatory.** `¿Seguro que quieres eliminar…?` and `¡Atención!` — never
  the bare closing mark alone.
- **Accents are mandatory**, including on capitals (`Región`, `Éxito`). A missing accent is a typo,
  not a variant.
- **Buttons and menu items take the infinitive**: `Reiniciar servidor`, not `Reinicia el servidor`.
- **Address the reader as *tú*.** `Inténtalo de nuevo`, `Comprueba tu conexión`, `Puedes reintentar`.
  Never *usted* — this is a tool someone runs for their own game server, not enterprise software.

  This rule replaces an earlier one that mandated impersonal prose. It was overturned by practice:
  once the locale was largely written, a count across all 54 namespaces found **142 strings using
  *tú* against 4 apparent *usted*** — and three of those four turned out to be `su`/`elija` referring
  to a *server* or a *provider*, not to the reader. The impersonal rule existed to stop several
  writers diverging; they had already converged on *tú* without it, so the rule was the outlier, not
  the translations.
- **Pure state statements stay impersonal**, because there is no one to address: `No se pudo cargar
  la configuración`, not `No pudiste cargar…`. The *tú* rule governs instructions and actions.
- **Keep destructive wording destructive.** A confirmation that sounds mild in Spanish when it was
  alarming in English is a bug, not a translation choice. This has already shipped once in French,
  where "Wipe server" came out as "reset".

## The trap specific to Spanish: gender and number agreement around placeholders

English `{{count}} items removed` and `Deleted {{name}}` carry no agreement. Spanish does.

- **A placeholder that substitutes a noun breaks any article or adjective agreeing with it.**
  `El {{item}} ha sido eliminado` is wrong the moment `{{item}}` is feminine. Rewrite so nothing
  agrees with the substituted word — `Se ha eliminado: {{item}}` — rather than guessing a gender.
- **A count placeholder breaks singular/plural.** English handles this with `_one` / `_other` keys.
  Where those exist, translate both properly; where English has only one key and the Spanish needs
  to inflect, prefer a number-agnostic phrasing (`Elementos afectados: {{count}}`) over a sentence
  that is wrong at 1.
- **If a string cannot be made agreement-safe without changing what it says, stop and report it.**
  That is a variant problem — it needs two different sentences on the server side, not a cleverer
  single translation — and it is not yours to fix in the locale file.

## Discord and PanelBridge (added after the first pass — these recur)

| English | es | Note |
| --- | --- | --- |
| Bot (the Discord bot) | bot | stays as-is; universally used in Spanish |
| Guild (Server) ID | ID de servidor (Guild) | keep the Guild parenthetical — Discord's own Developer Portal term |
| Intents / Privileged Gateway Intents | Intents / Privileged Gateway Intents | leave in English; they are literal Discord Developer Portal checkbox names |
| bridge (generic, lowercase) | puente | but **PanelBridge** the product name stays literal |
| GM | GM | do not expand |
| Overseer / Observer | supervisor / observador | Project Zomboid access levels |

Left untranslated as game-literal tokens: Project Zomboid's chat scopes (General, Say, Local,
Shout, Q shouts), the `[ADMIN]` / `[SAY]` / `[FACTION]` / `[SAFEHOUSE]` chat tags, `SERVER.INI` and
`SANDBOX` section labels, and `iso` in "iso regions" (the engine's own `Iso*` class prefix).
