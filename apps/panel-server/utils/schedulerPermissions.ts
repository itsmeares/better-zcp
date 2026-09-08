const SCHEDULABLE_BRIDGE_ACTIONS = new Set([
  'triggerBlizzard',
  'triggerTropicalStorm',
  'triggerStorm',
  'stopWeather',
  'startRain',
  'stopRain',
  'setSnow',
  'triggerLightning',
  'triggerGunshot',
  'triggerAlarmSound',
  'restoreUtilities',
  'shutOffUtilities',
  'saveWorld',
  'sendToServerChat',
  'sendToAdminChat',
])

const ENDANGER_OR_IMPERSONATE_BRIDGE_ACTIONS = new Set([
  'triggerGunshot',
  'triggerAlarmSound',
  'sendToAdminChat',
])

export function classifyScheduledCommand(command: unknown): string {
  const commandLower = String(command ?? '').toLowerCase()
  if (commandLower === 'restart') return 'restart'
  if (commandLower === 'save') return 'save'
  if (commandLower.startsWith('servermsg ')) return 'servermsg'
  if (commandLower.startsWith('bridge:')) return 'bridge'
  return 'raw'
}

export function parseBridgeActionName(rawCommand: string): string {
  const body = rawCommand.slice('bridge:'.length).trim()
  const firstSpace = body.indexOf(' ')
  return (firstSpace === -1 ? body : body.slice(0, firstSpace)).trim()
}

export function isSchedulableBridgeAction(action: string): boolean {
  return SCHEDULABLE_BRIDGE_ACTIONS.has(action)
}

export function requiredCapabilityForScheduledCommand(command: unknown): string {
  const kind = classifyScheduledCommand(command)
  if (kind === 'restart' || kind === 'save') return 'server.control'
  if (kind === 'servermsg') return 'server.world_events'
  if (kind === 'bridge') {
    const action = parseBridgeActionName(String(command ?? ''))
    if (action === 'saveWorld') return 'server.control'
    if (ENDANGER_OR_IMPERSONATE_BRIDGE_ACTIONS.has(action)) {
      return 'players.endanger_or_impersonate'
    }
    return 'server.world_events'
  }
  return 'rcon.execute'
}
