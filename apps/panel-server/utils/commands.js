export const PZ_COMMANDS = {
  save: {
    command: 'save',
    description: 'Save the current world',
    parameters: [],
    category: 'server'
  },
  quit: {
    command: 'quit',
    description: 'Save and quit the server',
    parameters: [],
    category: 'server'
  },
  servermsg: {
    command: 'servermsg',
    description: 'Broadcast a message to all connected players',
    parameters: [{ name: 'message', type: 'string', required: true }],
    category: 'server'
  },
  reloadoptions: {
    command: 'reloadoptions',
    description: 'Reload server options and send to clients',
    parameters: [],
    category: 'server'
  },
  changeoption: {
    command: 'changeoption',
    description: 'Change a server option',
    parameters: [
      { name: 'optionName', type: 'string', required: true },
      { name: 'newValue', type: 'string', required: true }
    ],
    category: 'server'
  },
  showoptions: {
    command: 'showoptions',
    description: 'Show the list of current server options and values',
    parameters: [],
    category: 'server'
  },
  checkModsNeedUpdate: {
    command: 'checkModsNeedUpdate',
    description: 'Check if any mods need updates',
    parameters: [],
    category: 'server'
  },

  players: {
    command: 'players',
    description: 'List all connected players',
    parameters: [],
    category: 'players'
  },
  kick: {
    command: 'kick',
    description: 'Kick a player from the server',
    parameters: [
      { name: 'username', type: 'string', required: true },
      { name: 'reason', type: 'string', required: false }
    ],
    category: 'players'
  },
  banuser: {
    command: 'banuser',
    description: 'Ban a user. Can also ban IP with -ip flag',
    parameters: [
      { name: 'username', type: 'string', required: true },
      { name: 'banIp', type: 'boolean', required: false },
      { name: 'reason', type: 'string', required: false }
    ],
    category: 'players'
  },
  unbanuser: {
    command: 'unbanuser',
    description: 'Unban a player',
    parameters: [{ name: 'username', type: 'string', required: true }],
    category: 'players'
  },
  banid: {
    command: 'banid',
    description: 'Ban a SteamID',
    parameters: [{ name: 'steamId', type: 'string', required: true }],
    category: 'players'
  },
  unbanid: {
    command: 'unbanid',
    description: 'Unban a SteamID',
    parameters: [{ name: 'steamId', type: 'string', required: true }],
    category: 'players'
  },
  setaccesslevel: {
    command: 'setaccesslevel',
    description: 'Set access level: admin, moderator, overseer, gm, observer, none',
    parameters: [
      { name: 'username', type: 'string', required: true },
      { name: 'level', type: 'string', required: true }
    ],
    category: 'players'
  },
  voiceban: {
    command: 'voiceban',
    description: 'Block/unblock voice from a user',
    parameters: [
      { name: 'username', type: 'string', required: true },
      { name: 'value', type: 'boolean', required: true }
    ],
    category: 'players'
  },

  adduser: {
    command: 'adduser',
    description: 'Add a new user to a whitelisted server (password optional)',
    parameters: [
      { name: 'username', type: 'string', required: true },
      { name: 'password', type: 'string', required: false }
    ],
    category: 'whitelist'
  },
  addsteamid: {
    command: 'addSteamID',
    description: 'Add a SteamID to the allowed SteamID list',
    parameters: [{ name: 'steamId', type: 'string', required: true }],
    category: 'whitelist'
  },
  removesteamid: {
    command: 'removeSteamID',
    description: 'Remove a SteamID from the allowed SteamID list',
    parameters: [{ name: 'steamId', type: 'string', required: true }],
    category: 'whitelist'
  },
  removeuserfromwhitelist: {
    command: 'removeuserfromwhitelist',
    description: 'Remove a user from whitelist',
    parameters: [{ name: 'username', type: 'string', required: true }],
    category: 'whitelist'
  },

  teleport: {
    command: 'teleport',
    description: 'Teleport to a player or teleport player1 to player2',
    parameters: [
      { name: 'player1', type: 'string', required: true },
      { name: 'player2', type: 'string', required: false }
    ],
    category: 'teleport'
  },
  teleportto: {
    command: 'teleportto',
    description: 'Teleport to coordinates x,y,z',
    parameters: [
      { name: 'x', type: 'number', required: true },
      { name: 'y', type: 'number', required: true },
      { name: 'z', type: 'number', required: true }
    ],
    category: 'teleport'
  },

  additem: {
    command: 'additem',
    description: 'Give an item to a player',
    parameters: [
      { name: 'username', type: 'string', required: false },
      { name: 'item', type: 'string', required: true },
      { name: 'count', type: 'number', required: false }
    ],
    category: 'items'
  },
  addxp: {
    command: 'addxp',
    description: 'Give XP to a player',
    parameters: [
      { name: 'username', type: 'string', required: true },
      { name: 'perk', type: 'string', required: true },
      { name: 'amount', type: 'number', required: true }
    ],
    category: 'items'
  },
  addvehicle: {
    command: 'addvehicle',
    description: 'Spawn a vehicle',
    parameters: [
      { name: 'vehicle', type: 'string', required: true },
      { name: 'username', type: 'string', required: false }
    ],
    category: 'items'
  },

  startrain: {
    command: 'startrain',
    description: 'Start rain on the server',
    parameters: [{ name: 'intensity', type: 'number', required: false }],
    category: 'weather'
  },
  stoprain: {
    command: 'stoprain',
    description: 'Stop rain on the server',
    parameters: [],
    category: 'weather'
  },
  startstorm: {
    command: 'startstorm',
    description: 'Start a storm (duration in game hours)',
    parameters: [{ name: 'duration', type: 'number', required: false }],
    category: 'weather'
  },
  stopweather: {
    command: 'stopweather',
    description: 'Stop all weather on the server',
    parameters: [],
    category: 'weather'
  },
  chopper: {
    command: 'chopper',
    description: 'Trigger helicopter event on random player',
    parameters: [],
    category: 'events'
  },
  gunshot: {
    command: 'gunshot',
    description: 'Trigger gunshot sound on random player',
    parameters: [],
    category: 'events'
  },
  lightning: {
    command: 'lightning',
    description: 'Strike lightning on player',
    parameters: [{ name: 'username', type: 'string', required: false }],
    category: 'events'
  },
  thunder: {
    command: 'thunder',
    description: 'Thunder sound on player',
    parameters: [{ name: 'username', type: 'string', required: false }],
    category: 'events'
  },
  alarm: {
    command: 'alarm',
    description: 'Sound building alarm at admin position',
    parameters: [],
    category: 'events'
  },
  createhorde: {
    command: 'createhorde',
    description: 'Spawn a horde near a player',
    parameters: [
      { name: 'count', type: 'number', required: true },
      { name: 'username', type: 'string', required: false }
    ],
    category: 'events'
  },

  godmod: {
    command: 'godmod',
    description: 'Make player invincible',
    parameters: [
      { name: 'username', type: 'string', required: false },
      { name: 'value', type: 'boolean', required: true }
    ],
    category: 'admin'
  },
  invisible: {
    command: 'invisible',
    description: 'Make player invisible to zombies',
    parameters: [
      { name: 'username', type: 'string', required: false },
      { name: 'value', type: 'boolean', required: true }
    ],
    category: 'admin'
  },
  noclip: {
    command: 'noclip',
    description: 'Allow player to pass through walls',
    parameters: [
      { name: 'username', type: 'string', required: false },
      { name: 'value', type: 'boolean', required: true }
    ],
    category: 'admin'
  },

  releasesafehouse: {
    command: 'releasesafehouse',
    description: 'Release a safehouse you own',
    parameters: [],
    category: 'safehouse'
  },

  reloadlua: {
    command: 'reloadlua',
    description: 'Reload a Lua script on the server',
    parameters: [{ name: 'filename', type: 'string', required: true }],
    category: 'advanced'
  },

  log: {
    command: 'log',
    description: 'Set log level for a specific type',
    parameters: [
      { name: 'type', type: 'string', required: true },
      { name: 'level', type: 'string', required: true }
    ],
    category: 'advanced'
  },

  stats: {
    command: 'stats',
    description: 'Set and clear server statistics',
    parameters: [
      { name: 'mode', type: 'string', required: true },
      { name: 'period', type: 'number', required: false }
    ],
    category: 'advanced'
  },

  removezombies: {
    command: 'removezombies',
    description: 'Remove zombies from the server',
    parameters: [],
    category: 'events'
  },

  clear: {
    command: 'clear',
    description: 'Clear the server console',
    parameters: [],
    category: 'server'
  }
};

export const VEHICLES = [
  'Base.VanAmbulance',
  'Base.CarLightsPolice',
  'Base.PickUpTruck',
  'Base.PickUpTruckMccoy',
  'Base.StepVan',
  'Base.Van',
  'Base.CarStationWagon',
  'Base.CarStationWagon2',
  'Base.CarNormal',
  'Base.CarNormal2',
  'Base.CarNormal3',
  'Base.CarNormal4',
  'Base.SmallCar',
  'Base.SmallCar02',
  'Base.SportsCar',
  'Base.PickUpVanMccoy',
  'Base.OffRoad',
  'Base.SUV',
  'Base.Taxi',
  'Base.CarTaxi',
  'Base.CarLights',
  'Base.PickUpTruckLights',
  'Base.PickUpTruckLightsFire',
  'Base.VanRadio',
  'Base.VanSeats',
  'Base.CarLightsFireDept',
  'Base.VanSpecial',
  'Base.VanSpiffo',
  'Base.Trailer',
  'Base.TrailerAdvert'
];

export const PERK_CATALOG = [
  { id: 'Aiming', label: 'Aiming', category: 'Combat - Firearms' },
  { id: 'Reloading', label: 'Reloading', category: 'Combat - Firearms' },

  { id: 'Axe', label: 'Axe', category: 'Combat - Melee' },
  { id: 'LongBlade', label: 'Long Blade', category: 'Combat - Melee' },
  { id: 'Blunt', label: 'Long Blunt', category: 'Combat - Melee' },
  { id: 'Maintenance', label: 'Maintenance', category: 'Combat - Melee' },
  { id: 'SmallBlade', label: 'Short Blade', category: 'Combat - Melee' },
  { id: 'SmallBlunt', label: 'Short Blunt', category: 'Combat - Melee' },
  { id: 'Spear', label: 'Spear', category: 'Combat - Melee' },

  { id: 'Blacksmith', label: 'Blacksmithing', category: 'Crafting' },
  { id: 'Woodwork', label: 'Carpentry', category: 'Crafting' },
  { id: 'Carving', label: 'Carving', category: 'Crafting' },
  { id: 'Cooking', label: 'Cooking', category: 'Crafting' },
  { id: 'Electricity', label: 'Electrical', category: 'Crafting' },
  { id: 'Glassmaking', label: 'Glassmaking', category: 'Crafting' },
  { id: 'FlintKnapping', label: 'Knapping', category: 'Crafting' },
  { id: 'Masonry', label: 'Masonry', category: 'Crafting' },
  { id: 'Mechanics', label: 'Mechanics', category: 'Crafting' },
  { id: 'Pottery', label: 'Pottery', category: 'Crafting' },
  { id: 'Tailoring', label: 'Tailoring', category: 'Crafting' },
  { id: 'MetalWelding', label: 'Welding', category: 'Crafting' },

  { id: 'Farming', label: 'Agriculture', category: 'Farming' },
  { id: 'Husbandry', label: 'Animal Care', category: 'Farming' },
  { id: 'Butchering', label: 'Butchering', category: 'Farming' },

  { id: 'Fitness', label: 'Fitness', category: 'Physical' },
  { id: 'Lightfoot', label: 'Lightfooted', category: 'Physical' },
  { id: 'Nimble', label: 'Nimble', category: 'Physical' },
  { id: 'Sprinting', label: 'Running', category: 'Physical' },
  { id: 'Sneak', label: 'Sneaking', category: 'Physical' },
  { id: 'Strength', label: 'Strength', category: 'Physical' },

  { id: 'Doctor', label: 'First Aid', category: 'Survival' },
  { id: 'Fishing', label: 'Fishing', category: 'Survival' },
  { id: 'PlantScavenging', label: 'Foraging', category: 'Survival' },
  { id: 'Tracking', label: 'Tracking', category: 'Survival' },
  { id: 'Trapping', label: 'Trapping', category: 'Survival' },
];

export const PERKS = PERK_CATALOG.map((perk) => perk.id);


export const ACCESS_LEVELS = [
  'admin',
  'moderator',
  'gm',
  'observer',
  'priority',
  'user',
  'none'
];
