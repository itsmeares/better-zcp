import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import i18n from '@/i18n'
import { translateDiagnosticCheck } from '../diagnosticsTranslation'

describe('translateDiagnosticCheck', () => {
  beforeEach(() => {
    void i18n.changeLanguage('fr')
  })

  afterEach(() => {
    void i18n.changeLanguage('en')
  })

  it('translates a check with no interpolation needed', () => {
    const check = {
      id: 'server.process',
      status: 'ok',
      label: 'Server process running',
      message: 'Project Zomboid dedicated server is alive.',
    }
    expect(translateDiagnosticCheck(check)).toEqual({
      label: 'Processus du serveur en cours d\'exécution',
      message: 'Le serveur dédié Project Zomboid est actif.',
      hint: undefined,
    })
  })

  it('translates label, message and hint together', () => {
    const check = {
      id: 'server.process',
      status: 'warn',
      label: 'Server process',
      message: 'Server is stopped. Start it from the dashboard.',
      hint: 'Dashboard → Start Server',
    }
    const translated = translateDiagnosticCheck(check)
    expect(translated.label).toBe('Processus du serveur')
    expect(translated.message).toBe('Le serveur est arrêté. Démarrez-le depuis le tableau de bord.')
    expect(translated.hint).toBe('Tableau de bord → Démarrer le serveur')
  })

  it('interpolates params into the translated message', () => {
    const check = {
      id: 'rcon.connected',
      status: 'ok',
      label: 'RCON connected',
      message: 'Connected to 10.0.0.5:27015.',
      params: { host: '10.0.0.5', port: 27015 },
    }
    expect(translateDiagnosticCheck(check).message).toBe('Connecté à 10.0.0.5:27015.')
  })

  it('falls back to the server English text when params are missing', () => {
    const check = {
      id: 'rcon.connected',
      status: 'ok',
      label: 'RCON connected',
      message: 'Connected to 10.0.0.5:27015.',
    }
    expect(translateDiagnosticCheck(check).message).toBe('Connected to 10.0.0.5:27015.')
  })

  it('falls back to the server English text when params are malformed', () => {
    const check = {
      id: 'rcon.connected',
      status: 'ok',
      label: 'RCON connected',
      message: 'Connected to 10.0.0.5:27015.',
      params: { host: '10.0.0.5' }, // missing `port`
    }
    expect(translateDiagnosticCheck(check).message).toBe('Connected to 10.0.0.5:27015.')
  })

  it('falls back untouched for a check id with no registered translation', () => {
    const check = {
      id: 'some.unregistered.check',
      status: 'ok',
      label: 'Some check',
      message: 'Some message.',
      hint: 'Some hint',
    }
    expect(translateDiagnosticCheck(check)).toEqual({
      label: 'Some check',
      message: 'Some message.',
      hint: 'Some hint',
    })
  })

  it('leaves hint undefined when the check has none, even if a translation exists for other statuses', () => {
    const check = {
      id: 'discord.bot',
      status: 'ok',
      label: 'Discord bot connected',
      message: 'Logged in as PanelBot#1234.',
      params: { tag: 'PanelBot#1234' },
    }
    const translated = translateDiagnosticCheck(check)
    expect(translated.message).toBe('Connecté en tant que PanelBot#1234.')
    expect(translated.hint).toBeUndefined()
  })

  it('does not affect English (the source language)', () => {
    void i18n.changeLanguage('en')
    const check = {
      id: 'server.process',
      status: 'ok',
      label: 'Server process running',
      message: 'Project Zomboid dedicated server is alive.',
    }
    expect(translateDiagnosticCheck(check)).toEqual({
      label: 'Server process running',
      message: 'Project Zomboid dedicated server is alive.',
      hint: undefined,
    })
  })

  it('interpolates a name param (server.active)', () => {
    const check = {
      id: 'server.active',
      status: 'ok',
      label: 'Active server',
      message: 'My Zomboid Server.',
      params: { name: 'My Zomboid Server' },
    }
    expect(translateDiagnosticCheck(check).message).toBe('My Zomboid Server.')
  })

  it('resolves the netMount variant to its own label/message/hint, not the plain (missing) entry', () => {
    const check = {
      id: 'server.installPath',
      status: 'fail',
      label: 'Install path not found',
      message: 'Network share or mount not reachable. Check VPN, mount, or share availability.',
      hint: 'Verify the share is mounted and credentials are valid',
      variant: 'netMount',
    }
    const translated = translateDiagnosticCheck(check)
    expect(translated.message).toBe('Partage réseau ou point de montage inaccessible. Vérifiez le VPN, le montage ou la disponibilité du partage.')
    expect(translated.hint).toBe('Vérifiez que le partage est monté et que les identifiants sont valides')
  })

  it('resolves the local variant differently from the netMount variant for the same id+status', () => {
    const check = {
      id: 'server.installPath',
      status: 'fail',
      label: 'Install path not found',
      message: 'Configured install path does not exist or is unreadable.',
      hint: 'Check the path in Servers → Edit',
      variant: 'local',
    }
    const translated = translateDiagnosticCheck(check)
    expect(translated.message).toBe("Le chemin d'installation configuré n'existe pas ou n'est pas lisible.")
    expect(translated.hint).toBe('Vérifiez le chemin dans Serveurs → Modifier')
  })

  it('the plain (non-variant) entry for the same id+status is still independently reachable', () => {
    const check = {
      id: 'server.installPath',
      status: 'fail',
      label: 'Install path missing',
      message: 'Active server has no installPath configured.',
      hint: 'Servers → Edit → Install Path',
      // no variant -- this is the "missing entirely" case
    }
    const translated = translateDiagnosticCheck(check)
    expect(translated.message).toBe("Le serveur actif n'a pas de chemin d'installation configuré.")
  })

  it('combines a variant selection with param interpolation (server.jre)', () => {
    const check = {
      id: 'server.jre',
      status: 'warn',
      label: 'Bundled JRE not found',
      message: 'Could not locate jre64/bin/java under the install path. Server may fail to start unless system Java is on PATH.',
      hint: 'Most installs ship a JRE under jre64/. Re-run SteamCMD if missing.',
      params: { javaBin: 'java' },
      variant: 'linux',
    }
    const translated = translateDiagnosticCheck(check)
    expect(translated.message).toBe("Impossible de localiser jre64/bin/java dans le chemin d'installation. Vérifiez Java avec command -v java ; un service systemd peut utiliser un $PATH différent de votre shell de connexion.")
    expect(translated.hint).toBe('La plupart des installations embarquent un JRE sous jre64/. Relancez SteamCMD s\'il est manquant.')
  })

  it('falls back to the server English text when the variant is missing/unregistered', () => {
    const check = {
      id: 'server.installPath',
      status: 'fail',
      label: 'Install path not found',
      message: 'Some brand new scenario text.',
      variant: 'someFutureVariantNotYetTranslated',
    }
    expect(translateDiagnosticCheck(check).message).toBe('Some brand new scenario text.')
  })

  it('interpolates a relative-path param (server.jre.ok)', () => {
    const check = {
      id: 'server.jre',
      status: 'ok',
      label: 'Bundled JRE present',
      message: 'Found jre64/bin/java.exe.',
      params: { path: 'jre64/bin/java.exe' },
    }
    expect(translateDiagnosticCheck(check).message).toBe('jre64/bin/java.exe trouvé.')
  })

  it('db.writable.ok interpolates count and size params', () => {
    const check = {
      id: 'db.writable',
      status: 'ok',
      label: 'Database accessible',
      message: '7 collections, 4 MB.',
      params: { count: 7, size: '4 MB' },
    }
    expect(translateDiagnosticCheck(check).message).toBe('7 collections, 4 MB.')
  })

  it('resolves 4 distinct variants for the same id+status (db.backup warn)', () => {
    const unreadable = translateDiagnosticCheck({
      id: 'db.backup',
      status: 'warn',
      label: 'Backup status unknown',
      message: 'Could not read the backup directory (timeout or permission denied).',
      variant: 'unreadable',
    })
    const none = translateDiagnosticCheck({
      id: 'db.backup',
      status: 'warn',
      label: 'No database backups',
      message: 'No db.json backups found. Manual backup recommended before risky changes.',
      hint: 'Debug → Database → Create Backup',
      variant: 'none',
    })
    const old = translateDiagnosticCheck({
      id: 'db.backup',
      status: 'warn',
      label: 'Database backup old',
      message: 'Newest backup 3d ago. Consider creating a fresh one.',
      hint: 'Debug → Database → Create Backup',
      params: { age: '3d ago' },
      variant: 'old',
    })
    const error = translateDiagnosticCheck({
      id: 'db.backup',
      status: 'warn',
      label: 'Backup status unknown',
      message: 'Could not inspect backups: disk full',
      params: { reason: 'disk full' },
      variant: 'error',
    })

    expect(unreadable.message).toBe('Impossible de lire le dossier de sauvegarde (délai dépassé ou permission refusée).')
    expect(none.message).toBe('Aucune sauvegarde de db.json trouvée. Une sauvegarde manuelle est recommandée avant des changements risqués.')
    expect(old.message).toBe('Dernière sauvegarde 3d ago. Envisagez d\'en créer une nouvelle.')
    expect(error.message).toBe('Impossible d\'inspecter les sauvegardes : disk full')
    // All four are genuinely distinct -- prove none of them collapsed onto another.
    const messages = [unreadable.message, none.message, old.message, error.message]
    expect(new Set(messages).size).toBe(4)
  })

  it('interpolates an empty-string param without treating it as missing (storage.saveSize, non-truncated)', () => {
    const check = {
      id: 'storage.saveSize',
      status: 'ok',
      label: 'Save folder healthy',
      message: '2 GB across 150 chunks.',
      params: { size: '2 GB', chunks: '150', truncatedSuffix: '' },
    }
    expect(translateDiagnosticCheck(check).message).toBe('2 GB répartis sur 150 chunk(s).')
  })

  it('interpolates a non-empty truncatedSuffix param (storage.saveSize, truncated scan)', () => {
    const check = {
      id: 'storage.saveSize',
      status: 'warn',
      label: 'Save folder very large',
      message: '35 GB across 9,000 chunks (scan truncated). Backups, restores, and chunk cleanups will be slow.',
      params: { size: '35 GB', chunks: '9,000', truncatedSuffix: ' (scan truncated)' },
    }
    expect(translateDiagnosticCheck(check).message).toBe(
      '35 GB répartis sur 9,000 chunk(s) (scan truncated). Les sauvegardes, restaurations et nettoyages de chunks seront lents.',
    )
  })

  it('disk.free interpolates free/total params identically across ok/warn/fail statuses', () => {
    const fail = translateDiagnosticCheck({
      id: 'disk.free',
      status: 'fail',
      label: 'Disk almost full',
      message: 'Only 300 MB free of 500 GB on data drive.',
      params: { free: '300 MB', total: '500 GB' },
    })
    const ok = translateDiagnosticCheck({
      id: 'disk.free',
      status: 'ok',
      label: 'Disk space healthy',
      message: '50 GB free of 500 GB.',
      params: { free: '50 GB', total: '500 GB' },
    })
    expect(fail.message).toBe('Seulement 300 MB libres sur 500 GB sur le disque de données.')
    expect(ok.message).toBe('50 GB libres sur 500 GB.')
  })

  it('breaks a pre-formatted "detail" sentence into separate params rather than embedding it whole (runtime.heap)', () => {
    const check = {
      id: 'runtime.heap',
      status: 'warn',
      label: 'Heap usage high',
      message: 'Heap at 80% of its limit. 400 MB used of 500 MB limit (480 MB currently allocated).',
      params: { pct: '80', heapUsed: '400 MB', heapLimit: '500 MB', heapTotal: '480 MB' },
    }
    const message = translateDiagnosticCheck(check).message
    expect(message).toBe('Tas à 80 % de sa limite. 400 MB utilisés sur 500 MB de limite (480 MB actuellement alloués).')
    // The whole point: no leftover English fragment ("used of", "limit",
    // "currently allocated") should ever appear in the French output.
    expect(message).not.toMatch(/used of|currently allocated/i)
  })

  it('resolves a compound direction+platform variant (runtime.timeSkew.fail) with skew still interpolated', () => {
    const check = {
      id: 'runtime.timeSkew',
      status: 'fail',
      label: 'Host clock is wrong',
      message: 'Panel host clock is 8m behind of Steam time. Scheduled tasks will fire at the wrong wall-clock time and HTTPS handshakes may fail.',
      hint: 'Run: sudo timedatectl set-ntp true',
      params: { skew: '8m' },
      variant: 'behind_linux',
    }
    const translated = translateDiagnosticCheck(check)
    expect(translated.message).toBe(
      "L'horloge du panneau a 8m de retard sur l'heure Steam. Les tâches planifiées se déclencheront au mauvais moment et les connexions HTTPS peuvent échouer.",
    )
    expect(translated.hint).toBe('Exécutez : sudo timedatectl set-ntp true')
  })

  it('the ahead variant reads grammatically differently from behind, not just a substituted word (runtime.timeSkew.warn)', () => {
    const ahead = translateDiagnosticCheck({
      id: 'runtime.timeSkew',
      status: 'warn',
      label: 'Host clock slightly off',
      message: 'Panel host clock is 45s ahead of Steam time.',
      params: { skew: '45s' },
      variant: 'ahead',
    })
    const behind = translateDiagnosticCheck({
      id: 'runtime.timeSkew',
      status: 'warn',
      label: 'Host clock slightly off',
      message: 'Panel host clock is 45s behind of Steam time.',
      params: { skew: '45s' },
      variant: 'behind',
    })
    expect(ahead.message).toBe("L'horloge du panneau a 45s d'avance sur l'heure Steam.")
    expect(behind.message).toBe("L'horloge du panneau a 45s de retard sur l'heure Steam.")
    expect(ahead.message).not.toBe(behind.message)
  })

  it('runtime.timeSkew.ok needs no variant (direction is never mentioned when in sync)', () => {
    const check = {
      id: 'runtime.timeSkew',
      status: 'ok',
      label: 'Host clock in sync',
      message: 'Within 2s of Steam time.',
      params: { skew: '2s' },
    }
    expect(translateDiagnosticCheck(check).message).toBe('À 2s près de l\'heure Steam.')
  })

  it('interpolates numeric params for update.steamApi.ok', () => {
    const check = {
      id: 'update.steamApi',
      status: 'ok',
      label: 'Steam Workshop API reachable',
      message: 'api.steampowered.com responded in 142 ms (HTTP 200).',
      params: { latencyMs: 142, statusCode: 200 },
    }
    expect(translateDiagnosticCheck(check).message).toBe('api.steampowered.com a répondu en 142 ms (HTTP 200).')
  })

  it('distinguishes "update" (singular) from "updates" (plural) as separate ids sharing no locale entries', () => {
    const singular = translateDiagnosticCheck({
      id: 'update.panel',
      status: 'ok',
      label: 'Panel up to date',
      message: 'Running v1.1.55.',
      params: { version: '1.1.55' },
    })
    const plural = translateDiagnosticCheck({
      id: 'updates.error',
      status: 'warn',
      label: 'Update checks errored',
      message: 'Update checks could not run: timeout',
      params: { reason: 'timeout' },
    })
    expect(singular.message).toBe('Exécute la v1.1.55.')
    expect(plural.message).toBe('Les vérifications de mises à jour n\'ont pas pu s\'exécuter : timeout')
  })

  it('falls back to server text when update.mods params are missing (guard still fires for the last batch too)', () => {
    const check = {
      id: 'update.mods',
      status: 'info',
      label: 'Mod updates available',
      message: '3 mods have updates on Steam Workshop.',
      // no params
    }
    expect(translateDiagnosticCheck(check).message).toBe('3 mods have updates on Steam Workshop.')
  })

  it('resolves the platform variant for bridge.writable.fail, message shared, hint distinct', () => {
    const linux = translateDiagnosticCheck({
      id: 'bridge.writable',
      status: 'fail',
      label: 'Bridge directory not writable',
      message: "Panel can't write to the bridge directory. Mod won't receive commands.",
      hint: 'Check ownership / chmod on the Zomboid Lua folder (often needs the panel user to own ~/Zomboid)',
      variant: 'linux',
    })
    const other = translateDiagnosticCheck({
      id: 'bridge.writable',
      status: 'fail',
      label: 'Bridge directory not writable',
      message: "Panel can't write to the bridge directory. Mod won't receive commands.",
      hint: 'Check filesystem permissions on the Lua write folder',
      variant: 'other',
    })
    expect(linux.message).toBe(other.message)
    expect(linux.hint).not.toBe(other.hint)
    expect(linux.hint).toContain('chmod')
  })

  it('resolves two distinct fail variants for bridge.heartbeat (stale vs never-written)', () => {
    const stale = translateDiagnosticCheck({
      id: 'bridge.heartbeat',
      status: 'fail',
      label: 'Mod heartbeat stale',
      message: 'Last heartbeat 5m ago. Mod may have crashed or be unloaded.',
      hint: 'Check server console.txt for PanelBridge errors',
      params: { age: '5m ago' },
      variant: 'stale',
    })
    const never = translateDiagnosticCheck({
      id: 'bridge.heartbeat',
      status: 'fail',
      label: 'No mod heartbeat',
      message: 'status.json has never been written. Mod is not loaded on the server.',
      hint: "Verify PanelBridge is in the server's mod list and Workshop subscription",
      variant: 'never',
    })
    expect(stale.message).toBe('Dernier battement 5m ago. Le mod a peut-être planté ou a été déchargé.')
    expect(never.message).toBe("status.json n'a jamais été écrit. Le mod n'est pas chargé sur le serveur.")
    expect(stale.message).not.toBe(never.message)
  })

  it('resolves 4 distinct variants for server.recentCrash, each with its own label (no shared-label param needed)', () => {
    const oom = translateDiagnosticCheck({
      id: 'server.recentCrash',
      status: 'fail',
      label: 'Recent crash: Out of memory',
      message: 'Found in server-console.txt (last update 2h ago): java.lang.OutOfMemoryError: Java heap space',
      hint: "Raise the server's Java heap (-Xmx in the start script) or reduce mod count.",
      params: { ageLabel: '2h ago', line: 'java.lang.OutOfMemoryError: Java heap space' },
      variant: 'oom',
    })
    const fatal = translateDiagnosticCheck({
      id: 'server.recentCrash',
      status: 'fail',
      label: 'Recent crash: FATAL log entry',
      message: 'Found in server-console.txt (last update 10m ago): FATAL something broke',
      hint: 'Open the Logs page and read the stack trace around the timestamp.',
      params: { ageLabel: '10m ago', line: 'FATAL something broke' },
      variant: 'fatal',
    })
    expect(oom.label).toBe('Panne récente : mémoire insuffisante')
    expect(fatal.label).toBe('Panne récente : entrée de journal FATAL')
    expect(oom.hint).not.toBe(fatal.hint)
    expect(oom.message).toBe('Trouvé dans server-console.txt (dernière mise à jour 2h ago) : java.lang.OutOfMemoryError: Java heap space')
  })

  it('resolves the 3-way "which clauses" variant for mods.orphanWorkshop', () => {
    const both = translateDiagnosticCheck({
      id: 'mods.orphanWorkshop',
      status: 'warn',
      label: 'Subscribed Workshop items not enabled',
      message: '3 Workshop items are listed in WorkshopItems= but won\'t load: 2 downloaded but not in Mods=, 1 not on disk (dead subscription). IDs: 111, 222, 333.',
      hint: 'Auto-fix triages each ID: downloaded → resolves and adds to Mods=; ignored or missing → removes from WorkshopItems=.',
      params: { count: 3, downloadedCount: 2, deadCount: 1, list: '111, 222, 333' },
      variant: 'both',
    })
    const downloadedOnly = translateDiagnosticCheck({
      id: 'mods.orphanWorkshop',
      status: 'warn',
      label: 'Subscribed Workshop items not enabled',
      message: '2 Workshop items are listed in WorkshopItems= but won\'t load: 2 downloaded but not in Mods=. IDs: 111, 222.',
      hint: 'Auto-fix triages each ID: downloaded → resolves and adds to Mods=; ignored or missing → removes from WorkshopItems=.',
      params: { count: 2, downloadedCount: 2, list: '111, 222' },
      variant: 'downloadedOnly',
    })
    expect(both.message).toContain('2 téléchargé(s) mais absent(s) de Mods=, 1 absent(s) du disque')
    expect(downloadedOnly.message).not.toContain('absent(s) du disque')
    expect(both.message).not.toBe(downloadedOnly.message)
  })

  it('resolves the 3-way variant for mods.maps, params only appearing where the variant needs them', () => {
    const modsOnly = translateDiagnosticCheck({
      id: 'mods.maps',
      status: 'fail',
      label: 'Map= entries do not resolve',
      message: '1 entry in Map= cannot be found. 1 entry is a mod, not a map (belong only in Mods=): CoolMod.',
      hint: 'These names are mods, not maps. Remove them from Map= — they only need to be in Mods=.',
      params: { count: 1, modsInMapCount: 1, modsInMapList: 'CoolMod' },
      variant: 'modsOnly',
    })
    expect(modsOnly.message).toBe(
      "1 entrées Map= sont introuvables. 1 d'entre elles sont en réalité des noms de mods, pas des cartes (elles n'appartiennent qu'à Mods=) : CoolMod.",
    )
    expect(modsOnly.hint).toBe('Ce sont des noms de mods, pas des cartes. Retirez-les de Map= — ils doivent seulement être dans Mods=.')
  })

  it('falls back to server text for mods.maps.fail when the variant has no registered entry (e.g. a future 4th combination)', () => {
    const check = {
      id: 'mods.maps',
      status: 'fail',
      label: 'Map= entries do not resolve',
      message: 'some future scenario text',
      variant: 'neither', // not a real variant this batch registered
    }
    expect(translateDiagnosticCheck(check).message).toBe('some future scenario text')
  })

  it('interpolates serverName for sandboxCorrupt/sandboxVars', () => {
    const corrupt = translateDiagnosticCheck({
      id: 'server.sandboxCorrupt',
      status: 'fail',
      label: 'SandboxVars.lua is corrupt',
      message: 'MyServer_SandboxVars.lua has mismatched braces and will fail to load — the dedicated server exits immediately on boot with a Lua syntax error.',
      hint: 'Use the automated repair below, or restore from a .bak backup in the same folder.',
      params: { serverName: 'MyServer' },
    })
    expect(corrupt.message).toContain('MyServer_SandboxVars.lua')
    expect(corrupt.message).toBe(
      'MyServer_SandboxVars.lua a des accolades mal équilibrées et ne se chargera pas — le serveur dédié se ferme immédiatement au démarrage avec une erreur de syntaxe Lua.',
    )
  })

  it('resolves the withOutput/withoutOutput variant for server.jreWorks.fail', () => {
    const withOutput = translateDiagnosticCheck({
      id: 'server.jreWorks',
      status: 'fail',
      label: 'Bundled JRE failed to run',
      message: 'java -version did not succeed: exit code 1. Output: error loading libjvm.so',
      hint: 'Re-run SteamCMD to reinstall the JRE, or ensure the bundled libraries are present alongside the binary.',
      params: { reason: 'exit code 1', output: 'error loading libjvm.so' },
      variant: 'withOutput',
    })
    const withoutOutput = translateDiagnosticCheck({
      id: 'server.jreWorks',
      status: 'fail',
      label: 'Bundled JRE failed to run',
      message: 'java -version did not succeed: timeout.',
      hint: 'Re-run SteamCMD to reinstall the JRE, or ensure the bundled libraries are present alongside the binary.',
      params: { reason: 'timeout' },
      variant: 'withoutOutput',
    })
    expect(withOutput.message).toBe('java -version a échoué : exit code 1. Sortie : error loading libjvm.so')
    expect(withoutOutput.message).toBe('java -version a échoué : timeout.')
    // withoutOutput must never render a literal {{output}} placeholder --
    // proves the variant genuinely omits the clause rather than leaving a
    // blank hole in a shared template.
    expect(withoutOutput.message).not.toMatch(/\{\{/)
  })

  it('falls back to server text for staleLocks when params are missing (dir would otherwise be sanitized server-side)', () => {
    const check = {
      id: 'server.staleLocks',
      status: 'fail',
      label: 'Stale lock files in save folder',
      message: '3 .lock files older than 1 hour in [path]. PZ will refuse to load the save until they are removed.',
      params: { count: 3, dir: '[path]' },
    }
    // Confirms interpolation still works even when the param VALUE is
    // itself the server's redaction placeholder -- the guard only cares
    // whether a param is present and is a string/number, not its content.
    expect(translateDiagnosticCheck(check).message).toBe(
      "3 fichier(s) .lock de plus d'une heure dans [path]. PZ refusera de charger la sauvegarde tant qu'ils ne sont pas supprimés.",
    )
  })
})
