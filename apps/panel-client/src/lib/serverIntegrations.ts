import { createServerFn } from '@tanstack/react-start'
import {
  permissionMiddleware,
  protectedServerFunctionMiddleware,
} from './serverAuth'

type AnyRecord = Record<string, any>

type ServiceError = {
  error?: unknown
  message?: unknown
  code?: unknown
  params?: unknown
  status?: unknown
  missing?: unknown
  success?: unknown
  valid?: unknown
  detail?: unknown
  reason?: unknown
}

type IntegrationContext = {
  authenticatedUser?: {
    role?: string
  }
}

type DiscordEvent = {
  enabled: boolean
  template: string
}

interface ManagedDockerContainer {
  Id: string
  Names?: string[]
  Image?: string
  State?: { Running?: boolean }
  Status?: string
}

const SNOWFLAKE = /^\d{15,21}$/

const DISCORD_COMMAND_CAPABILITY: Record<string, string | null> = {
  status: null,
  players: 'players.view',
  save: 'server.control',
  broadcast: 'server.world_events',
  kick: 'players.moderate',
  start: 'server.control',
  stop: 'server.control',
  restart: 'server.control',
  rcon: 'rcon.execute',
}

const DEFAULT_DISCORD_EVENTS: Record<string, DiscordEvent> = {
  serverStart: {
    enabled: false,
    template:
      '🟢 **Server Started**\nThe Project Zomboid server is now online!',
  },
  serverStop: {
    enabled: false,
    template: '🔴 **Server Stopped**\nThe server has been shut down.',
  },
  playerJoin: {
    enabled: false,
    template: '👋 **{player}** joined the server',
  },
  playerLeave: {
    enabled: false,
    template: '👋 **{player}** left the server',
  },
  scheduledRestart: {
    enabled: false,
    template:
      '⏰ **Scheduled Restart**\nServer will restart in {minutes} minutes',
  },
  backupComplete: {
    enabled: false,
    template: '💾 **Backup Complete**\nBackup created successfully',
  },
  playerDeath: {
    enabled: false,
    template: '💀 **{player}** has died',
  },
}

function record(data: unknown): AnyRecord {
  return data && typeof data === 'object' && !Array.isArray(data)
    ? (data as AnyRecord)
    : {}
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  if (error && typeof error === 'object') {
    const details = error as ServiceError
    if (typeof details.error === 'string') return details.error
    if (typeof details.message === 'string') return details.message
  }
  return String(error)
}

function sanitizeMessage(message: string): string {
  return message
    .replace(/[A-Z]:\\[^\s'")\]>}]+/gi, '[path]')
    .replace(/[A-Z]:\/[^\s'")\]>}]+/gi, '[path]')
    .replace(/\\\\[^\s'")\]>}]+/gi, '[path]')
    .replace(
      /\/(?:home|opt|usr|var|tmp|srv|root|etc|mnt|media)\/[^\s'")\]>}]+/gi,
      '[path]',
    )
}

function sanitizeParams(params: unknown): unknown {
  if (!params || typeof params !== 'object') return params
  const sanitized: AnyRecord = {}
  for (const [key, value] of Object.entries(params)) {
    sanitized[key] = typeof value === 'string' ? sanitizeMessage(value) : value
  }
  return sanitized
}

function normalizeChatRelayScope(value: unknown): string {
  return value === 'public' || value === 'no-yell' || value === 'general'
    ? value
    : 'public'
}

function describeStartFailure(lastStartError: unknown): string {
  const error =
    lastStartError && typeof lastStartError === 'object'
      ? (lastStartError as { kind?: unknown; message?: unknown })
      : {}
  if (error.kind === 'NoToken') {
    return 'No bot token is configured. Add one below and save.'
  }
  if (error.kind === 'TokenInvalid') {
    return 'Invalid token. Check the token below and save again.'
  }
  if (error.kind === 'DisallowedIntents') {
    return 'Discord rejected the connection: this bot needs the Server Members and Message Content privileged intents enabled. Open your application in the Discord Developer Portal -> Bot, turn both on, then try starting the bot again. This is not a token or ID problem.'
  }
  if (error.kind === 'ReadyTimeout') {
    return "Discord didn't respond within 30 seconds. This usually means a network problem between the panel and Discord, not your configuration -- try again in a moment."
  }
  if (typeof error.message === 'string' && error.message) {
    return 'Failed to start bot: ' + sanitizeMessage(error.message)
  }
  return 'Failed to start bot - check configuration'
}

function throwIntegrationError(error: unknown, fallbackStatus = 500): never {
  const details =
    error && typeof error === 'object' ? (error as ServiceError) : {}
  const status =
    typeof details.status === 'number' ? details.status : fallbackStatus
  throw Object.assign(new Error(sanitizeMessage(errorMessage(error))), {
    status,
    ...(typeof details.code === 'string' ? { code: details.code } : {}),
    ...(details.params !== undefined
      ? { params: sanitizeParams(details.params) }
      : {}),
    ...(details.missing !== undefined ? { missing: details.missing } : {}),
    ...(details.success === false ? { success: false } : {}),
    ...(details.valid === false ? { valid: false } : {}),
    ...(typeof details.detail === 'string'
      ? { detail: sanitizeMessage(details.detail) }
      : {}),
    ...(typeof details.reason === 'string'
      ? { reason: sanitizeMessage(details.reason) }
      : {}),
  })
}

function invalid(message: string, code?: string): never {
  throwIntegrationError(
    Object.assign(new Error(message), code ? { code } : {}),
    400,
  )
}

function capabilityMiddleware(capability: string) {
  return [
    ...protectedServerFunctionMiddleware,
    permissionMiddleware(capability),
  ] as const
}

async function panelRuntime(): Promise<AnyRecord> {
  const { getPanelRuntime } =
    await import('../../../panel-server/utils/panelRuntime.ts')
  return getPanelRuntime()
}

async function discordBotOrThrow(): Promise<AnyRecord> {
  const discordBot = (await panelRuntime()).discordBot
  if (!discordBot) {
    throwIntegrationError(
      Object.assign(new Error('Discord bot not initialized'), {
        code: 'DISCORD_BOT_NOT_INITIALIZED',
      }),
    )
  }
  return discordBot
}

function createIntegrationRead<T>(
  capability: string,
  handler: (data: AnyRecord, context: unknown) => Promise<T> | T,
) {
  const implementation = async (
    data: AnyRecord,
    context: unknown,
  ): Promise<T> => {
    try {
      return (await handler(data, context)) as T
    } catch (error) {
      throwIntegrationError(error)
    }
  }
  return Object.assign(
    createServerFn({ method: 'GET' })
      .middleware(capabilityMiddleware(capability))
      .validator((data: unknown) => record(data))
      .handler(({ data, context }) => implementation(data, context) as any),
    { __executeImplementation: implementation },
  )
}

function createIntegrationAction<T>(
  capability: string,
  handler: (data: AnyRecord, context: unknown) => Promise<T> | T,
) {
  const implementation = async (
    data: AnyRecord,
    context: unknown,
  ): Promise<T> => {
    try {
      return (await handler(data, context)) as T
    } catch (error) {
      throwIntegrationError(error)
    }
  }
  return Object.assign(
    createServerFn({ method: 'POST' })
      .middleware(capabilityMiddleware(capability))
      .validator((data: unknown) => record(data))
      .handler(({ data, context }) => implementation(data, context) as any),
    { __executeImplementation: implementation },
  )
}

export const getDiscordStatus = createIntegrationRead(
  'integrations.manage',
  async () => {
    const discordBot = (await panelRuntime()).discordBot
    if (!discordBot) {
      return {
        running: false,
        configured: false,
        error: 'Discord bot not initialized',
      }
    }
    return discordBot.getStatus()
  },
)

export const getDiscordConfig = createIntegrationRead(
  'integrations.manage',
  async () => {
    const discordBot = await discordBotOrThrow()
    const { getSetting } =
      await import('../../../panel-server/database/init.ts')

    await discordBot.loadConfig()
    const autoStart = await getSetting('discordAutoStart')

    return {
      token: discordBot.token ? '••••••••' + discordBot.token.slice(-4) : null,
      hasToken: !!discordBot.token,
      guildId: discordBot.guildId,
      adminRoleId: discordBot.adminRoleId,
      modRoleId: discordBot.modRoleId,
      channelId: discordBot.channelId,
      autoStart: autoStart !== false,
      chatRelayEnabled: discordBot.chatRelayEnabled !== false,
      chatRelayChannelId: discordBot.chatRelayChannelId || '',
      chatRelayScope: normalizeChatRelayScope(discordBot.chatRelayScope),
    }
  },
)

export const updateDiscordConfig = createIntegrationAction(
  'integrations.manage',
  async (data) => {
    const {
      token,
      guildId,
      adminRoleId,
      modRoleId,
      channelId,
      autoStart,
      chatRelayEnabled,
      chatRelayChannelId,
      chatRelayScope,
    } = data
    const discordBot = await discordBotOrThrow()

    await discordBot.loadConfig()

    const finalToken =
      token === 'KEEP_EXISTING' && discordBot.token ? discordBot.token : token

    if (!finalToken || !guildId) {
      invalid(
        'Token and Guild ID are required',
        'DISCORD_TOKEN_AND_GUILD_REQUIRED',
      )
    }
    if (!SNOWFLAKE.test(guildId)) {
      invalid(
        'Invalid Guild ID format (must be a Discord Snowflake)',
        'DISCORD_INVALID_GUILD_ID',
      )
    }
    if (adminRoleId && !SNOWFLAKE.test(adminRoleId)) {
      invalid('Invalid Admin Role ID format', 'DISCORD_INVALID_ADMIN_ROLE_ID')
    }
    if (modRoleId && !SNOWFLAKE.test(modRoleId)) {
      invalid('Invalid Mod Role ID format', 'DISCORD_INVALID_MOD_ROLE_ID')
    }
    if (channelId && !SNOWFLAKE.test(channelId)) {
      invalid('Invalid Channel ID format', 'DISCORD_INVALID_CHANNEL_ID')
    }
    if (chatRelayChannelId && !SNOWFLAKE.test(chatRelayChannelId)) {
      invalid(
        'Invalid Chat Relay Channel ID format',
        'DISCORD_INVALID_CHAT_RELAY_CHANNEL_ID',
      )
    }
    if (
      chatRelayScope !== undefined &&
      chatRelayScope !== 'public' &&
      chatRelayScope !== 'no-yell' &&
      chatRelayScope !== 'general'
    ) {
      invalid('Invalid Chat Relay Scope', 'DISCORD_INVALID_CHAT_RELAY_SCOPE')
    }

    const { setSetting } =
      await import('../../../panel-server/database/init.ts')
    const prevToken = discordBot.token
    const prevGuildId = discordBot.guildId

    await discordBot.updateConfig(
      finalToken,
      guildId,
      adminRoleId,
      channelId,
      modRoleId,
    )

    if (typeof autoStart === 'boolean') {
      await setSetting('discordAutoStart', autoStart)
    }

    if (
      typeof chatRelayEnabled === 'boolean' ||
      typeof chatRelayChannelId === 'string' ||
      typeof chatRelayScope === 'string'
    ) {
      await discordBot.updateChatRelay(
        typeof chatRelayEnabled === 'boolean'
          ? chatRelayEnabled
          : discordBot.chatRelayEnabled,
        typeof chatRelayChannelId === 'string'
          ? chatRelayChannelId
          : discordBot.chatRelayChannelId,
        typeof chatRelayScope === 'string'
          ? chatRelayScope
          : discordBot.chatRelayScope,
      )
    }

    const credentialsChanged =
      prevToken !== finalToken || prevGuildId !== (guildId || null)
    if (discordBot.isRunning && credentialsChanged) {
      await discordBot.stop()
      const started = await discordBot.start()
      if (!started) {
        return {
          success: true,
          message:
            'Discord bot configuration saved, but the bot failed to reconnect.',
          botStarted: false,
          botStartError: describeStartFailure(discordBot.lastStartError),
        }
      }
    }

    return {
      success: true,
      message: 'Discord bot configuration updated',
    }
  },
)

export const startDiscordBot = createIntegrationAction(
  'integrations.manage',
  async () => {
    const discordBot = await discordBotOrThrow()
    if (discordBot.isRunning) {
      return { success: true, message: 'Bot is already running' }
    }

    const started = await discordBot.start()
    if (started) return { success: true, message: 'Discord bot started' }

    const reason = describeStartFailure(discordBot.lastStartError)
    throwIntegrationError(
      Object.assign(new Error(reason), {
        code: 'DISCORD_START_FAILED',
        params: { reason },
      }),
      400,
    )
  },
)

export const stopDiscordBot = createIntegrationAction(
  'integrations.manage',
  async () => {
    const discordBot = await discordBotOrThrow()
    if (!discordBot.isRunning) {
      return { success: true, message: 'Bot is not running' }
    }
    await discordBot.stop()
    return { success: true, message: 'Discord bot stopped' }
  },
)

export const resetDiscordConfig = createIntegrationAction(
  'integrations.manage',
  async () => {
    const discordBot = await discordBotOrThrow()
    await discordBot.resetConfig()
    return {
      success: true,
      message: 'Discord bot settings wiped. Setup can start from scratch.',
    }
  },
)

export const testDiscordToken = createIntegrationAction(
  'integrations.manage',
  async (data) => {
    const token = data.token
    if (typeof token !== 'string' || token.length === 0 || token.length > 200) {
      invalid(
        'Token must be a non-empty string (max 200 chars)',
        'DISCORD_TEST_TOKEN_INVALID_INPUT',
      )
    }
    if (!/^[A-Za-z0-9._-]+$/.test(token)) {
      invalid('Invalid token format', 'DISCORD_TEST_TOKEN_INVALID_FORMAT')
    }

    const response = await fetch('https://discord.com/api/v10/users/@me', {
      headers: { Authorization: 'Bot ' + token },
      signal: AbortSignal.timeout(10000),
    })

    if (!response.ok) {
      if (response.status === 429) {
        throwIntegrationError(
          Object.assign(
            new Error(
              'Discord is rate-limiting this request. Wait a moment and try again.',
            ),
            { code: 'DISCORD_TEST_RATE_LIMITED' },
          ),
          429,
        )
      }
      if (response.status >= 500) {
        const message =
          "Discord's API is unavailable right now (HTTP " +
          response.status +
          "). This isn't your token -- try again shortly."
        throwIntegrationError(
          Object.assign(new Error(message), {
            code: 'DISCORD_TEST_API_UNAVAILABLE',
            params: { status: response.status },
          }),
          502,
        )
      }
      if (response.status !== 401) {
        const message =
          'Discord rejected the request (HTTP ' + response.status + ').'
        throwIntegrationError(
          Object.assign(new Error(message), {
            code: 'DISCORD_TEST_REQUEST_REJECTED',
            params: { status: response.status },
          }),
          400,
        )
      }
      invalid('Invalid token', 'DISCORD_TEST_TOKEN_INVALID')
    }

    const userData = (await response.json()) as AnyRecord
    const permissions = 84992
    const inviteUrl =
      'https://discord.com/oauth2/authorize?client_id=' +
      userData.id +
      '&permissions=' +
      permissions +
      '&scope=bot%20applications.commands'

    return {
      success: true,
      bot: {
        username: userData.username,
        id: userData.id,
        discriminator: userData.discriminator,
        avatar: userData.avatar
          ? 'https://cdn.discordapp.com/avatars/' +
            userData.id +
            '/' +
            userData.avatar +
            '.png?size=128'
          : null,
      },
      inviteUrl,
    }
  },
)

export const sendDiscordTestMessage = createIntegrationAction(
  'integrations.manage',
  async () => {
    const discordBot = (await panelRuntime()).discordBot
    if (!discordBot) {
      invalid('Discord bot not initialized', 'DISCORD_BOT_NOT_INITIALIZED')
    }
    if (!discordBot.isRunning) {
      invalid('Bot is not running', 'DISCORD_BOT_NOT_RUNNING')
    }

    const sent = await discordBot.sendNotification(
      '🧪 **Test message** from PZ Server Manager',
    )
    if (!sent) {
      throwIntegrationError(
        Object.assign(
          new Error(
            'Discord rejected the message. Check the notification channel ID and that the bot can post there.',
          ),
          { code: 'DISCORD_TEST_MESSAGE_REJECTED' },
        ),
        502,
      )
    }
    return { success: true, message: 'Test message sent' }
  },
)

export const getDiscordWebhookEvents = createIntegrationRead(
  'integrations.manage',
  async () => {
    const discordBot = (await panelRuntime()).discordBot
    if (!discordBot) return { events: {} }
    return {
      events: {
        ...DEFAULT_DISCORD_EVENTS,
        ...(discordBot.webhookEvents || {}),
      },
    }
  },
)

export const updateDiscordWebhookEvents = createIntegrationAction(
  'integrations.manage',
  async (data) => {
    const discordBot = await discordBotOrThrow()
    const events = data.events
    if (!events || typeof events !== 'object') {
      invalid('Events configuration required', 'DISCORD_EVENTS_CONFIG_REQUIRED')
    }

    const sanitizedEvents: Record<string, DiscordEvent> = {}
    const validEventKeys = Object.keys(DEFAULT_DISCORD_EVENTS)
    for (const key of validEventKeys) {
      const event = events[key]
      if (event && typeof event === 'object') {
        const template =
          typeof event.template === 'string' ? event.template.slice(0, 500) : ''
        sanitizedEvents[key] = {
          enabled: !!event.enabled && template.trim().length > 0,
          template,
        }
      }
    }

    const merged = { ...(discordBot.webhookEvents || {}), ...sanitizedEvents }
    await discordBot.saveWebhookEvents(merged)
    return { success: true, message: 'Webhook events updated' }
  },
)

export const getDiscordPermissions = createIntegrationRead(
  'integrations.manage',
  async () => {
    const discordBot = await discordBotOrThrow()
    return { permissions: discordBot.getCommandPermissions() }
  },
)

export const updateDiscordPermissions = createIntegrationAction(
  'integrations.manage',
  async (data, context) => {
    const discordBot = await discordBotOrThrow()
    const permissions = data.permissions
    if (!permissions || typeof permissions !== 'object') {
      invalid(
        'Permissions object required',
        'DISCORD_PERMISSIONS_OBJECT_REQUIRED',
      )
    }

    const current = discordBot.getCommandPermissions()
    const missing: Array<{
      command: string
      requiredCapability: string
    }> = []
    let callerCapabilities: string[] | null = null

    for (const [command, tier] of Object.entries(permissions)) {
      const requiredCapability = DISCORD_COMMAND_CAPABILITY[command]
      if (!requiredCapability) continue
      if (!(command in current) || current[command] === tier) continue
      if (callerCapabilities === null) {
        const user = (context as IntegrationContext).authenticatedUser
        const { getRoleByName } =
          await import('../../../panel-server/database/init.ts')
        const role = user?.role ? await getRoleByName(user.role) : null
        callerCapabilities = Array.isArray(role?.capabilities)
          ? role.capabilities
          : []
      }
      if (!callerCapabilities.includes(requiredCapability)) {
        missing.push({ command, requiredCapability })
      }
    }

    if (missing.length > 0) {
      const detail = missing
        .map(
          (item) => '"' + item.command + '" needs ' + item.requiredCapability,
        )
        .join(', ')
      throwIntegrationError(
        Object.assign(
          new Error(
            'Cannot change the Discord tier for ' +
              detail +
              ' without holding that capability yourself.',
          ),
          {
            code: 'DISCORD_PERMISSIONS_CAPABILITY_REQUIRED',
            params: { detail },
            missing,
          },
        ),
        403,
      )
    }

    const updated = await discordBot.updateCommandPermissions(permissions)
    return { success: true, permissions: updated }
  },
)

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  mapper: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let nextIndex = 0
  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (nextIndex < items.length) {
        const index = nextIndex++
        results[index] = await mapper(items[index])
      }
    },
  )
  await Promise.all(workers)
  return results
}

export const getDockerStatus = createIntegrationRead(
  'docker.manage',
  async () => {
    const dockerClient = (await panelRuntime()).dockerClient
    if (!dockerClient?.enabled) {
      return { enabled: false, available: false, containers: [] }
    }

    const containers =
      (await dockerClient.listManagedContainers()) as ManagedDockerContainer[]
    return {
      enabled: true,
      available: dockerClient.available,
      ...(dockerClient.lastError
        ? { error: sanitizeMessage(dockerClient.lastError) }
        : {}),
      containers: containers.map((container) => ({
        id: container.Id,
        name: (container.Names?.[0] || '').replace(/^\//, ''),
        image: container.Image,
        state: container.State,
        status: container.Status,
      })),
    }
  },
)

export const getDockerStats = createIntegrationRead(
  'docker.manage',
  async () => {
    const dockerClient = (await panelRuntime()).dockerClient
    if (!dockerClient?.enabled || !dockerClient.available) {
      return { containers: {} }
    }

    const containers =
      (await dockerClient.listManagedContainers()) as ManagedDockerContainer[]
    const samples = await mapWithConcurrency(
      containers,
      3,
      async (container) => ({
        container,
        stats: await dockerClient.getContainerStats(container.Id),
      }),
    )
    const result: Record<string, unknown> = {}
    for (const { container, stats } of samples) {
      if (!stats) continue
      result[container.Id] = stats
      const name = (container.Names?.[0] || '').replace(/^\//, '')
      if (name) result[name] = stats
    }
    return { containers: result }
  },
)

export const runDockerAction = createIntegrationAction(
  'docker.manage',
  async (data) => {
    const { acquireLifecycleLock, lifecycleInProgressResponse } =
      await import('../../../panel-server/services/lifecycleCoordinator.ts')
    const id = String(data.id ?? '')
    const action = String(data.action ?? '')
    const lifecycleLock = acquireLifecycleLock('docker-' + action, id || null)
    if (!lifecycleLock) {
      throwIntegrationError(lifecycleInProgressResponse(), 409)
    }

    let rconService: AnyRecord | null = null
    try {
      const dockerClient = (await panelRuntime()).dockerClient
      if (!dockerClient?.enabled || !dockerClient.available) {
        throwIntegrationError(
          Object.assign(new Error('Docker control is unavailable'), {
            code: 'DOCKER_UNAVAILABLE',
          }),
          503,
        )
      }

      const { getServer } =
        await import('../../../panel-server/database/init.ts')
      const server = await getServer(data.serverId)
      if (!server) {
        throwIntegrationError(
          Object.assign(new Error('Server profile not found'), {
            code: 'SERVER_PROFILE_NOT_FOUND',
          }),
          404,
        )
      }
      if (
        server.dockerContainerName !== id &&
        server.dockerContainerId !== id
      ) {
        throwIntegrationError(
          Object.assign(new Error('Container is not mapped to this server'), {
            code: 'CONTAINER_NOT_MAPPED',
          }),
          403,
        )
      }

      const container = await dockerClient.inspectManagedContainer(id)
      if (!container) {
        throwIntegrationError(
          Object.assign(new Error('Container is not managed by this panel'), {
            code: 'CONTAINER_NOT_MANAGED',
          }),
          403,
        )
      }

      if (['stop', 'restart'].includes(action) && container.State?.Running) {
        const { RconService } =
          await import('../../../panel-server/services/rcon.ts')
        rconService = new RconService()
        await rconService.loadConfig(String(server.id))
        if (!(await rconService.connect())) {
          throwIntegrationError(
            Object.assign(
              new Error('RCON connection failed; container was not changed'),
              { code: 'DOCKER_ACTION_RCON_CONNECT_FAILED' },
            ),
            409,
          )
        }
        const saved = await rconService.save({ skipLog: true })
        if (!saved?.success) {
          const reason = saved?.error || 'unknown error'
          throwIntegrationError(
            Object.assign(new Error('World save failed: ' + reason), {
              code: 'DOCKER_ACTION_SAVE_FAILED',
              params: { reason },
            }),
            409,
          )
        }
      }

      const result = await dockerClient.runManagedAction(id, action)
      if (!result.success) {
        throwIntegrationError(
          Object.assign(new Error(sanitizeMessage(result.error || '')), result),
          403,
        )
      }
      return result
    } finally {
      if (rconService?.connected) {
        await rconService.disconnect().catch(() => {})
      }
      lifecycleLock.release()
    }
  },
)
