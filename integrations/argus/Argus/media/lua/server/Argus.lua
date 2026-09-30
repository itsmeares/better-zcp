---@diagnostic disable: undefined-global, deprecated

local Argus = { VERSION = "1.0.0", PROTOCOL = 1, POLL_MS = 250, STATUS_MS = 1000 }
local json = { null = {} }
local handlers = {}
local serverName, basePath, session, gameVersion
local supportedBuild = false
local processedRequestIds = {}
local lastPoll, lastStatus
local initialized = false
local unpack = unpack or table.unpack

local function array(values)
    values = values or {}
    return setmetatable(values, { __json_array = true })
end

local function encodeString(value)
    return '"' .. tostring(value):gsub('[%z\1-\31\\"]', function(c)
        local escapes = { ['\\'] = '\\\\', ['"'] = '\\"', ['\b'] = '\\b', ['\f'] = '\\f', ['\n'] = '\\n', ['\r'] = '\\r', ['\t'] = '\\t' }
        return escapes[c] or string.format('\\u%04x', string.byte(c))
    end) .. '"'
end

local function isArray(value)
    local mt = getmetatable(value)
    if mt and mt.__json_array then return true end
    local count, max = 0, 0
    for key in pairs(value) do
        if type(key) ~= "number" or key < 1 or key % 1 ~= 0 then return false end
        count = count + 1
        if key > max then max = key end
    end
    return count > 0 and count == max
end

local function encode(value, depth)
    depth = depth or 0
    if depth > 64 or value == nil or value == json.null then return "null" end
    local kind = type(value)
    if kind == "boolean" then return value and "true" or "false" end
    if kind == "number" then
        if value ~= value or value == math.huge or value == -math.huge then return "null" end
        return tostring(value)
    end
    if kind == "string" then return encodeString(value) end
    if kind ~= "table" then return "null" end

    local parts = {}
    if isArray(value) then
        for i = 1, #value do parts[i] = encode(value[i], depth + 1) end
        return "[" .. table.concat(parts, ",") .. "]"
    end
    for key, item in pairs(value) do
        parts[#parts + 1] = encodeString(tostring(key)) .. ":" .. encode(item, depth + 1)
    end
    return "{" .. table.concat(parts, ",") .. "}"
end

local function appendUtf8(out, code)
    if code < 0x80 then
        out[#out + 1] = string.char(code)
    elseif code < 0x800 then
        out[#out + 1] = string.char(0xC0 + math.floor(code / 0x40), 0x80 + code % 0x40)
    elseif code < 0x10000 then
        out[#out + 1] = string.char(0xE0 + math.floor(code / 0x1000), 0x80 + math.floor(code / 0x40) % 0x40, 0x80 + code % 0x40)
    else
        out[#out + 1] = string.char(0xF0 + math.floor(code / 0x40000), 0x80 + math.floor(code / 0x1000) % 0x40, 0x80 + math.floor(code / 0x40) % 0x40, 0x80 + code % 0x40)
    end
end

function json.decode(source)
    if type(source) ~= "string" then error("JSON input must be a string") end
    local pos, length = 1, #source

    local function whitespace()
        while pos <= length and source:sub(pos, pos):match("[ \t\r\n]") do pos = pos + 1 end
    end

    local function parseString()
        if source:sub(pos, pos) ~= '"' then error("Expected string") end
        pos = pos + 1
        local out, start = {}, pos
        while pos <= length do
            local c = source:sub(pos, pos)
            if c == '"' then
                out[#out + 1] = source:sub(start, pos - 1)
                pos = pos + 1
                return table.concat(out)
            elseif c == "\\" then
                out[#out + 1] = source:sub(start, pos - 1)
                pos = pos + 1
                local escape = source:sub(pos, pos)
                local simple = { ['"'] = '"', ["\\"] = "\\", ["/"] = "/", b = "\b", f = "\f", n = "\n", r = "\r", t = "\t" }
                if simple[escape] then
                    out[#out + 1] = simple[escape]
                    pos = pos + 1
                elseif escape == "u" then
                    local hex = source:sub(pos + 1, pos + 4)
                    local code = hex:match("^%x%x%x%x$") and tonumber(hex, 16)
                    if not code then error("Invalid Unicode escape") end
                    pos = pos + 5
                    if code >= 0xD800 and code <= 0xDBFF and source:sub(pos, pos + 1) == "\\u" then
                        local lowHex = source:sub(pos + 2, pos + 5)
                        local low = lowHex:match("^%x%x%x%x$") and tonumber(lowHex, 16)
                        if low and low >= 0xDC00 and low <= 0xDFFF then
                            code = 0x10000 + (code - 0xD800) * 0x400 + (low - 0xDC00)
                            pos = pos + 6
                        end
                    end
                    appendUtf8(out, code)
                else
                    error("Invalid string escape")
                end
                start = pos
            elseif string.byte(c) < 0x20 then
                error("Unescaped control character")
            else
                pos = pos + 1
            end
        end
        error("Unterminated string")
    end

    local function parseNumber()
        local start = pos
        if source:sub(pos, pos) == "-" then pos = pos + 1 end
        local first = source:sub(pos, pos)
        if first == "0" then
            pos = pos + 1
            if source:sub(pos, pos):match("%d") then error("Leading zero in number") end
        else
            if not first:match("[1-9]") then error("Invalid number") end
            repeat pos = pos + 1 until not source:sub(pos, pos):match("%d")
        end
        if source:sub(pos, pos) == "." then
            pos = pos + 1
            if not source:sub(pos, pos):match("%d") then error("Invalid fraction") end
            repeat pos = pos + 1 until not source:sub(pos, pos):match("%d")
        end
        local exponent = source:sub(pos, pos)
        if exponent == "e" or exponent == "E" then
            pos = pos + 1
            local sign = source:sub(pos, pos)
            if sign == "+" or sign == "-" then pos = pos + 1 end
            if not source:sub(pos, pos):match("%d") then error("Invalid exponent") end
            repeat pos = pos + 1 until not source:sub(pos, pos):match("%d")
        end
        local number = tonumber(source:sub(start, pos - 1))
        if not number or number == math.huge or number == -math.huge then error("Invalid number") end
        return number
    end

    local parseValue
    parseValue = function(depth)
        if depth > 64 then error("JSON nesting too deep") end
        whitespace()
        local c = source:sub(pos, pos)
        if c == '"' then return parseString() end
        if c == "{" then
            pos = pos + 1
            local object = {}
            whitespace()
            if source:sub(pos, pos) == "}" then pos = pos + 1; return object end
            while true do
                whitespace()
                local key = parseString()
                whitespace()
                if source:sub(pos, pos) ~= ":" then error("Expected colon") end
                pos = pos + 1
                object[key] = parseValue(depth + 1)
                whitespace()
                local delimiter = source:sub(pos, pos)
                if delimiter == "}" then pos = pos + 1; return object end
                if delimiter ~= "," then error("Expected object delimiter") end
                pos = pos + 1
            end
        end
        if c == "[" then
            pos = pos + 1
            local result = array()
            whitespace()
            if source:sub(pos, pos) == "]" then pos = pos + 1; return result end
            while true do
                result[#result + 1] = parseValue(depth + 1)
                whitespace()
                local delimiter = source:sub(pos, pos)
                if delimiter == "]" then pos = pos + 1; return result end
                if delimiter ~= "," then error("Expected array delimiter") end
                pos = pos + 1
            end
        end
        if source:sub(pos, pos + 3) == "true" then pos = pos + 4; return true end
        if source:sub(pos, pos + 4) == "false" then pos = pos + 5; return false end
        if source:sub(pos, pos + 3) == "null" then pos = pos + 4; return json.null end
        if c == "-" or c:match("%d") then return parseNumber() end
        error("Invalid JSON value")
    end

    local result = parseValue(0)
    whitespace()
    if pos <= length then error("Trailing JSON data") end
    return result
end

local function nowMs()
    local ok, value = pcall(function() return getTimestampMs() end)
    return ok and tonumber(value) or 0
end

local function call(object, method, ...)
    if object == nil then return false, "Object is unavailable" end
    local args = { ... }
    local count = select("#", ...)
    return pcall(function() return object[method](object, unpack(args, 1, count)) end)
end

local function get(object, method)
    local ok, value = call(object, method)
    if ok then return value end
    return nil
end

local function scalar(value)
    local kind = type(value)
    if kind == "string" or kind == "number" or kind == "boolean" then return value end
    return nil
end

local function safeString(object, method)
    local value = get(object, method)
    if value == nil then return nil end
    local ok, result = pcall(tostring, value)
    return ok and result or nil
end

local function getConfiguredServerName()
    local getter = rawget(_G, "getServerName")
    local ok, value = pcall(function() return getter and getter() end)
    if ok and value and tostring(value) ~= "" then return tostring(value) end
    return "default"
end

local function getGameVersion()
    local ok, value = pcall(function()
        local core = getCore and getCore()
        return core and core:getVersion()
    end)
    return ok and value and tostring(value) or "unknown"
end

local function newSession()
    local ok, value = pcall(function() return getRandomUUID() end)
    if ok and value and tostring(value) ~= "" then return tostring(value) end
    return tostring(nowMs()) .. "-" .. tostring({})
end

local function readFile(path, maxBytes)
    local ok, reader = pcall(function() return getFileReader(path, false) end)
    if not ok or not reader then return nil end
    local lines, bytes = {}, 0
    local readOk = pcall(function()
        local line = reader:readLine()
        while line ~= nil do
            bytes = bytes + #line + 1
            if bytes > maxBytes then error("File exceeds size limit") end
            lines[#lines + 1] = line
            line = reader:readLine()
        end
    end)
    pcall(function() reader:close() end)
    if not readOk then return nil end
    return table.concat(lines, "\n")
end

local function writeFile(path, content)
    local ok, writer = pcall(function() return getFileWriter(path, true, false) end)
    if not ok or not writer then return false end
    local writeOk = pcall(function() writer:write(content) end)
    local closeOk = pcall(function() writer:close() end)
    return writeOk and closeOk
end

local function writeJSON(path, value)
    return writeFile(path, encode(value))
end

local function statGet(stats, name)
    if not stats or not CharacterStat then return nil end
    local ok, value = pcall(function() return CharacterStat[name] end)
    if not ok or value == nil then return nil end
    local got, result = call(stats, "get", value)
    return got and scalar(result) or nil
end

local function findPlayer(username)
    if type(username) ~= "string" or username == "" then return nil end
    local players = getOnlinePlayers and getOnlinePlayers()
    if not players then return nil end
    local ok, count = call(players, "size")
    if not ok then return nil end
    local wanted = username:lower()
    for i = 0, count - 1 do
        local got, player = call(players, "get", i)
        if got and player then
            local name = safeString(player, "getUsername")
            if name and name:lower() == wanted then return player end
        end
    end
    return nil
end

local function playerDetails(player)
    local stats = get(player, "getStats")
    local body = get(player, "getBodyDamage")
    local details = {
        username = safeString(player, "getUsername"),
        displayName = safeString(player, "getDisplayName"),
        x = scalar(get(player, "getX")),
        y = scalar(get(player, "getY")),
        z = scalar(get(player, "getZ")),
        accessLevel = safeString(player, "getAccessLevel"),
        isAlive = scalar(get(player, "isAlive")),
        isAsleep = scalar(get(player, "isAsleep")),
        isSneaking = scalar(get(player, "isSneaking")),
        isRunning = scalar(get(player, "isRunning")),
        godMod = scalar(get(player, "isGodMod")),
        invisible = scalar(get(player, "isInvisible")),
        noclip = scalar(get(player, "isNoClip")),
    }
    if stats then
        details.hunger = statGet(stats, "HUNGER")
        details.thirst = statGet(stats, "THIRST")
        details.fatigue = statGet(stats, "FATIGUE")
        details.stats = {
            hunger = details.hunger,
            thirst = details.thirst,
            fatigue = details.fatigue,
            stress = statGet(stats, "STRESS"),
            boredom = statGet(stats, "BOREDOM"),
            unhappiness = statGet(stats, "UNHAPPINESS"),
            pain = statGet(stats, "PAIN"),
            endurance = statGet(stats, "ENDURANCE"),
        }
    end
    if body then
        local bleeding = get(body, "getNumPartsBleeding")
        local thermo = get(body, "getThermoregulator")
        details.health = {
            overallBodyHealth = scalar(get(body, "getOverallBodyHealth")),
            isInfected = scalar(get(body, "IsInfected")),
            health = scalar(get(body, "getHealth")),
            temperature = thermo and scalar(get(thermo, "getCoreTemperature")) or nil,
        }
        if type(bleeding) == "number" then details.health.isBleeding = bleeding > 0 end
        details.healthValue = details.health.overallBodyHealth
        details.isInfected = details.health.isInfected
    end
    return details
end

local function gameTimeSnapshot()
    local time = getGameTime and getGameTime()
    if not time then return nil end
    local hour = get(time, "getHour")
    local minute = get(time, "getMinutes")
    if hour == nil then
        local fraction = get(time, "getTimeOfDay")
        if type(fraction) == "number" then
            hour = math.floor(fraction)
            minute = math.floor((fraction - hour) * 60)
        end
    end
    local month = get(time, "getMonth")
    return {
        day = scalar(get(time, "getDay")),
        month = type(month) == "number" and month + 1 or nil,
        year = scalar(get(time, "getYear")),
        hour = scalar(hour),
        minute = scalar(minute),
    }
end

local function buildSnapshot()
    local names, details = array(), array()
    local onlinePlayers = getOnlinePlayers and getOnlinePlayers()
    local count = 0
    if onlinePlayers then
        local ok, size = call(onlinePlayers, "size")
        if ok then count = tonumber(size) or 0 end
    end
    for i = 0, count - 1 do
        local ok, player = call(onlinePlayers, "get", i)
        if ok and player then
            local detail = playerDetails(player)
            if detail.username then
                names[#names + 1] = detail.username
                details[#details + 1] = detail
            end
        end
    end
    local world = getWorld and getWorld()
    local gameTime = gameTimeSnapshot()
    return {
        protocol = Argus.PROTOCOL,
        version = Argus.VERSION,
        session = session,
        serverName = serverName,
        gameVersion = gameVersion,
        supported = supportedBuild,
        playerCount = #names,
        players = names,
        playerDetails = details,
        gameTime = gameTime,
        world = {
            serverName = serverName,
            map = world and safeString(world, "getMap") or nil,
            gameTime = gameTime,
        },
        updatedAt = nowMs(),
    }
end

handlers.ping = function()
    local snapshot = buildSnapshot()
    return true, { message = "pong", version = Argus.VERSION, gameVersion = gameVersion, serverTime = nowMs(), playerCount = snapshot.playerCount }
end

handlers.getAllSandboxOptions = function()
    local sandbox = getSandboxOptions and getSandboxOptions()
    if not sandbox then return false, nil, "SandboxOptions unavailable" end
    local ok, count = call(sandbox, "getNumOptions")
    if not ok or type(count) ~= "number" then return false, nil, "SandboxOptions.getNumOptions unavailable" end
    local options, total = {}, 0
    for i = 0, count - 1 do
        local got, option = call(sandbox, "getOptionByIndex", i)
        if got and option then
            local name = safeString(option, "getName")
            if name then
                local value = scalar(get(option, "getValue"))
                local className = safeString(option, "getClass") or ""
                local kind
                if className:find("Boolean", 1, true) then kind = "boolean"
                elseif className:find("Enum", 1, true) then kind = "enum"
                elseif className:find("Double", 1, true) then kind = "number"
                elseif className:find("Integer", 1, true) then kind = "integer"
                elseif className:find("String", 1, true) then kind = "string"
                else kind = className end
                local item = {
                    name = name,
                    shortName = safeString(option, "getShortName"),
                    tableName = safeString(option, "getTableName"),
                    tooltip = safeString(option, "getTooltip"),
                    translatedName = safeString(option, "getTranslatedName"),
                    pageName = safeString(option, "getPageName"),
                    value = value,
                    type = kind,
                    default = scalar(get(option, "getDefaultValue")),
                    isCustom = scalar(get(option, "isCustom")),
                }
                if kind == "enum" then
                    local numValues = tonumber(get(option, "getNumValues")) or 0
                    item.min = 1
                    item.max = numValues
                elseif kind == "number" or kind == "integer" then
                    item.min = scalar(get(option, "getMin"))
                    item.max = scalar(get(option, "getMax"))
                end
                if item.tooltip then item.tooltipText = item.tooltip end
                if kind == "enum" then
                    item.selectedIndex = value
                    local numValues = tonumber(get(option, "getNumValues")) or 0
                    if numValues > 0 then
                        item.enumValues = array()
                        for index = 1, math.min(numValues, 50) do
                            local transOk, trans = call(option, "getValueTranslationByIndexOrNull", index)
                            if transOk and trans ~= nil then
                                item.enumValues[#item.enumValues + 1] = tostring(trans)
                            elseif trans == nil then
                                local labelOk, label = call(option, "getValueTranslationByIndex", index)
                                if labelOk and label ~= nil then item.enumValues[#item.enumValues + 1] = tostring(label) end
                            end
                        end
                    end
                end
                local group = item.tableName and item.tableName ~= "" and item.tableName or "Vanilla"
                options[group] = options[group] or array()
                options[group][#options[group] + 1] = item
                total = total + 1
            end
        end
    end
    local groups = array()
    for group, entries in pairs(options) do
        table.sort(entries, function(a, b) return a.name < b.name end)
        groups[#groups + 1] = { name = group, count = #entries }
    end
    table.sort(groups, function(a, b) return a.name < b.name end)
    return true, { options = options, groups = groups, totalCount = total, enumerated = true }
end

local function isFiniteNumber(value)
    return type(value) == "number" and value == value and value ~= math.huge and value ~= -math.huge
end

handlers.setSandboxOption = function(args)
    args = type(args) == "table" and args or {}
    if type(args.name) ~= "string" or args.name == "" or args.value == nil or args.value == json.null then
        return false, nil, "Sandbox option name and value are required"
    end
    local sandbox = getSandboxOptions and getSandboxOptions()
    if not sandbox then return false, nil, "SandboxOptions unavailable" end
    local ok, option = call(sandbox, "getOptionByName", args.name)
    if not ok or not option then return false, nil, "Sandbox option not found: " .. args.name end
    local className = safeString(option, "getClass") or ""
    local kind = className:find("Boolean", 1, true) and "boolean"
        or className:find("Enum", 1, true) and "enum"
        or className:find("Integer", 1, true) and "integer"
        or className:find("Double", 1, true) and "number"
        or className:find("String", 1, true) and "string"
    if not kind then return false, nil, "Unsupported sandbox option type: " .. className end

    local value = args.value
    if kind == "boolean" then
        if type(value) ~= "boolean" then return false, nil, "Boolean option requires true or false" end
    elseif kind == "enum" or kind == "integer" or kind == "number" then
        if not isFiniteNumber(value) then return false, nil, "Numeric option requires a finite number" end
        if kind == "enum" or kind == "integer" then
            if value % 1 ~= 0 then return false, nil, "Integer option requires a whole number" end
        end
        local min, max
        if kind == "enum" then
            min = 1
            max = tonumber(get(option, "getNumValues"))
        else
            min = tonumber(get(option, "getMin"))
            max = tonumber(get(option, "getMax"))
        end
        if not min or not max then return false, nil, "Sandbox option range is unavailable" end
        if min and value < min then return false, nil, "Sandbox option value is below its minimum" end
        if max and value > max then return false, nil, "Sandbox option value is above its maximum" end
    else
        if type(value) ~= "string" then return false, nil, "String option requires a string" end
    end

    local setOk, setErr = call(option, "setValue", value)
    if not setOk then return false, { name = args.name, value = value, verified = false, applied = false }, "Sandbox option update failed: " .. tostring(setErr) end
    local luaOk, luaErr = call(sandbox, "toLua")
    if not luaOk then return false, { name = args.name, value = value, verified = false, applied = true }, "Sandbox option applied but toLua failed: " .. tostring(luaErr) end
    local readOk, confirmed = call(option, "getValue")
    if not readOk or scalar(confirmed) == nil then
        return false, { name = args.name, value = value, verified = false, applied = true }, "Sandbox option applied but its live value could not be read back"
    end
    local matches = confirmed == value
    local data = { name = args.name, value = confirmed, verified = matches, applied = true }
    if not matches then return false, data, "Sandbox option read-back did not match the requested value" end
    return true, data
end

handlers.healPlayer = function(args)
    local username = args.username
    local player = findPlayer(username)
    if not player then return false, nil, "Player not found: " .. tostring(username or "") end
    if type(sendDamage) ~= "function" then return false, nil, "Build 42 sendDamage is unavailable; player health was not changed" end
    local body = get(player, "getBodyDamage")
    if not body then return false, nil, "Player body damage is unavailable" end
    local healed, healErr = call(body, "RestoreToFullHealth")
    if not healed then return false, nil, "Full body healing failed: " .. tostring(healErr) end
    local syncOk, syncErr = pcall(function() sendDamage(player) end)
    if not syncOk then return false, { username = username, applied = true }, "Player was healed on the server but damage sync failed: " .. tostring(syncErr) end
    local readOk, health = call(body, "getOverallBodyHealth")
    if not readOk or type(health) ~= "number" or health < 99.9 then
        return false, { username = username, health = scalar(health), applied = true, verified = false }, "Healing did not verify at full body health"
    end
    return true, { message = "Player healed", username = username, health = health, applied = true, verified = true }
end

handlers.killPlayer = function(args)
    local username = args.username
    local player = findPlayer(username)
    if not player then return false, nil, "Player not found: " .. tostring(username or "") end
    if type(sendDamage) ~= "function" then return false, nil, "Build 42 sendDamage is unavailable; player was not changed" end
    local deadOk, dead = call(player, "isDead")
    if not deadOk or type(dead) ~= "boolean" then return false, nil, "Player death state cannot be verified" end
    if dead then return true, { username = username, isDead = true, alreadyDead = true, verified = true } end

    local godOk, godMode = call(player, "isGodMod")
    if not godOk or type(godMode) ~= "boolean" then return false, nil, "Player god mode state cannot be verified" end
    local changedGodMode = false
    local function restoreGodMode()
        local restored, restoreErr = call(player, "setGodMod", true, true)
        local verified, enabled = call(player, "isGodMod")
        if not restored or not verified or enabled ~= true then return false, restoreErr end
        return true
    end
    if godMode then
        local offOk, offErr = call(player, "setGodMod", false, true)
        if not offOk then return false, nil, "Could not disable god mode for the kill: " .. tostring(offErr) end
        changedGodMode = true
        local verifyOk, isGod = call(player, "isGodMod")
        if not verifyOk or isGod ~= false then
            local restored = restoreGodMode()
            return false, { godModeChanged = true, godModeRestored = restored }, "God mode could not be disabled; player was not killed"
        end
    end
    local killOk, killErr = call(player, "Kill", nil)
    local verifyOk, isDead = call(player, "isDead")
    if not verifyOk or isDead ~= true then
        local godModeRestored
        if changedGodMode then godModeRestored = restoreGodMode() end
        return false, { username = username, isDead = isDead == true, godModeRestored = godModeRestored }, "Kill did not verify: " .. tostring(killErr or "player remains alive")
    end
    local syncOk, syncErr = pcall(function() sendDamage(player) end)
    if not syncOk then return false, { username = username, isDead = true, verified = true, applied = true }, "Player died on the server but damage sync failed: " .. tostring(syncErr) end
    return true, { message = "Player killed", username = username, isDead = true, verified = true }
end

handlers.getItemCatalog = function()
    local manager = type(getScriptManager) == "function" and getScriptManager() or nil
    if not manager then return false, nil, "ScriptManager unavailable" end
    local ok, items = call(manager, "getAllItems")
    if not ok or not items then return false, nil, "ScriptManager.getAllItems failed" end
    local sizeOk, size = call(items, "size")
    if not sizeOk or type(size) ~= "number" then return false, nil, "Item list size unavailable" end
    local catalog = array()
    for i = 0, size - 1 do
        local itemOk, scriptItem = call(items, "get", i)
        if itemOk and scriptItem then
            local id = safeString(scriptItem, "getFullName") or safeString(scriptItem, "getName")
            if id then
                local category = safeString(scriptItem, "getDisplayCategory")
                if not category or category == "" then category = id:match("^([^%.]+)%.") end
                catalog[#catalog + 1] = {
                    id = id,
                    name = safeString(scriptItem, "getDisplayName") or id,
                    category = category or "Other",
                    weight = scalar(get(scriptItem, "getActualWeight")),
                }
            end
        end
    end
    return true, { items = catalog, count = #catalog }
end

local function respond(id, success, data, errorMessage)
    local response = {
        protocol = Argus.PROTOCOL,
        version = Argus.VERSION,
        session = session,
        id = id,
        success = success,
        data = data,
        error = errorMessage,
        completedAt = nowMs(),
    }
    return writeJSON(basePath .. "response.json.txt", response)
end

local function processRequest()
    local content = readFile(basePath .. "request.json", 65536)
    if not content or content == "" then return end
    local ok, request = pcall(json.decode, content)
    if not ok or type(request) ~= "table" or type(request.id) ~= "string" or request.id == "" or #request.id > 128 then return end
    if processedRequestIds[request.id] then return end
    processedRequestIds[request.id] = true
    if request.session ~= session then respond(request.id, false, nil, "Request belongs to a different server session"); return end
    if type(request.expiresAt) ~= "number" or request.expiresAt <= nowMs() or request.expiresAt > nowMs() + 60000 then
        respond(request.id, false, nil, "Request is expired or has an invalid expiry"); return
    end
    if not supportedBuild then respond(request.id, false, nil, "Argus requires Project Zomboid Build 42"); return end
    if type(request.action) ~= "string" or type(handlers[request.action]) ~= "function" then
        respond(request.id, false, nil, "Unsupported game action"); return
    end
    if request.args ~= nil and type(request.args) ~= "table" then respond(request.id, false, nil, "Request args must be an object"); return end
    local args = request.args or {}
    local runOk, success, data, errorMessage = pcall(handlers[request.action], args)
    if not runOk then
        respond(request.id, false, nil, "Game action failed: " .. tostring(success))
    else
        respond(request.id, success == true, data, errorMessage)
    end
end

local function updateStatus()
    local ok, snapshot = pcall(buildSnapshot)
    if ok then writeJSON(basePath .. "status.json.txt", snapshot) end
end

function Argus.onServerStarted()
    if isServer and not isServer() then return end
    initialized = false
    serverName = getConfiguredServerName()
    if not serverName:match("^[A-Za-z0-9_ %-]+$") or #serverName > 64 then
        print("[Argus] Invalid server name; integration is not starting")
        return
    end
    basePath = "argus/" .. serverName .. "/"
    session = newSession()
    gameVersion = getGameVersion()
    supportedBuild = gameVersion:match("^42[%.%-]") ~= nil or gameVersion == "42"
    initialized = true
    processedRequestIds = {}
    lastPoll, lastStatus = nil, nil
    updateStatus()
    print("[Argus] v" .. Argus.VERSION .. " started for " .. serverName .. " (" .. gameVersion .. ")")
end

function Argus.onTick()
    if not initialized then return end
    local now = nowMs()
    if lastPoll == nil or now - lastPoll >= Argus.POLL_MS then
        lastPoll = now
        local ok, err = pcall(processRequest)
        if not ok then print("[Argus] Request error: " .. tostring(err)) end
    end
    if lastStatus == nil or now - lastStatus >= Argus.STATUS_MS then
        lastStatus = now
        updateStatus()
    end
end

Argus.handlers = handlers
Argus.json = json
Argus.getBasePath = function() return basePath end
Argus.getSession = function() return session end
Argus.buildSnapshot = buildSnapshot

Events.OnServerStarted.Add(Argus.onServerStarted)
Events.OnTickEvenPaused.Add(Argus.onTick)

return Argus
