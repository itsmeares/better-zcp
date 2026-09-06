---@diagnostic disable: undefined-global, deprecated

local json

local PanelBridge = {
    VERSION = "1.7.51",
    PROTOCOL_VERSION = "queue-v1",
    CHECK_INTERVAL = 250,
    lastCheck = 0,
    lastStatusUpdate = 0,
    STATUS_INTERVAL = 3000,
    processedIds = {},
    processedIdOrder = {},
    processedIdCount = 0,
    basePath = nil,
    initialized = false,

    DEBUG_MODE = false,
    debugLog = {},
    MAX_DEBUG_ENTRIES = 200,
    MAX_PENDING_RESULTS = 500,
    MAX_COMMANDS_PER_TICK = 200,
    QUEUE_SEQUENCE_WIDTH = 10,

    LEGACY_COMMANDS_INTERVAL = 2000,
    lastLegacyCheck = 0,

    queueStateDirty = false,

    detectedVersion = nil,
    apiCapabilities = {},

    methodCapabilities = {},

    methodFailures = {},

    stats = {
        commandsProcessed = 0,
        commandsSucceeded = 0,
        commandsFailed = 0,
        errors = {},
        lastError = nil,
        startTime = nil
    },

    pendingResults = {},

    queueState = {
        lastCommandSeq = 0,
        nextResultSeq = 1,
    },

    inboxStuckState = {
        seq = nil,
        since = 0,
        nextCheckAt = 0,
    },
}


local LOG_LEVEL = {
    DEBUG = 1,
    INFO = 2,
    WARN = 3,
    ERROR = 4
}

local LOG_LEVEL_NAME = {}
for name, val in pairs(LOG_LEVEL) do LOG_LEVEL_NAME[val] = name end

local unpack = unpack or table.unpack

function PanelBridge.log(level, message, context)
    local timestamp = nil
    if getTimestampMs then
        timestamp = getTimestampMs()
    elseif os and os.time then
        timestamp = os.time() * 1000
    else
        timestamp = 0
    end
    local levelName = LOG_LEVEL_NAME[level] or "INFO"

    local entry = {
        timestamp = timestamp,
        level = levelName,
        message = tostring(message),
        context = context
    }

    table.insert(PanelBridge.debugLog, entry)
    if #PanelBridge.debugLog > PanelBridge.MAX_DEBUG_ENTRIES then
        local drop = math.floor(PanelBridge.MAX_DEBUG_ENTRIES / 4)
        if drop < 1 then drop = 1 end
        local kept = {}
        for i = drop + 1, #PanelBridge.debugLog do
            kept[#kept + 1] = PanelBridge.debugLog[i]
        end
        PanelBridge.debugLog = kept
    end

    local prefix = "[PanelBridge][" .. levelName .. "] "
    if level >= LOG_LEVEL.WARN or PanelBridge.DEBUG_MODE then
        print(prefix .. message)
        if context and PanelBridge.DEBUG_MODE and json and json.encode then
            print(prefix .. "  Context: " .. json.encode(context))
        end
    end

    if level == LOG_LEVEL.ERROR then
        PanelBridge.stats.lastError = entry
        table.insert(PanelBridge.stats.errors, entry)
        while #PanelBridge.stats.errors > 20 do
            table.remove(PanelBridge.stats.errors, 1)
        end
    end
end

function PanelBridge.debug(message, context)
    PanelBridge.log(LOG_LEVEL.DEBUG, message, context)
end

function PanelBridge.info(message, context)
    PanelBridge.log(LOG_LEVEL.INFO, message, context)
end

function PanelBridge.warn(message, context)
    PanelBridge.log(LOG_LEVEL.WARN, message, context)
end

function PanelBridge.error(message, context)
    PanelBridge.log(LOG_LEVEL.ERROR, message, context)
end


local function capabilityKey(obj, methodName)
    if type(obj) == "table" then
        local ok, classValue = pcall(function() return obj:getClass() end)
        if ok and classValue then
            return tostring(classValue) .. "#" .. methodName
        end
    end
    local textOk, text = pcall(tostring, obj)
    if textOk and text then
        local stripped, hashCount = text:gsub("@%x+", "")
        if hashCount > 0 then
            return stripped .. "#" .. methodName
        end
    end
    return nil
end

local function isMissingMethodError(err)
    local text = tostring(err or ""):lower()
    return text:find("call nil", 1, true) ~= nil
        or text:find("attempt to call", 1, true) ~= nil
        or text:find("not a function", 1, true) ~= nil
end

local MAX_METHOD_FAILURES = 3

function PanelBridge.invoke(obj, methodName, ...)
    if obj == nil then
        return false, "Object is nil"
    end

    local key = capabilityKey(obj, methodName)
    if key and PanelBridge.methodCapabilities[key] == false then
        return false, "Method '" .. methodName .. "' not available on this build"
    end

    local args = { ... }
    local success, result = pcall(function()
        return obj[methodName](obj, unpack(args))
    end)

    if success then
        if key then
            PanelBridge.methodCapabilities[key] = true
            PanelBridge.methodFailures[key] = nil
        end
        return true, result
    end

    if key and PanelBridge.methodCapabilities[key] ~= true then
        local failures = (PanelBridge.methodFailures[key] or 0) + 1
        PanelBridge.methodFailures[key] = failures
        if isMissingMethodError(result) or failures >= MAX_METHOD_FAILURES then
            PanelBridge.methodCapabilities[key] = false
            PanelBridge.debug("Method unavailable on this build; will not retry", {
                method = methodName,
                class = key,
                failures = failures
            })
            return false, result
        end
    end

    PanelBridge.debug("invoke failed", { method = methodName, error = tostring(result) })
    return false, result
end

function PanelBridge.hasMethod(obj, methodName)
    if not obj then return false end
    if type(obj) == "table" then
        local ok, method = pcall(function() return obj[methodName] end)
        if ok and type(method) == "function" then return true end
    end
    local key = capabilityKey(obj, methodName)
    if key and PanelBridge.methodCapabilities[key] == false then return false end
    return key ~= nil and PanelBridge.methodCapabilities[key] == true
end

function PanelBridge.safeCall(obj, methodName, ...)
    return PanelBridge.invoke(obj, methodName, ...)
end

function PanelBridge.setCharacterCheatBypassingRoleGate(player, methodName, enabled)
    if not player then
        return false, methodName .. " method not available in this PZ version"
    end
    local bypassOk, bypassErr = PanelBridge.invoke(player, methodName, enabled, true)
    if bypassOk then
        return true
    end
    local ok, err = PanelBridge.invoke(player, methodName, enabled)
    if ok then
        return true
    end
    return false, err or bypassErr
end

function PanelBridge.safeGet(obj, methodName, default)
    local success, result = PanelBridge.invoke(obj, methodName)
    if success and result ~= nil then
        return result
    end
    return default
end

function PanelBridge.tryGet(obj, methodName, ...)
    local success, result = PanelBridge.invoke(obj, methodName, ...)
    if success then return result end
    return nil
end

local function statGet(stats, enumName)
    if not stats then return nil end
    local ok, enumValue = pcall(function() return CharacterStat[enumName] end)
    if not ok or enumValue == nil then return nil end
    return PanelBridge.tryGet(stats, "get", enumValue)
end

function PanelBridge.verifiedResult(verified, data, failMessage)
    if verified == false then
        return false, nil, failMessage or "Operation succeeded but did not take effect"
    end
    data = data or {}
    if verified == true then
        data.verified = "confirmed"
    else
        data.verified = "unverifiable"
    end
    return true, data
end

function PanelBridge.detectVersion()
    local version = {
        build = "unknown",
        isB42 = false,
        isB41 = false,
        features = {}
    }

    local onlinePlayers = getOnlinePlayers and getOnlinePlayers()
    local testPlayer = onlinePlayers and onlinePlayers:size() > 0 and onlinePlayers:get(0) or nil
    if testPlayer then
        if PanelBridge.invoke(testPlayer, "getTraits") then
            version.isB41 = true
        end
    end

    pcall(function()
        if getCore and getCore() and getCore().getVersion then
            version.build = getCore():getVersion()
        end
    end)

    if not version.isB42 and not version.isB41 and version.build ~= "unknown" then
        local major = version.build:match("^(%d+)%.")
        if major then
            local majorNum = tonumber(major)
            if majorNum and majorNum >= 42 then
                version.isB42 = true
            elseif majorNum and majorNum == 41 then
                version.isB41 = true
            end
        end
    end

    PanelBridge.detectedVersion = version
    PanelBridge.info("Detected PZ version", version)

    return version
end

json = {}

json.null = setmetatable({}, { __tostring = function() return "null" end })

local function kind_of(obj)
    if type(obj) ~= 'table' then return type(obj) end
    local count = 0
    for k in pairs(obj) do
        if type(k) ~= 'number' then return 'table' end
        count = count + 1
    end
    for i = 1, count do
        if obj[i] == nil then return 'table' end
    end
    return 'array'
end

local function escape_str(s)
    local in_char = {'\\', '"', '\b', '\f', '\n', '\r', '\t'}
    local out_char = {'\\', '"', 'b', 'f', 'n', 'r', 't'}
    for i, c in ipairs(in_char) do
        s = s:gsub(c, '\\' .. out_char[i])
    end
    s = s:gsub('[%z\1-\31]', function(c)
        return string.format('\\u%04x', string.byte(c))
    end)
    return s
end

local JSON_MAX_DEPTH = 64

function json.encode(obj, depth)
    depth = depth or 0
    if depth > JSON_MAX_DEPTH then
        return 'null'
    end
    if obj == json.null then
        return 'null'
    end
    local t = type(obj)
    if t == 'nil' then
        return 'null'
    elseif t == 'boolean' then
        return obj and 'true' or 'false'
    elseif t == 'number' then
        if obj ~= obj then return 'null' end
        if obj == math.huge or obj == -math.huge then return 'null' end
        return tostring(obj)
    elseif t == 'string' then
        return '"' .. escape_str(obj) .. '"'
    elseif t == 'table' then
        local k = kind_of(obj)
        if k == 'array' then
            local parts = {}
            for i, v in ipairs(obj) do
                parts[i] = json.encode(v, depth + 1)
            end
            return '[' .. table.concat(parts, ',') .. ']'
        else
            local parts = {}
            for key, val in pairs(obj) do
                parts[#parts + 1] = json.encode(tostring(key), depth + 1) .. ':' .. json.encode(val, depth + 1)
            end
            return '{' .. table.concat(parts, ',') .. '}'
        end
    end
    return 'null'
end

local function utf8EncodeCodepoint(code)
    if code < 0x80 then
        return string.char(code)
    elseif code < 0x800 then
        return string.char(
            0xC0 + math.floor(code / 0x40),
            0x80 + (code % 0x40))
    else
        return string.char(
            0xE0 + math.floor(code / 0x1000),
            0x80 + (math.floor(code / 0x40) % 0x40),
            0x80 + (code % 0x40))
    end
end

function json.decode(str)
    if not str or str == "" then return nil end

    local pos = 1
    local function skip_whitespace()
        while pos <= #str and str:sub(pos, pos):match('%s') do
            pos = pos + 1
        end
    end

    local function parse_value()
        skip_whitespace()
        local c = str:sub(pos, pos)

        if c == '"' then
            pos = pos + 1
            local start = pos
            local result = ""
            while pos <= #str do
                c = str:sub(pos, pos)
                if c == '\\' then
                    result = result .. str:sub(start, pos - 1)
                    pos = pos + 1
                    local escape = str:sub(pos, pos)
                    if escape == 'n' then result = result .. '\n'
                    elseif escape == 'r' then result = result .. '\r'
                    elseif escape == 't' then result = result .. '\t'
                    elseif escape == 'b' then result = result .. '\b'
                    elseif escape == 'f' then result = result .. '\f'
                    elseif escape == '"' then result = result .. '"'
                    elseif escape == '\\' then result = result .. '\\'
                    elseif escape == '/' then result = result .. '/'
                    elseif escape == 'u' then
                        local hex = str:sub(pos + 1, pos + 4)
                        local code = hex:match('^%x%x%x%x$') and tonumber(hex, 16)
                        if code then
                            result = result .. utf8EncodeCodepoint(code)
                            pos = pos + 4
                        else
                            result = result .. escape
                        end
                    else result = result .. escape end
                    pos = pos + 1
                    start = pos
                elseif c == '"' then
                    result = result .. str:sub(start, pos - 1)
                    pos = pos + 1
                    return result
                else
                    pos = pos + 1
                end
            end
            return result
        elseif c == '{' then
            pos = pos + 1
            local obj = {}
            skip_whitespace()
            if str:sub(pos, pos) == '}' then
                pos = pos + 1
                return obj
            end
            while pos <= #str do
                skip_whitespace()
                if pos > #str then break end
                local key = parse_value()
                skip_whitespace()
                if str:sub(pos, pos) == ':' then pos = pos + 1 end
                local value = parse_value()
                if type(key) == 'string' then
                    obj[key] = value
                end
                skip_whitespace()
                c = str:sub(pos, pos)
                if c == '}' then
                    pos = pos + 1
                    return obj
                elseif c == ',' then
                    pos = pos + 1
                end
            end
            return obj
        elseif c == '[' then
            pos = pos + 1
            local arr = {}
            local idx = 0
            skip_whitespace()
            if str:sub(pos, pos) == ']' then
                pos = pos + 1
                return arr
            end
            while pos <= #str do
                idx = idx + 1
                local value = parse_value()
                if value == nil then value = json.null end
                arr[idx] = value
                skip_whitespace()
                if pos > #str then break end
                c = str:sub(pos, pos)
                if c == ']' then
                    pos = pos + 1
                    return arr
                elseif c == ',' then
                    pos = pos + 1
                end
            end
            return arr
        elseif str:sub(pos, pos + 3) == 'true' then
            pos = pos + 4
            return true
        elseif str:sub(pos, pos + 4) == 'false' then
            pos = pos + 5
            return false
        elseif str:sub(pos, pos + 3) == 'null' then
            pos = pos + 4
            return nil
        else
            local start = pos
            while pos <= #str and str:sub(pos, pos):match('[%d%.%-eE%+]') do
                pos = pos + 1
            end
            return tonumber(str:sub(start, pos - 1))
        end
    end

    local success, result = pcall(parse_value)
    if success then
        return result
    else
        print("[PanelBridge] JSON parse error: " .. tostring(result))
        return nil
    end
end


local function getPlayerByUsername(username)
    if not username then return nil end

    local onlinePlayers = getOnlinePlayers()
    if not onlinePlayers then return nil end

    local lowerUser = string.lower(username)
    for i = 0, onlinePlayers:size() - 1 do
        local player = onlinePlayers:get(i)
        if player then
            local ok, pname = pcall(function() return player:getUsername() end)
            if ok and pname and string.lower(pname) == lowerUser then
                return player
            end
        end
    end

    return nil
end


function PanelBridge.getBasePath()
    if PanelBridge.basePath then
        return PanelBridge.basePath
    end

    local serverName = getServerName()
    local safeServerName = nil
    if serverName and serverName ~= "" then
        safeServerName = tostring(serverName)
        safeServerName = safeServerName:gsub("[/\\:%*%?\"<>|]", "_")
        safeServerName = safeServerName:gsub("%s+", "_")
        if safeServerName == "" then safeServerName = nil end
    end

    if safeServerName then
        PanelBridge.basePath = "panelbridge/" .. safeServerName .. "/"
    else
        PanelBridge.basePath = "panelbridge/"
    end

    print("[PanelBridge] Using path: " .. PanelBridge.basePath)
    return PanelBridge.basePath
end

PanelBridge.WRITE_SUFFIX = ".txt"

function PanelBridge.getWritePath(filename)
    return PanelBridge.getBasePath() .. filename .. PanelBridge.WRITE_SUFFIX
end

function PanelBridge.isPanelOwnedFile(filename)
    return filename == "commands.json" or filename == ".queue-state-node.json"
        or filename:match("^inbox/cmd%-") ~= nil
end

function PanelBridge.canWritePath(path)
    local ok, writer = pcall(function() return getFileWriter(path, true, false) end)
    if not ok or not writer then
        return false
    end
    local wrote = pcall(function()
        writer:write("PanelBridge probe")
        writer:close()
    end)
    return wrote and true or false
end

function PanelBridge.ensureDirectory()
    local initPath = PanelBridge.getWritePath(".init")
    local writer = getFileWriter(initPath, true, false)
    if writer then
        local stamp = "unknown"
        if os and os.date then
            local ok, val = pcall(function() return os.date() end)
            if ok and val then stamp = tostring(val) end
        elseif getTimestampMs then
            stamp = tostring(getTimestampMs())
        end
        writer:write("PanelBridge initialized at " .. stamp)
        writer:close()
        return true
    end

    print("[PanelBridge] ERROR: could not write " .. initPath .. " in the Lua folder")
    return PanelBridge.canWritePath(PanelBridge.getWritePath(".write-check"))
end

function PanelBridge.readPath(path)
    local reader = getFileReader(path, false)
    if not reader then
        return nil
    end

    local lines = {}
    local readOk, readErr = pcall(function()
        local line = reader:readLine()
        while line do
            lines[#lines + 1] = line
            line = reader:readLine()
        end
    end)
    reader:close()
    if not readOk then return nil end

    local content = table.concat(lines, "\n")
    return (content:gsub("^%s*(.-)%s*$", "%1"))
end

function PanelBridge.readFile(filename)
    local nestedPath = PanelBridge.getBasePath() .. filename
    if PanelBridge.isPanelOwnedFile(filename) then
        return PanelBridge.readPath(nestedPath)
    end

    local content = PanelBridge.readPath(nestedPath .. PanelBridge.WRITE_SUFFIX)
    if content ~= nil then
        return content
    end
    return PanelBridge.readPath(nestedPath)
end

function PanelBridge.writeFile(filename, content)
    local path
    if PanelBridge.isPanelOwnedFile(filename) then
        path = PanelBridge.getBasePath() .. filename
    else
        path = PanelBridge.getWritePath(filename)
    end
    local writer = getFileWriter(path, true, false)
    if not writer then
        print("[PanelBridge] Error: Could not write to " .. path)
        return false
    end
    local writeOk, writeErr = pcall(function()
        writer:write(content)
    end)
    writer:close()
    if not writeOk then
        print("[PanelBridge] Error writing: " .. tostring(writeErr))
        return false
    end
    return true
end

function PanelBridge.readJSON(filename)
    local content = PanelBridge.readFile(filename)
    if not content or content == "" then
        return nil
    end
    return json.decode(content)
end

function PanelBridge.writeJSON(filename, data)
    local content = json.encode(data)
    return PanelBridge.writeFile(filename, content)
end

function PanelBridge.clearFile(filename)
    if PanelBridge.isPanelOwnedFile(filename) then
        return true
    end
    return PanelBridge.writeFile(filename, "")
end

function PanelBridge.formatSeq(seq)
    local n = tonumber(seq) or 0
    if n < 0 then n = 0 end
    return string.format("%0" .. tostring(PanelBridge.QUEUE_SEQUENCE_WIDTH) .. "d", math.floor(n))
end

function PanelBridge.readQueueState()
    local state = PanelBridge.readJSON("queue-state-lua.json")
    if type(state) == "table" then
        local lastCommandSeq = tonumber(state.lastCommandSeq)
        local nextResultSeq = tonumber(state.nextResultSeq)
        if lastCommandSeq and lastCommandSeq >= 0 then
            PanelBridge.queueState.lastCommandSeq = math.floor(lastCommandSeq)
        end
        if nextResultSeq and nextResultSeq >= 1 then
            PanelBridge.queueState.nextResultSeq = math.floor(nextResultSeq)
        end
    end
end

function PanelBridge.writeQueueState()
    local ok = PanelBridge.writeJSON("queue-state-lua.json", {
        protocolVersion = PanelBridge.PROTOCOL_VERSION,
        lastCommandSeq = PanelBridge.queueState.lastCommandSeq,
        nextResultSeq = PanelBridge.queueState.nextResultSeq,
        updatedAt = getTimestampMs()
    })
    if ok then PanelBridge.queueStateDirty = false end
    return ok
end

function PanelBridge.writeInboxCursor(lastSeq)
    return PanelBridge.writeJSON("inbox/cursor.json", {
        protocolVersion = PanelBridge.PROTOCOL_VERSION,
        lastProcessedSeq = tonumber(lastSeq) or 0,
        updatedAt = getTimestampMs()
    })
end


function PanelBridge.sendResult(id, success, data, errorMsg)
    if #PanelBridge.pendingResults >= PanelBridge.MAX_PENDING_RESULTS then
        local dropped = PanelBridge.pendingResults[1]
        table.remove(PanelBridge.pendingResults, 1)
        PanelBridge.warn("Pending result buffer full, dropping oldest result", {
            max = PanelBridge.MAX_PENDING_RESULTS,
            droppedSeq = dropped and dropped.seq or nil,
            droppedId = dropped and dropped.id or nil
        })
        if dropped and dropped.seq then
            local outFile = "outbox/res-" .. PanelBridge.formatSeq(dropped.seq) .. ".json"
            PanelBridge.writeJSON(outFile, {
                protocolVersion = PanelBridge.PROTOCOL_VERSION,
                seq = dropped.seq,
                result = {
                    id = dropped.id,
                    success = false,
                    data = nil,
                    error = "Result dropped: pending buffer overflow",
                    timestamp = getTimestampMs(),
                }
            })
        end
    end

    table.insert(PanelBridge.pendingResults, {
        protocolVersion = PanelBridge.PROTOCOL_VERSION,
        seq = PanelBridge.queueState.nextResultSeq,
        id = id,
        success = success,
        data = data,
        error = errorMsg,
        timestamp = getTimestampMs()
    })
    PanelBridge.queueState.nextResultSeq = PanelBridge.queueState.nextResultSeq + 1
    PanelBridge.queueStateDirty = true
end

function PanelBridge.flushResults()
    if #PanelBridge.pendingResults == 0 then
        if PanelBridge.queueStateDirty then
            PanelBridge.writeQueueState()
        end
        return
    end

    local writtenCount = 0
    for idx, r in ipairs(PanelBridge.pendingResults) do
        local seq = tonumber(r.seq) or 0
        local outFile = "outbox/res-" .. PanelBridge.formatSeq(seq) .. ".json"
        local ok = PanelBridge.writeJSON(outFile, {
            protocolVersion = PanelBridge.PROTOCOL_VERSION,
            seq = seq,
            result = {
                id = r.id,
                success = r.success,
                data = r.data,
                error = r.error,
                timestamp = r.timestamp,
            }
        })
        if not ok then
            PanelBridge.warn("Queue result write failed; will retry", { file = outFile, seq = seq })
            break
        end
        writtenCount = idx
    end

    if writtenCount <= 0 then
        if PanelBridge.queueStateDirty then
            PanelBridge.writeQueueState()
        end
        return
    end

    local remaining = {}
    for i = writtenCount + 1, #PanelBridge.pendingResults do
        table.insert(remaining, PanelBridge.pendingResults[i])
    end
    PanelBridge.pendingResults = remaining

    if PanelBridge.queueStateDirty then
        PanelBridge.writeQueueState()
    end
end


local handlers = {}

local CACHEABLE_ACTIONS = {
    getItemCatalog       = { ttl = 300000, live = false },
    getVehicleCatalog    = { ttl = 300000, live = false },
    getAllSandboxOptions = { ttl = 300000, live = true },
    getVehiclesDetailed  = { ttl = 5000,   live = true },
    getSafehouses        = { ttl = 5000,   live = true },
    getAllPlayerDetails  = { ttl = 5000,   live = true },
}
local readOnlyCache = {}

local function invalidateLiveStateCache()
    for action, config in pairs(CACHEABLE_ACTIONS) do
        if config.live then
            readOnlyCache[action] = nil
        end
    end
end

local function markProcessed(id)
    PanelBridge.processedIds[id] = true
    table.insert(PanelBridge.processedIdOrder, id)
    PanelBridge.processedIdCount = PanelBridge.processedIdCount + 1
end

local function processSingleCommand(cmd)
    if type(cmd) ~= "table" then
        PanelBridge.stats.commandsFailed = PanelBridge.stats.commandsFailed + 1
        PanelBridge.warn("Skipping malformed command entry", { entryType = type(cmd) })
        return false
    end

    if cmd.id == nil and cmd.commandId ~= nil then
        cmd.id = cmd.commandId
    end
    if cmd.args == nil and type(cmd.payload) == "table" then
        cmd.args = cmd.payload
    end

    if not cmd.id then
        PanelBridge.stats.commandsFailed = PanelBridge.stats.commandsFailed + 1
        PanelBridge.warn("Skipping command without id", { action = tostring(cmd.action) })
        return false
    end

    if PanelBridge.processedIds[cmd.id] then
        return false
    end

    if type(cmd.expiresAt) == "number" and cmd.expiresAt > 0 then
        local nowMs = getTimestampMs()
        if nowMs > cmd.expiresAt then
            markProcessed(cmd.id)
            PanelBridge.stats.commandsFailed = PanelBridge.stats.commandsFailed + 1
            PanelBridge.warn("Skipping expired command", {
                action = tostring(cmd.action),
                id = cmd.id,
                ageMs = nowMs - cmd.expiresAt
            })
            PanelBridge.sendResult(cmd.id, false, nil, "Command expired before mod could process it")
            return false
        end
    end

    markProcessed(cmd.id)
    PanelBridge.stats.commandsProcessed = PanelBridge.stats.commandsProcessed + 1

    local quietCommands = { getServerInfo=true, ping=true, getWeather=true, getGameTime=true, getWorldStats=true, getUtilitiesStatus=true, getClimateFloats=true, getAllPlayerDetails=true, getVehiclesDetailed=true, getSafehouses=true, getZombieCount=true, getSandboxOptions=true }
    if quietCommands[cmd.action] then
        PanelBridge.debug("Processing command: " .. tostring(cmd.action), { id = cmd.id })
    else
        PanelBridge.info("Processing command: " .. tostring(cmd.action), { id = cmd.id })
    end

    local handler = handlers[cmd.action]
    if handler then
        local cacheConfig = CACHEABLE_ACTIONS[cmd.action]
        local cacheTtl = cacheConfig and cacheConfig.ttl
        if cacheTtl then
            local cached = readOnlyCache[cmd.action]
            if cached and (getTimestampMs() - cached.at) < cacheTtl then
                PanelBridge.stats.commandsSucceeded = PanelBridge.stats.commandsSucceeded + 1
                PanelBridge.debug("Command served from cache: " .. tostring(cmd.action), { id = cmd.id })
                PanelBridge.sendResult(cmd.id, cached.ok, cached.data, cached.err)
                return true
            end
        end

        local handlerArgs = {}
        if type(cmd.args) == "table" then
            handlerArgs = cmd.args
        elseif cmd.args ~= nil then
            PanelBridge.warn("Command args must be a table; defaulting to empty args", {
                id = cmd.id,
                action = tostring(cmd.action),
                argsType = type(cmd.args)
            })
        end

        local startTime = getTimestampMs()
        local pcallOk, success, data, errorMsg = pcall(handler, handlerArgs, cmd.id)
        local duration = getTimestampMs() - startTime

        if not pcallOk then
            PanelBridge.stats.commandsFailed = PanelBridge.stats.commandsFailed + 1
            local crashMsg = "Handler crashed: " .. tostring(success)
            PanelBridge.error("Command crashed: " .. tostring(cmd.action), {
                error = crashMsg,
                duration = duration .. "ms"
            })
            PanelBridge.sendResult(cmd.id, false, nil, crashMsg)
        elseif success == "DEFERRED" then
            PanelBridge.debug("Command deferred to background job: " .. tostring(cmd.action), {
                id = cmd.id,
                duration = duration .. "ms"
            })
        elseif success then
            PanelBridge.stats.commandsSucceeded = PanelBridge.stats.commandsSucceeded + 1
            PanelBridge.debug("Command succeeded: " .. tostring(cmd.action), {
                duration = duration .. "ms"
            })
            if cacheTtl then
                readOnlyCache[cmd.action] = { at = getTimestampMs(), ok = success, data = data, err = errorMsg }
            else
                invalidateLiveStateCache()
            end
            PanelBridge.sendResult(cmd.id, success, data, errorMsg)
        elseif errorMsg == "useRCON" then
            PanelBridge.debug("Command routed to RCON: " .. tostring(cmd.action), {
                duration = duration .. "ms"
            })
            PanelBridge.sendResult(cmd.id, success, data, errorMsg)
        else
            PanelBridge.stats.commandsFailed = PanelBridge.stats.commandsFailed + 1
            PanelBridge.warn("Command failed: " .. tostring(cmd.action), {
                error = errorMsg,
                duration = duration .. "ms"
            })
            PanelBridge.sendResult(cmd.id, success, data, errorMsg)
        end
    else
        PanelBridge.stats.commandsFailed = PanelBridge.stats.commandsFailed + 1
        local errorMsg = "Unknown command: " .. tostring(cmd.action)
        PanelBridge.warn(errorMsg)
        PanelBridge.sendResult(cmd.id, false, nil, errorMsg)
    end

    return true
end

local INBOX_RESYNC_STUCK_MS = 10000
local INBOX_RESYNC_CHECK_INTERVAL_MS = 5000

local function tryResyncInboxCursor(nextSeq)
    local now = getTimestampMs()
    local stuck = PanelBridge.inboxStuckState

    if stuck.seq ~= nextSeq then
        stuck.seq = nextSeq
        stuck.since = now
        stuck.nextCheckAt = now + INBOX_RESYNC_STUCK_MS
        return false
    end
    if now < stuck.nextCheckAt then
        return false
    end
    stuck.nextCheckAt = now + INBOX_RESYNC_CHECK_INTERVAL_MS

    local nodeState = PanelBridge.readJSON(".queue-state-node.json")
    local panelNextSeq = nodeState and tonumber(nodeState.nextCommandSeq)
    if not panelNextSeq or panelNextSeq < 1 then
        return false
    end

    local panelHighWater = panelNextSeq - 1
    if panelHighWater == PanelBridge.queueState.lastCommandSeq then
        return false
    end

    if panelHighWater < PanelBridge.queueState.lastCommandSeq then
        return false
    end

    PanelBridge.warn("Inbox sequence desync detected, resyncing to panel position", {
        expectedSeq = nextSeq,
        panelHighWater = panelHighWater,
        previousLastCommandSeq = PanelBridge.queueState.lastCommandSeq
    })
    PanelBridge.queueState.lastCommandSeq = panelHighWater
    PanelBridge.writeQueueState()
    PanelBridge.writeInboxCursor(panelHighWater)
    stuck.seq = nil
    return true
end

local function processQueuedCommands(budget)
    local processed = 0
    local scanned = 0
    if budget <= 0 then return processed, scanned end

    local nextSeq = (PanelBridge.queueState.lastCommandSeq or 0) + 1
    local advanced = false

    while scanned < budget do
        local fileName = "inbox/cmd-" .. PanelBridge.formatSeq(nextSeq) .. ".json"
        local raw = PanelBridge.readFile(fileName)

        if raw == nil then
            if tryResyncInboxCursor(nextSeq) then
                nextSeq = PanelBridge.queueState.lastCommandSeq + 1
            else
                break
            end
        else
            local shouldAdvance = false

            if raw == "" then
                shouldAdvance = true
            else
                local decodeOk, decoded = pcall(json.decode, raw)
                local queued = decodeOk and decoded or nil
                if not queued then
                    PanelBridge.warn("Skipping malformed queued command file", {
                        file = fileName,
                        seq = nextSeq,
                        parseError = (not decodeOk) and tostring(decoded) or "decode returned nil"
                    })
                    PanelBridge.clearFile(fileName)
                    shouldAdvance = true
                else
                    PanelBridge.queueState.lastCommandSeq = nextSeq

                    local cmd = queued.command or queued
                    if processSingleCommand(cmd) then
                        processed = processed + 1
                    end

                    PanelBridge.clearFile(fileName)
                    shouldAdvance = true
                end
            end

            if shouldAdvance then
                scanned = scanned + 1
                PanelBridge.queueState.lastCommandSeq = nextSeq
                PanelBridge.writeInboxCursor(nextSeq)
                advanced = true
                nextSeq = nextSeq + 1
            end
        end
    end

    if advanced then
        PanelBridge.writeQueueState()
    end

    return processed, scanned
end

local function normalizeMessage(value, maxLen)
    if value == nil then return nil end
    local ok, message = pcall(tostring, value)
    if not ok then return nil end
    if message == "" then return nil end
    if maxLen and #message > maxLen then
        message = message:sub(1, maxLen)
    end
    return message
end


handlers.getDebugLog = function(args)
    local limit = tonumber(args.limit) or 50
    limit = math.floor(limit)
    if limit < 1 then limit = 1 end
    if limit > 200 then limit = 200 end

    local minLevel = tostring(args.minLevel or "DEBUG")
    minLevel = string.upper(minLevel)

    local entries = {}
    local levelMap = { DEBUG = 1, INFO = 2, WARN = 3, ERROR = 4 }
    local minLevelNum = levelMap[minLevel] or 1

    local startIdx = math.max(1, #PanelBridge.debugLog - limit + 1)
    for i = startIdx, #PanelBridge.debugLog do
        local entry = PanelBridge.debugLog[i]
        if entry and levelMap[entry.level] >= minLevelNum then
            table.insert(entries, entry)
        end
    end

    return true, {
        entries = entries,
        totalEntries = #PanelBridge.debugLog,
        debugMode = PanelBridge.DEBUG_MODE
    }
end

handlers.setDebugMode = function(args)
    PanelBridge.DEBUG_MODE = args.enabled == true
    PanelBridge.info("Debug mode " .. (PanelBridge.DEBUG_MODE and "enabled" or "disabled"))
    return true, { debugMode = PanelBridge.DEBUG_MODE }
end

handlers.getStats = function(args)
    local uptime = 0
    if PanelBridge.stats.startTime then
        uptime = (getTimestampMs() - PanelBridge.stats.startTime) / 1000
    end

    return true, {
        version = PanelBridge.VERSION,
        uptime = uptime,
        commandsProcessed = PanelBridge.stats.commandsProcessed,
        commandsSucceeded = PanelBridge.stats.commandsSucceeded,
        commandsFailed = PanelBridge.stats.commandsFailed,
        lastError = PanelBridge.stats.lastError,
        recentErrors = PanelBridge.stats.errors,
        debugMode = PanelBridge.DEBUG_MODE,
        detectedVersion = PanelBridge.detectedVersion
    }
end

handlers.checkAPI = function(args)
    local objName = args.object or "ClimateManager"
    local methodName = args.method

    local obj = nil
    local result = { object = objName, available = false }

    if objName == "ClimateManager" then
        obj = getClimateManager and getClimateManager()
    elseif objName == "GameTime" then
        obj = getGameTime and getGameTime()
    elseif objName == "World" then
        obj = getWorld and getWorld()
    elseif objName == "ChatServer" then
        local chat = getChatSystem()
        if chat and chat.server then obj = chat.server end
    elseif objName == "SandboxOptions" then
        obj = getSandboxOptions and getSandboxOptions()
    end

    if obj then
        result.available = true
        result.type = type(obj)

        if methodName then
            result.method = methodName
            result.methodAvailable = PanelBridge.hasMethod(obj, methodName)
        else
            result.methods = {}
            local ok = pcall(function()
                local count = 0
                for k, v in pairs(obj) do
                    if type(v) == "function" and count < 50 then
                        table.insert(result.methods, k)
                        count = count + 1
                    end
                end
                table.sort(result.methods)
            end)
            if not ok then
                result.methods = nil
                result.methodsError = "Method enumeration not supported for this object type"
            end
        end
    end

    return true, result
end

handlers.getAvailableHandlers = function(args)
    local handlerList = {}
    for name, _ in pairs(handlers) do
        table.insert(handlerList, name)
    end
    table.sort(handlerList)
    return true, {
        handlers = handlerList,
        count = #handlerList,
        version = PanelBridge.VERSION
    }
end

handlers.clearErrors = function(args)
    local count = #PanelBridge.stats.errors
    PanelBridge.stats.errors = {}
    PanelBridge.stats.lastError = nil
    PanelBridge.info("Error log cleared", { count = count })
    return true, { message = "Cleared " .. count .. " errors" }
end

handlers.ping = function(args)
    local onlinePlayers = getOnlinePlayers()
    return true, {
        message = "pong",
        version = PanelBridge.VERSION,
        serverTime = getTimestampMs(),
        playerCount = onlinePlayers and onlinePlayers:size() or 0
    }
end

handlers.getServerInfo = function(args)
    local players = {}
    local onlinePlayers = getOnlinePlayers()

    if onlinePlayers then
        for i = 0, onlinePlayers:size() - 1 do
            local player = onlinePlayers:get(i)
            if player then
                local ok, playerData = pcall(function()
                    local health = 100
                    local isInfected = false
                    local bodyDamage = player:getBodyDamage()
                    if bodyDamage then
                        health = bodyDamage:getOverallBodyHealth() or 100
                        isInfected = bodyDamage:IsInfected() or false
                    end
                    local stats = player:getStats()
                    return {
                        name = player:getUsername() or "Unknown",
                        x = math.floor(player:getX() or 0),
                        y = math.floor(player:getY() or 0),
                        z = math.floor(player:getZ() or 0),
                        health = health,
                        isAlive = player:isAlive(),
                        isInfected = isInfected,
                        accessLevel = player:getAccessLevel() or "",
                        hunger = statGet(stats, "HUNGER"),
                        thirst = statGet(stats, "THIRST"),
                        fatigue = statGet(stats, "FATIGUE")
                    }
                end)
                if ok and playerData then
                    table.insert(players, playerData)
                end
            end
        end
    end

    local gameTime = getGameTime()
    local gameTimeData = nil
    if gameTime then
        pcall(function()
            local hour, minute
            local hourValue = PanelBridge.tryGet(gameTime, "getHour")
            if hourValue then
                hour = hourValue
                minute = PanelBridge.safeGet(gameTime, "getMinutes", 0)
            else
                local tod = gameTime:getTimeOfDay()
                hour = math.floor(tod)
                minute = math.floor((tod - hour) * 60)
            end
            gameTimeData = {
                day = gameTime:getDay(),
                month = gameTime:getMonth() + 1,
                year = gameTime:getYear(),
                hour = hour,
                minute = minute
            }
        end)
    end

    return true, {
        players = players,
        playerCount = #players,
        gameTime = gameTimeData
    }
end

local GET_WEATHER_FIELDS = {
    { key = "temperature", get = function(c) return c:getTemperature() end },
    { key = "humidity", get = function(c) return c:getHumidity() end },
    { key = "windSpeed", get = function(c) return c:getWindspeedKph() end },
    { key = "windAngle", get = function(c) return c:getWindAngleDegrees() end },
    { key = "fogIntensity", get = function(c) return c:getFogIntensity() end },
    { key = "cloudIntensity", get = function(c) return c:getCloudIntensity() end },
    { key = "precipitationIntensity", get = function(c) return c:getPrecipitationIntensity() end },
    { key = "isRaining", get = function(c) return c:isRaining() end },
    { key = "isSnowing", get = function(c) return c:isSnowing() end },
    { key = "isThunderStorming", get = function(c) return PanelBridge.safeGet(c, "getIsThunderStorming", false) end },
    { key = "dayLight", get = function(c) return c:getDayLightStrength() end },
    { key = "nightStrength", get = function(c) return c:getNightStrength() end },
    { key = "desaturation", get = function(c) return c:getDesaturation() end },
    { key = "viewDistance", get = function(c) return PanelBridge.safeGet(c, "getViewDistance", 1.0) end },
    { key = "ambient", get = function(c) return PanelBridge.safeGet(c, "getAmbient", 1.0) end },
}

handlers.getWeather = function(args)
    local climate = getClimateManager()
    if not climate then
        return false, nil, "ClimateManager not available"
    end

    local data = {}
    local skipped = 0
    for _, field in ipairs(GET_WEATHER_FIELDS) do
        local ok, value = pcall(field.get, climate)
        if ok then
            data[field.key] = value
        else
            skipped = skipped + 1
        end
    end
    data.skipped = skipped

    return true, data
end

handlers.triggerBlizzard = function(args)
    local climate = getClimateManager()
    if not climate then
        return false, nil, "ClimateManager not available"
    end

    local duration = args.duration or 2.0

    local used, verified
    local success, err = pcall(function()
        if WeatherPeriod and WeatherPeriod.STAGE_BLIZZARD then
            local invokeOk, triggered = PanelBridge.invoke(climate, "triggerCustomWeatherStage", WeatherPeriod.STAGE_BLIZZARD, duration)
            if invokeOk then
                used = "triggerCustomWeatherStage"
                verified = triggered == true
            end
        end
        if not used then
            if PanelBridge.invoke(climate, "transmitTriggerBlizzard", duration) then
                used = "transmitTriggerBlizzard"
                verified = nil
            else
                error("No weather trigger method available")
            end
        end
        PanelBridge.debug("Blizzard triggered", { method = used, verified = verified })
    end)

    if not success then
        return false, nil, "Failed to trigger blizzard: " .. tostring(err)
    end

    return PanelBridge.verifiedResult(verified, { message = "Blizzard triggered", duration = duration },
        "A weather period is already running -- stop it first, or wait for it to finish")
end

handlers.triggerTropicalStorm = function(args)
    local climate = getClimateManager()
    if not climate then
        return false, nil, "ClimateManager not available"
    end

    local duration = args.duration or 2.0

    local used, verified
    local success, err = pcall(function()
        if WeatherPeriod and WeatherPeriod.STAGE_TROPICAL_STORM then
            local invokeOk, triggered = PanelBridge.invoke(climate, "triggerCustomWeatherStage", WeatherPeriod.STAGE_TROPICAL_STORM, duration)
            if invokeOk then
                used = "triggerCustomWeatherStage"
                verified = triggered == true
            end
        end
        if not used then
            if PanelBridge.invoke(climate, "transmitTriggerTropical", duration) then
                used = "transmitTriggerTropical"
                verified = nil
            else
                error("No weather trigger method available")
            end
        end
        PanelBridge.debug("Tropical storm triggered", { method = used, verified = verified })
    end)

    if not success then
        return false, nil, "Failed to trigger tropical storm: " .. tostring(err)
    end

    return PanelBridge.verifiedResult(verified, { message = "Tropical storm triggered", duration = duration },
        "A weather period is already running -- stop it first, or wait for it to finish")
end

handlers.triggerStorm = function(args)
    local climate = getClimateManager()
    if not climate then
        return false, nil, "ClimateManager not available"
    end

    local duration = args.duration or 2.0

    local used, verified
    local success, err = pcall(function()
        if WeatherPeriod and WeatherPeriod.STAGE_STORM then
            local invokeOk, triggered = PanelBridge.invoke(climate, "triggerCustomWeatherStage", WeatherPeriod.STAGE_STORM, duration)
            if invokeOk then
                used = "triggerCustomWeatherStage"
                verified = triggered == true
            end
        end
        if not used then
            if PanelBridge.invoke(climate, "transmitTriggerStorm", duration) then
                used = "transmitTriggerStorm"
                verified = nil
            else
                error("No weather trigger method available")
            end
        end
        PanelBridge.debug("Storm triggered", { method = used, verified = verified })
    end)

    if not success then
        return false, nil, "Failed to trigger storm: " .. tostring(err)
    end

    return PanelBridge.verifiedResult(verified, { message = "Storm triggered", duration = duration },
        "A weather period is already running -- stop it first, or wait for it to finish")
end

handlers.stopWeather = function(args)
    local climate = getClimateManager()
    if not climate then
        return false, nil, "ClimateManager not available"
    end

    local success, err = pcall(function()
        local used
        if PanelBridge.invoke(climate, "stopWeatherAndThunder") then
            used = "stopWeatherAndThunder"
        elseif PanelBridge.invoke(climate, "transmitServerStopWeather") then
            used = "transmitServerStopWeather"
        elseif PanelBridge.invoke(climate, "transmitStopWeather") then
            used = "transmitStopWeather"
        else
            error("No stop weather method available")
        end
        PanelBridge.invoke(climate, "transmitServerStopRain")
        PanelBridge.debug("Weather stopped", { method = used })
    end)

    if not success then
        return false, nil, "Failed to stop weather: " .. tostring(err)
    end

    local stillRaining = PanelBridge.tryGet(climate, "isRaining")
    local verified
    if stillRaining == nil then
        verified = nil
    elseif stillRaining == false then
        verified = true
    else
        verified = false
    end

    PanelBridge.info("Stop weather", { verified = verified })

    return PanelBridge.verifiedResult(verified, { message = "Weather stopped" },
        "Stop weather call succeeded but it is still raining")
end

handlers.generateWeather = function(args)
    local climate = getClimateManager()
    if not climate then
        return false, nil, "ClimateManager not available"
    end

    local strength = args.strength or 0.5
    local frontType = args.frontType or 0

    local javaFrontMap = { [0] = 0, [1] = -1, [2] = 1 }
    local javaFrontType = javaFrontMap[frontType] or 0

    local used, verified
    local success, err = pcall(function()
        if frontType ~= 0 then
            local invokeOk, triggered = PanelBridge.invoke(climate, "triggerCustomWeather", strength, frontType ~= 1)
            if invokeOk then
                used = "triggerCustomWeather"
                verified = triggered == true
            end
        end
        if not used then
            if PanelBridge.invoke(climate, "transmitGenerateWeather", strength, javaFrontType) then
                used = "transmitGenerateWeather"
                verified = nil
            else
                error("No generate weather method available")
            end
        end
        PanelBridge.debug("Weather period generated", { method = used, verified = verified })
    end)

    if not success then
        return false, nil, "Failed to generate weather: " .. tostring(err)
    end

    return PanelBridge.verifiedResult(verified,
        { message = "Weather period generated", strength = strength, frontType = frontType },
        "A weather period is already running -- stop it first, or wait for it to finish")
end

handlers.setSnow = function(args)
    local climate = getClimateManager()
    if not climate then
        return false, nil, "ClimateManager not available"
    end

    local enabled = args.enabled ~= false
    local success, err

    if enabled and PanelBridge.tryGet(climate, "isRaining") == false then
        PanelBridge.invoke(climate, "transmitServerStartRain", args.intensity or 0.5)
    end

    success, err = pcall(function()
        local applied = false
        local snowBool = PanelBridge.tryGet(climate, "getClimateBool", 0)
        if snowBool and PanelBridge.invoke(snowBool, "setEnableAdmin", true)
            and PanelBridge.invoke(snowBool, "setAdminValue", enabled) then
            applied = true
        end
        if PanelBridge.invoke(climate, "setPrecipitationIsSnow", enabled) then
            applied = true
        end
        if not applied then error("No method to set snow") end
    end)

    if not success then
        return false, nil, "Failed to set snow: " .. tostring(err)
    end

    local isSnowNow = PanelBridge.tryGet(climate, "getPrecipitationIsSnow")
    local verified
    if isSnowNow == nil then
        verified = nil
    else
        verified = isSnowNow == enabled
    end

    return PanelBridge.verifiedResult(verified,
        { message = "Snow " .. (enabled and "enabled (with precipitation)" or "disabled") },
        "Snow call succeeded but did not take effect")
end

handlers.startRain = function(args)
    local climate = getClimateManager()
    if not climate then
        return false, nil, "ClimateManager not available"
    end

    local intensity = args.intensity or 0.5

    local success, err = PanelBridge.invoke(climate, "transmitServerStartRain", intensity)

    if not success then
        return false, nil, "Failed to start rain: " .. tostring(err)
    end

    local actualIntensity = PanelBridge.tryGet(climate, "getPrecipitationIntensity")
    local verified
    if actualIntensity == nil then
        verified = nil
    else
        local expected = intensity
        if expected < 0 then expected = 0 end
        if expected > 1 then expected = 1 end
        verified = math.abs(actualIntensity - expected) < 0.01
    end

    return PanelBridge.verifiedResult(verified, { message = "Rain started", intensity = intensity },
        "Start rain call succeeded but precipitation did not take effect")
end

handlers.stopRain = function(args)
    local climate = getClimateManager()
    if not climate then
        return false, nil, "ClimateManager not available"
    end

    local success, err = PanelBridge.invoke(climate, "transmitServerStopRain")

    if not success then
        return false, nil, "Failed to stop rain: " .. tostring(err)
    end

    local stillRaining = PanelBridge.tryGet(climate, "isRaining")
    local verified
    if stillRaining == nil then
        verified = nil
    elseif stillRaining == false then
        verified = true
    else
        verified = false
    end

    return PanelBridge.verifiedResult(verified, { message = "Rain stopped" },
        "Stop rain call succeeded but it is still raining")
end

handlers.triggerLightning = function(args)
    local climate = getClimateManager()
    if not climate then
        return false, nil, "ClimateManager not available"
    end

    local x = math.floor(tonumber(args.x) or 0)
    local y = math.floor(tonumber(args.y) or 0)
    local strike = args.strike ~= false
    local light = args.light ~= false
    local rumble = args.rumble ~= false

    local thunderStorm = PanelBridge.tryGet(climate, "getThunderStorm")
    local success, err
    if thunderStorm then
        success, err = PanelBridge.invoke(thunderStorm, "triggerThunderEvent", x, y, strike, light, rumble)
    else
        success, err = PanelBridge.invoke(climate, "transmitServerTriggerLightning", x, y, strike, light, rumble)
    end

    if not success then
        return false, nil, "Failed to trigger lightning: " .. tostring(err)
    end

    return true, { message = "Lightning triggered", x = x, y = y }
end

local function applyClimateFloat(climate, floatIndex, value, setterName)
    local cf = PanelBridge.tryGet(climate, "getClimateFloat", floatIndex)
    if cf and PanelBridge.invoke(cf, "setEnableAdmin", true)
        and PanelBridge.invoke(cf, "setAdminValue", value) then
        local adminValue = PanelBridge.tryGet(cf, "getAdminValue")
        local verified
        if adminValue == nil then
            verified = nil
        else
            verified = math.abs(adminValue - value) < 0.01
        end
        return "climateFloat", verified
    end
    if PanelBridge.invoke(climate, setterName, value) then
        return setterName, nil
    end
    return nil, nil
end

handlers.setDayLight = function(args)
    local climate = getClimateManager()
    if not climate then
        return false, nil, "ClimateManager not available"
    end

    local value = tonumber(args.value) or 1.0

    local verified
    local success, err = pcall(function()
        local used
        used, verified = applyClimateFloat(climate, 11, value, "setDayLightStrength")
        if not used then error("No method to set daylight") end
    end)

    if not success then
        return false, nil, "Failed to set daylight: " .. tostring(err)
    end

    return PanelBridge.verifiedResult(verified, { message = "Daylight set to " .. value },
        "Daylight call succeeded but the admin value did not stick (likely clamped out of range)")
end

handlers.setNightStrength = function(args)
    local climate = getClimateManager()
    if not climate then
        return false, nil, "ClimateManager not available"
    end

    local value = tonumber(args.value) or 0.0

    local verified
    local success, err = pcall(function()
        local used
        used, verified = applyClimateFloat(climate, 2, value, "setNightStrength")
        if not used then error("No method to set night strength") end
    end)

    if not success then
        return false, nil, "Failed to set night strength: " .. tostring(err)
    end

    return PanelBridge.verifiedResult(verified, { message = "Night strength set to " .. value },
        "Night strength call succeeded but the admin value did not stick (likely clamped out of range)")
end

handlers.setDesaturation = function(args)
    local climate = getClimateManager()
    if not climate then
        return false, nil, "ClimateManager not available"
    end

    local value = tonumber(args.value) or 0.0

    local verified
    local success, err = pcall(function()
        local used
        used, verified = applyClimateFloat(climate, 0, value, "setDesaturation")
        if not used then error("No method to set desaturation") end
    end)

    if not success then
        return false, nil, "Failed to set desaturation: " .. tostring(err)
    end

    return PanelBridge.verifiedResult(verified, { message = "Desaturation set to " .. value },
        "Desaturation call succeeded but the admin value did not stick (likely clamped out of range)")
end

handlers.setViewDistance = function(args)
    local climate = getClimateManager()
    if not climate then
        return false, nil, "ClimateManager not available"
    end

    local value = tonumber(args.value) or 1.0

    local verified
    local success, err = pcall(function()
        local used
        used, verified = applyClimateFloat(climate, 10, value, "setViewDistance")
        if not used then error("No method to set view distance") end
    end)

    if not success then
        return false, nil, "Failed to set view distance: " .. tostring(err)
    end

    return PanelBridge.verifiedResult(verified, { message = "View distance set to " .. value },
        "View distance call succeeded but the admin value did not stick (likely clamped out of range)")
end

handlers.setAmbient = function(args)
    local climate = getClimateManager()
    if not climate then
        return false, nil, "ClimateManager not available"
    end

    local value = tonumber(args.value) or 1.0

    local verified
    local success, err = pcall(function()
        local used
        used, verified = applyClimateFloat(climate, 9, value, "setAmbient")
        if not used then error("No method to set ambient") end
    end)

    if not success then
        return false, nil, "Failed to set ambient: " .. tostring(err)
    end

    return PanelBridge.verifiedResult(verified, { message = "Ambient set to " .. value },
        "Ambient call succeeded but the admin value did not stick (likely clamped out of range)")
end

local function applyClimateFloatAdminOnly(climate, floatIndex, value)
    local cf = PanelBridge.tryGet(climate, "getClimateFloat", floatIndex)
    if not (cf and PanelBridge.invoke(cf, "setEnableAdmin", true)
        and PanelBridge.invoke(cf, "setAdminValue", value)) then
        return nil, nil
    end
    local adminValue = PanelBridge.tryGet(cf, "getAdminValue")
    if adminValue == nil then
        return "climateFloat", nil
    end
    return "climateFloat", math.abs(adminValue - value) < 0.01
end

handlers.setTemperature = function(args)
    local climate = getClimateManager()
    if not climate then
        return false, nil, "ClimateManager not available"
    end

    local value = tonumber(args.value) or 22.0

    if value < -50 then value = -50 end
    if value > 50 then value = 50 end

    local verified
    local success, err = pcall(function()
        local used
        used, verified = applyClimateFloatAdminOnly(climate, 4, value)
        if not used then error("No method to set temperature") end
    end)

    if not success then
        return false, nil, "Failed to set temperature: " .. tostring(err)
    end

    return PanelBridge.verifiedResult(verified, { message = "Temperature set to " .. value .. "C" },
        "Temperature call succeeded but the admin value did not stick (likely clamped out of range)")
end

handlers.setWind = function(args)
    local climate = getClimateManager()
    if not climate then return false, nil, "ClimateManager not available" end

    local value = tonumber(args.value) or 0.5

    local verified
    local success, err = pcall(function()
        local used
        used, verified = applyClimateFloatAdminOnly(climate, 6, value)
        if not used then error("No method to set wind") end
    end)

    if not success then return false, nil, "Failed to set wind: " .. tostring(err) end
    return PanelBridge.verifiedResult(verified, { message = "Wind set to " .. value },
        "Wind call succeeded but the admin value did not stick (likely clamped out of range)")
end

handlers.setFog = function(args)
    local climate = getClimateManager()
    if not climate then return false, nil, "ClimateManager not available" end

    local value = tonumber(args.value) or 0.0

    local verified
    local success, err = pcall(function()
        local used
        used, verified = applyClimateFloatAdminOnly(climate, 5, value)
        if not used then error("No method to set fog") end
    end)

    if not success then return false, nil, "Failed to set fog: " .. tostring(err) end
    return PanelBridge.verifiedResult(verified, { message = "Fog set to " .. value },
        "Fog call succeeded but the admin value did not stick (likely clamped out of range)")
end

handlers.setClouds = function(args)
    local climate = getClimateManager()
    if not climate then return false, nil, "ClimateManager not available" end

    local value = tonumber(args.value) or 0.0

    local verified
    local success, err = pcall(function()
        local used
        used, verified = applyClimateFloatAdminOnly(climate, 8, value)
        if not used then error("No method to set clouds") end
    end)

    if not success then return false, nil, "Failed to set clouds: " .. tostring(err) end
    return PanelBridge.verifiedResult(verified, { message = "Clouds set to " .. value },
        "Clouds call succeeded but the admin value did not stick (likely clamped out of range)")
end

handlers.setClimateFloat = function(args)
    local climate = getClimateManager()
    if not climate then
        return false, nil, "ClimateManager not available"
    end

    local floatId = tonumber(args.floatId)
    local value = tonumber(args.value)
    local enable = args.enable ~= false

    if floatId == nil or value == nil then
        return false, nil, "floatId and value are required numbers"
    end

    local climateFloat = climate:getClimateFloat(floatId)
    if not climateFloat then
        return false, nil, "Invalid float ID: " .. floatId
    end

    local verified
    local success, err = pcall(function()
        climateFloat:setEnableAdmin(enable)
        if enable then
            climateFloat:setAdminValue(value)
            local adminValue = PanelBridge.tryGet(climateFloat, "getAdminValue")
            if adminValue == nil then
                verified = nil
            else
                verified = math.abs(adminValue - value) < 0.01
            end
        else
            local stillEnabled = PanelBridge.tryGet(climateFloat, "isEnableAdmin")
            if stillEnabled == nil then
                verified = nil
            else
                verified = stillEnabled == false
            end
        end
    end)

    if not success then
        return false, nil, "Failed to set climate float: " .. tostring(err)
    end

    return PanelBridge.verifiedResult(verified, {
        message = "Climate float set",
        floatId = floatId,
        value = value,
        enabled = enable,
        name = climateFloat:getName()
    }, "Climate float call succeeded but did not take effect")
end

local function countStillOverridden(climate)
    local stillOn = 0
    local checked = 0
    for floatId = 0, 12 do
        local cf = PanelBridge.tryGet(climate, "getClimateFloat", floatId)
        if cf then
            local enabled = PanelBridge.tryGet(cf, "isEnableAdmin")
            if enabled ~= nil then
                checked = checked + 1
                if enabled then stillOn = stillOn + 1 end
            end
        end
    end
    local snowBool = PanelBridge.tryGet(climate, "getClimateBool", 0)
    if snowBool then
        local enabled = PanelBridge.tryGet(snowBool, "isEnableAdmin")
        if enabled ~= nil then
            checked = checked + 1
            if enabled then stillOn = stillOn + 1 end
        end
    end
    return stillOn, checked
end

handlers.resetClimateOverrides = function(args)
    local climate = getClimateManager()
    if not climate then
        return false, nil, "ClimateManager not available"
    end

    if PanelBridge.invoke(climate, "resetAdmin") then
        local stillOn, checked = countStillOverridden(climate)
        local verified
        if checked == 0 then
            verified = nil
        else
            verified = stillOn == 0
        end
        return PanelBridge.verifiedResult(verified,
            { message = "Climate overrides reset via resetAdmin()", floatsReset = 13, boolsReset = 1 },
            "Reset call succeeded but " .. stillOn .. " of " .. checked .. " overrides are still active")
    end

    local resetCount = 0
    for floatId = 0, 12 do
        local cf = PanelBridge.tryGet(climate, "getClimateFloat", floatId)
        if cf and PanelBridge.invoke(cf, "setEnableAdmin", false) then
            resetCount = resetCount + 1
        end
    end

    local boolsReset = 0
    pcall(function()
        local snowBool = climate:getClimateBool(0)
        if snowBool and snowBool.setEnableAdmin then
            snowBool:setEnableAdmin(false)
            boolsReset = boolsReset + 1
        end
    end)

    local stillOn, checked = countStillOverridden(climate)
    local verified
    if checked == 0 then
        verified = nil
    else
        verified = stillOn == 0
    end

    return PanelBridge.verifiedResult(verified,
        { message = "Climate overrides reset", floatsReset = resetCount, boolsReset = boolsReset },
        "Reset call succeeded but " .. stillOn .. " of " .. checked .. " overrides are still active")
end

handlers.getClimateFloats = function(args)
    local climate = getClimateManager()
    if not climate then
        return false, nil, "ClimateManager not available"
    end

    local floatIds = {
        { id = 0, name = "FLOAT_DESATURATION" },
        { id = 1, name = "FLOAT_GLOBAL_LIGHT_INTENSITY" },
        { id = 2, name = "FLOAT_NIGHT_STRENGTH" },
        { id = 3, name = "FLOAT_PRECIPITATION_INTENSITY" },
        { id = 4, name = "FLOAT_TEMPERATURE" },
        { id = 5, name = "FLOAT_FOG_INTENSITY" },
        { id = 6, name = "FLOAT_WIND_INTENSITY" },
        { id = 7, name = "FLOAT_WIND_ANGLE_INTENSITY" },
        { id = 8, name = "FLOAT_CLOUD_INTENSITY" },
        { id = 9, name = "FLOAT_AMBIENT" },
        { id = 10, name = "FLOAT_VIEW_DISTANCE" },
        { id = 11, name = "FLOAT_DAYLIGHT_STRENGTH" },
        { id = 12, name = "FLOAT_HUMIDITY" }
    }

    local floats = {}
    local skipped = 0
    for _, info in ipairs(floatIds) do
        local ok, entry = pcall(function()
            local cf = climate:getClimateFloat(info.id)
            if not cf then return nil end
            return {
                id = info.id,
                name = info.name,
                actualName = cf:getName(),
                value = cf:getFinalValue(),
                min = cf:getMin(),
                max = cf:getMax(),
                isAdminEnabled = PanelBridge.safeGet(cf, "isEnableAdmin", false)
            }
        end)
        if ok and entry then
            table.insert(floats, entry)
        else
            skipped = skipped + 1
        end
    end

    return true, { floats = floats, skipped = skipped }
end


local function emitWorldSound(player, x, y, z, radius, volume)
    local method = "unknown"
    local ok, err = pcall(function()
        if addSound then
            addSound(player, x, y, z, radius, volume)
            method = "addSound"
        elseif getWorld and getWorld() and getWorld().getWorldSoundManager then
            local wsm = getWorld():getWorldSoundManager()
            if wsm and wsm.addSound then
                wsm:addSound(player, x, y, z, radius, volume)
                method = "WorldSoundManager.addSound"
            else
                error("No sound API available")
            end
        else
            error("No sound API available")
        end
    end)
    if not ok then
        return false, "sound emission failed: " .. tostring(err)
    end
    return true, method
end

handlers.playWorldSound = function(args)
    local x = tonumber(args.x)
    local y = tonumber(args.y)
    local z = tonumber(args.z) or 0
    local radius = tonumber(args.radius) or 50
    local volume = tonumber(args.volume) or 100

    if not x or not y then
        return false, nil, "x and y coordinates are required"
    end

    local ok, methodOrErr = emitWorldSound(nil, x, y, z, radius, volume)
    if not ok then
        return false, nil, methodOrErr
    end

    return true, {
        message = "World sound created",
        x = x,
        y = y,
        z = z,
        radius = radius,
        volume = volume,
        method = methodOrErr
    }
end

handlers.playSoundNearPlayer = function(args)
    local username = args.username
    local radius = tonumber(args.radius) or 50
    local volume = tonumber(args.volume) or 100

    if not username then
        return false, nil, "username is required"
    end

    local player = getPlayerByUsername(username)
    if not player then
        return false, nil, "Player not found: " .. username
    end

    local x = player:getX()
    local y = player:getY()
    local z = player:getZ()

    local ok, methodOrErr = emitWorldSound(player, x, y, z, radius, volume)
    if not ok then
        return false, nil, methodOrErr
    end

    return true, {
        message = "Sound created near player",
        username = username,
        x = x,
        y = y,
        z = z,
        radius = radius,
        volume = volume,
        method = methodOrErr
    }
end

handlers.triggerGunshot = function(args)
    local x = tonumber(args.x)
    local y = tonumber(args.y)
    local z = tonumber(args.z) or 0
    local username = args.username

    if username then
        local player = getPlayerByUsername(username)
        if player then
            x = player:getX()
            y = player:getY()
            z = player:getZ()
        else
            return false, nil, "Player not found: " .. username
        end
    end

    if not x or not y then
        return false, nil, "Either coordinates (x, y) or username is required"
    end

    local gunshotRadius = 150
    local gunshotVolume = 200

    local ok, methodOrErr = emitWorldSound(nil, x, y, z, gunshotRadius, gunshotVolume)
    if not ok then
        return false, nil, methodOrErr
    end

    return true, {
        message = "Gunshot sound triggered",
        x = x,
        y = y,
        z = z,
        radius = gunshotRadius,
        method = methodOrErr
    }
end

handlers.triggerAlarmSound = function(args)
    local x = tonumber(args.x)
    local y = tonumber(args.y)
    local z = tonumber(args.z) or 0
    local username = args.username

    if username then
        local player = getPlayerByUsername(username)
        if player then
            x = player:getX()
            y = player:getY()
            z = player:getZ()
        else
            return false, nil, "Player not found: " .. username
        end
    end

    if not x or not y then
        return false, nil, "Either coordinates (x, y) or username is required"
    end

    local alarmRadius = 80
    local alarmVolume = 100

    local ok, methodOrErr = emitWorldSound(nil, x, y, z, alarmRadius, alarmVolume)
    if not ok then
        return false, nil, methodOrErr
    end

    return true, {
        message = "Alarm sound triggered",
        x = x,
        y = y,
        z = z,
        radius = alarmRadius,
        method = methodOrErr
    }
end

handlers.createNoise = function(args)
    local x = tonumber(args.x)
    local y = tonumber(args.y)
    local z = tonumber(args.z) or 0
    local radius = tonumber(args.radius) or 100
    local volume = tonumber(args.volume) or 100
    local username = args.username

    if username then
        local player = getPlayerByUsername(username)
        if player then
            x = player:getX()
            y = player:getY()
            z = player:getZ()
        else
            return false, nil, "Player not found: " .. username
        end
    end

    if not x or not y then
        return false, nil, "Either coordinates (x, y) or username is required"
    end

    radius = math.min(math.max(radius, 10), 500)
    volume = math.min(math.max(volume, 1), 500)

    local ok, method = emitWorldSound(nil, x, y, z, radius, volume)
    if not ok then
        return false, nil, "createNoise failed: " .. tostring(method)
    end

    return true, {
        message = "Noise created",
        x = x,
        y = y,
        z = z,
        radius = radius,
        volume = volume,
        method = method
    }
end


local function safeGetValue(obj, methodName, default)
    local success, result = PanelBridge.invoke(obj, methodName)
    if success and result ~= nil then
        return result
    end
    return default
end

handlers.getGameTime = function(args)
    local gameTime = getGameTime()
    if not gameTime then
        return false, nil, "GameTime not available"
    end

    local timeOfDay = gameTime:getTimeOfDay()
    local hour = math.floor(timeOfDay)
    return true, {
        year = gameTime:getYear(),
        month = gameTime:getMonth() + 1,
        day = gameTime:getDay(),
        hour = timeOfDay,
        minute = math.floor((timeOfDay - hour) * 60),
        dayOfWeek = 0,
        worldAgeHours = gameTime:getWorldAgeHours(),
        timeSinceApo = 0,
        moonPhase = 0,
        nightsSurvived = gameTime:getNightsSurvived(),
        multiplier = tonumber(PanelBridge.tryGet(gameTime, "getMultiplier")) or 1
    }
end

handlers.setGameTime = function(args)
    local gameTime = getGameTime()
    if not gameTime then
        return false, nil, "GameTime not available"
    end

    local updated = {}

    local function setAndVerify(methodName, value, getterName, expected)
        local ok, err = PanelBridge.invoke(gameTime, methodName, value)
        if not ok then
            return false, "Failed to call " .. methodName .. ": " .. tostring(err)
        end

        local actual = safeGetValue(gameTime, getterName, nil)
        if actual ~= expected then
            return false, methodName .. " did not apply (expected " .. tostring(expected) .. ", got " .. tostring(actual) .. ")"
        end
        return true
    end

    if args.hour ~= nil then
        local hour = tonumber(args.hour) or 12
        local ok, err = setAndVerify("setTimeOfDay", hour, "getTimeOfDay", hour)
        if not ok then return false, nil, err end
        updated.hour = hour
    end

    if args.day ~= nil then
        local day = tonumber(args.day)
        if day then
            local ok, err = setAndVerify("setDay", day, "getDay", day)
            if not ok then return false, nil, err end
            updated.day = day
        end
    end

    if args.month ~= nil then
        local month = tonumber(args.month)
        if month then
            month = math.max(1, math.min(12, month))
            local ok, err = setAndVerify("setMonth", month - 1, "getMonth", month - 1)
            if not ok then return false, nil, err end
            updated.month = month
        end
    end

    if args.year ~= nil then
        local year = tonumber(args.year)
        if year then
            local ok, err = setAndVerify("setYear", year, "getYear", year)
            if not ok then return false, nil, err end
            updated.year = year
        end
    end

    return true, { message = "Game time updated", updated = updated }
end

handlers.getWorldStats = function(args)
    local world = getWorld()
    if not world then
        return false, nil, "World not available"
    end

    local cell = world:getCell()
    local zombieCount = 0
    if cell and cell.getZombieList then
        pcall(function()
            local list = cell:getZombieList()
            if list then
                zombieCount = list:size()
            end
        end)
    end

    return true, {
        serverName = getServerName(),
        map = world:getMap() or "Unknown",
        zombiesInCell = zombieCount
    }
end

handlers.getTimeSpeed = function(args)
    local gt = getGameTime()
    if not gt then
        return false, nil, "GameTime not available"
    end

    local multiplier = tonumber(PanelBridge.tryGet(gt, "getMultiplier")) or 1

    return true, { multiplier = multiplier }
end

handlers.setTimeSpeed = function(args)
    return false, nil, "Time speed must use the server RCON command; PanelBridge cannot change the dedicated server clock multiplier"
end

handlers.triggerHelicopterEvent = function(args)
    if args.username then
        return false, nil, "Helicopter events cannot target a specific player on this build -- " ..
            "testHelicopter() (the only real API, confirmed against the real B42 jar) triggers " ..
            "server-wide and takes no arguments. Call this action with no username."
    end

    local ok, err = pcall(function()
        testHelicopter()
    end)

    if not ok then
        return false, nil, "Failed to trigger helicopter: " .. tostring(err)
    end

    PanelBridge.info("Helicopter triggered (server-wide)")
    return true, {
        message = "Helicopter event triggered server-wide (not per-player -- no per-player " ..
            "targeting API exists on this build)"
    }
end

handlers.stopHelicopterEvent = function(args)
    if args.username then
        return false, nil, "Helicopter events cannot target a specific player on this build -- " ..
            "endHelicopter() (the only real API, confirmed against the real B42 jar) stops the " ..
            "server-wide event and takes no arguments. Call this action with no username."
    end

    local ok, err = pcall(function()
        endHelicopter()
    end)

    if not ok then
        return false, nil, "Failed to stop helicopter: " .. tostring(err)
    end

    PanelBridge.info("Helicopter stopped (server-wide)")
    return true, {
        message = "Helicopter event stop signal sent server-wide"
    }
end

handlers.getPlayerDetails = function(args)
    local username = args.username
    if not username then
        return false, nil, "Username required"
    end

    local player = getPlayerByUsername(username)
    if not player then
        return false, nil, "Player not found: " .. username
    end

    local ok, playerData = pcall(function()
        local function get(obj, methodName)
            return PanelBridge.tryGet(obj, methodName)
        end

        local stats = PanelBridge.tryGet(player, "getStats")
        local bodyDamage = PanelBridge.tryGet(player, "getBodyDamage")

        local pd = {
            username = get(player, "getUsername"),
            displayName = get(player, "getDisplayName"),
            x = get(player, "getX"),
            y = get(player, "getY"),
            z = get(player, "getZ"),
            accessLevel = get(player, "getAccessLevel"),
            isAlive = get(player, "isAlive"),
            isAsleep = get(player, "isAsleep"),
            isSneaking = get(player, "isSneaking"),
            isRunning = get(player, "isRunning"),
            stats = {},
            health = {}
        }

        if stats then
            pd.stats = {
                hunger = statGet(stats, "HUNGER"),
                thirst = statGet(stats, "THIRST"),
                fatigue = statGet(stats, "FATIGUE"),
                stress = statGet(stats, "STRESS"),
                boredom = statGet(stats, "BOREDOM"),
                unhappiness = statGet(stats, "UNHAPPINESS"),
                pain = statGet(stats, "PAIN"),
                endurance = statGet(stats, "ENDURANCE")
            }
        end

        if bodyDamage then
            local numPartsBleeding = get(bodyDamage, "getNumPartsBleeding")

            local thermoregulator = PanelBridge.tryGet(bodyDamage, "getThermoregulator")

            local isBleeding = nil
            if numPartsBleeding ~= nil then
                isBleeding = numPartsBleeding > 0
            end

            pd.health = {
                overallBodyHealth = get(bodyDamage, "getOverallBodyHealth"),
                isInfected = get(bodyDamage, "IsInfected"),
                isBleeding = isBleeding,
                health = get(bodyDamage, "getHealth"),
                temperature = thermoregulator and get(thermoregulator, "getCoreTemperature") or nil
            }
        end

        return pd
    end)

    if not ok then
        return false, nil, "Error reading player details: " .. tostring(playerData)
    end

    return true, playerData
end

handlers.getAllPlayerDetails = function(args)
    local onlinePlayers = getOnlinePlayers()
    local players = {}

    if not onlinePlayers then
        return true, { players = {} }
    end

    for i = 0, onlinePlayers:size() - 1 do
        local player = onlinePlayers:get(i)
        if player then
            local ok, playerData = pcall(function()
                local function get(obj, methodName)
                    return PanelBridge.tryGet(obj, methodName)
                end

                local stats = PanelBridge.tryGet(player, "getStats")
                local bodyDamage = PanelBridge.tryGet(player, "getBodyDamage")

                local pd = {
                    username = get(player, "getUsername"),
                    displayName = get(player, "getDisplayName"),
                    x = get(player, "getX"),
                    y = get(player, "getY"),
                    z = get(player, "getZ"),
                    accessLevel = get(player, "getAccessLevel"),
                    isAlive = get(player, "isAlive")
                }

                if stats then
                    pd.hunger = statGet(stats, "HUNGER")
                    pd.thirst = statGet(stats, "THIRST")
                    pd.fatigue = statGet(stats, "FATIGUE")
                end

                if bodyDamage then
                    pd.health = get(bodyDamage, "getOverallBodyHealth")
                    pd.isInfected = get(bodyDamage, "IsInfected")
                end

                return pd
            end)

            if ok and playerData then
                table.insert(players, playerData)
            else
                local nameOk, name = pcall(function() return player:getUsername() end)
                table.insert(players, {
                    username = nameOk and name or "unknown",
                    error = tostring(playerData)
                })
            end
        end
    end

    return true, { players = players }
end


local function serializeInventory(container, depth, maxItems, currentCount)
    depth = depth or 1
    maxItems = maxItems or 1000
    currentCount = currentCount or { n = 0 }

    if not container then return {}, "container is nil" end
    if depth > 4 then return {}, "max depth exceeded" end

    local items = {}

    local itemList = nil
    local method = "none"

    itemList = PanelBridge.tryGet(container, "getItems")
    if itemList then method = "getItems" end

    if not itemList and container.getAllItems then
        local ok, result = pcall(function() return container:getAllItems() end)
        if ok and result then
            itemList = result
            method = "getAllItems"
        end
    end

    if not itemList then return {}, "no items method (tried: getItems, getAllItems)" end

    local sizeOk, listSize = pcall(function() return itemList:size() end)
    if not sizeOk or type(listSize) ~= "number" then
        return {}, method .. " size() failed"
    end

    if listSize == 0 then return {}, method .. " returned size 0" end

    for i = 0, listSize - 1 do
        if currentCount.n >= maxItems then break end
        local item = itemList:get(i)
        if item then
            local ok, itemData = pcall(function()
                local data = {
                    fullType = item:getFullType(),
                    type = item:getType(),
                    name = item:getName(),
                    count = PanelBridge.safeGet(item, "getCount", 1),
                    isFavorite = PanelBridge.safeGet(item, "isFavorite", false),
                    isEquipped = PanelBridge.safeGet(item, "isEquipped", false)
                }

                data.condition = PanelBridge.tryGet(item, "getCondition")
                data.uses = PanelBridge.tryGet(item, "getCurrentUses")

                if PanelBridge.tryGet(item, "IsInventoryContainer") then
                    local subContainer = item:getItemContainer()
                    if subContainer then
                        data.contents = serializeInventory(subContainer, depth + 1, maxItems, currentCount)
                    end
                end

                data.jobDelta = PanelBridge.tryGet(item, "getJobDelta")
                data.useDelta = PanelBridge.tryGet(item, "getUseDelta")
                data.delta = PanelBridge.tryGet(item, "getDelta")

                return data
            end)

            if ok and itemData then
                table.insert(items, itemData)
                currentCount.n = currentCount.n + 1
            end
        end
    end

    return items
end

local function getPlayerPerks(player)
    local perks = {}

    local xpOk, xp = pcall(function() return player:getXp() end)
    if not xpOk or not xp then return perks, "player:getXp() failed or returned nil" end

    local perkNames = {
        "Fitness", "Strength",
        "Sprinting", "Lightfoot", "Nimble", "Sneak",
        "Axe", "Blunt", "SmallBlunt", "LongBlade", "ShortBlade", "Spear", "Maintenance",
        "Woodwork", "Cooking", "Farming", "Doctor", "Electricity", "MetalWelding",
        "Mechanics", "Tailoring", "Aiming", "Reloading",
        "Fishing", "Trapping", "PlantScavenging"
    }

    local failures = 0
    for _, perkName in ipairs(perkNames) do
        local perkOk, perk = pcall(function() return Perks[perkName] end)
        if not perkOk then
            failures = failures + 1
        elseif perk then
            local ok, level, perkXp = pcall(function()
                return player:getPerkLevel(perk), xp:getXP(perk)
            end)
            if ok then
                perks[perkName] = {
                    level = level,
                    xp = perkXp
                }
            else
                failures = failures + 1
            end
        end
    end

    if failures > 0 then return perks, failures .. " perk(s) failed to read" end
    return perks, "ok"
end

local function getPlayerTraits(player)
    local traits = {}
    local traitList = nil
    local method = "none"

    local charTraits = PanelBridge.tryGet(player, "getCharacterTraits")
    if charTraits then
        traitList = PanelBridge.tryGet(charTraits, "getKnownTraits")
        if traitList then method = "player:getCharacterTraits():getKnownTraits" end
    end

    local desc = PanelBridge.tryGet(player, "getDescriptor")

    if desc then
        if not traitList then
            traitList = PanelBridge.tryGet(desc, "getTraitList")
            if traitList then method = "desc:getTraitList" end
        end
        if not traitList then
            traitList = PanelBridge.tryGet(desc, "getTraits")
            if traitList then method = "desc:getTraits" end
        end
    end

    if not traitList then
        traitList = PanelBridge.tryGet(player, "getTraits")
        if traitList then method = "player:getTraits" end
    end

    if not traitList then return {}, "no trait method worked (tried: player:getCharacterTraits():getKnownTraits, desc:getTraitList, desc:getTraits, player:getTraits)" end

    local sizeOk, listSize = pcall(function() return traitList:size() end)
    if not sizeOk or type(listSize) ~= "number" then
        return {}, method .. " size() failed"
    end

    if listSize == 0 then return {}, method .. " returned size 0" end

    for i = 0, listSize - 1 do
        local ok, trait = pcall(function() return traitList:get(i) end)
        if ok and trait then
            if type(trait) == "string" then
                table.insert(traits, trait)
            else
                local typeOk, typeValue = PanelBridge.invoke(trait, "getType")
                if not typeOk then
                    typeOk, typeValue = PanelBridge.invoke(trait, "toString")
                end
                table.insert(traits, typeOk and typeValue or tostring(trait))
            end
        end
    end

    return traits, method .. " found " .. #traits
end

local function getKnownRecipes(player)
    local recipes = {}
    local listOk, recipeList = pcall(function() return player:getKnownRecipes() end)
    if not listOk or not recipeList then return recipes, "player:getKnownRecipes() failed or returned nil" end

    local sizeOk, listSize = pcall(function() return recipeList:size() end)
    if not sizeOk or type(listSize) ~= "number" then return recipes, "getKnownRecipes():size() failed" end

    for i = 0, listSize - 1 do
        local ok, recipe = pcall(function() return recipeList:get(i) end)
        if ok and recipe then table.insert(recipes, recipe) end
    end

    return recipes, #recipes .. " recipe(s) found"
end

local function getWornItems(player)
    local worn = {}
    local wornItems = nil
    local method = "none"

    wornItems = PanelBridge.tryGet(player, "getWornItems")
    if wornItems then method = "getWornItems" end

    if not wornItems then return {}, "getWornItems returned nil or failed" end

    local sizeOk, listSize = pcall(function() return wornItems:size() end)
    if not sizeOk or type(listSize) ~= "number" then
        return {}, method .. " size() failed"
    end

    if listSize == 0 then return {}, method .. " returned size 0" end

    for i = 0, listSize - 1 do
        local ok, wornData = pcall(function()
            local item = wornItems:get(i)
            if item and item:getItem() then
                return {
                    location = item:getLocation(),
                    fullType = item:getItem():getFullType(),
                    condition = item:getItem():getCondition()
                }
            end
            return nil
        end)
        if ok and wornData then
            table.insert(worn, wornData)
        end
    end

    return worn, method .. " found " .. #worn
end

handlers.exportPlayerData = function(args)
    local username = args.username
    if not username then
        return false, nil, "Username required"
    end

    local player = getPlayerByUsername(username)
    if not player then
        return false, nil, "Player not found: " .. username
    end

    local diag = {}

    local traits, traitDiag = getPlayerTraits(player)
    diag.traits = traitDiag or "ok"

    local wornItems, wornDiag = getWornItems(player)
    diag.wornItems = wornDiag or "ok"

    local mainInv = nil
    local invDiag = "not attempted"
    local playerInventory = PanelBridge.tryGet(player, "getInventory")
    if playerInventory then
        mainInv, invDiag = serializeInventory(playerInventory)
    else
        invDiag = "getInventory() failed or returned nil"
    end
    diag.inventory = invDiag

    local bagItems = {}
    local bagCount = 0
    if wornItems then
        for _, worn in ipairs(type(wornItems) == "table" and wornItems or {}) do
            if worn.fullType then
                local ok, wornObj = pcall(function()
                    local wi = player:getWornItems()
                    if wi then
                        for j = 0, wi:size() - 1 do
                            local w = wi:get(j)
                            if w and w:getItem() and w:getItem():getFullType() == worn.fullType then
                                if w:getItem().getItemContainer then
                                    local subContainer = w:getItem():getItemContainer()
                                    if subContainer then
                                        local subItems = serializeInventory(subContainer)
                                        if #subItems > 0 then
                                            local locationKey = worn.location and tostring(worn.location) or worn.fullType
                                            bagItems[locationKey] = subItems
                                            bagCount = bagCount + #subItems
                                        end
                                    end
                                end
                            end
                        end
                    end
                end)
            end
        end
    end
    diag.bagItems = bagCount .. " items in " .. (function() local c = 0; for _ in pairs(bagItems) do c = c + 1 end; return c end)() .. " bags"

    local perks, perksDiag = getPlayerPerks(player)
    diag.perks = perksDiag

    local recipes, recipesDiag = getKnownRecipes(player)
    diag.recipes = recipesDiag

    local exportData = {
        version = "1.3",
        exportTime = getTimestampMs(),
        serverName = getServerName(),

        username = PanelBridge.tryGet(player, "getUsername"),
        displayName = PanelBridge.tryGet(player, "getDisplayName"),

        perks = perks,

        traits = traits,

        recipes = recipes,

        wornItems = wornItems,

        kills = {
            zombies = PanelBridge.tryGet(player, "getZombieKills")
        },

        inventory = mainInv or {},

        bagInventory = bagItems,

        _diagnostics = diag
    }

    return true, exportData
end

handlers.importPlayerData = function(args)
    local username = args.username
    local data = args.data
    local options = args.options or {}

    if not username then
        return false, nil, "Username required"
    end
    if not data then
        return false, nil, "Import data required"
    end

    local player = getPlayerByUsername(username)
    if not player then
        return false, nil, "Player not found: " .. username
    end

    local restored = {
        perks = 0,
        items = 0
    }

    if data.perks and options.restorePerks ~= false then
        local xp = PanelBridge.tryGet(player, "getXp")
        for perkName, perkData in pairs(data.perks) do
            local perkOk, perk = pcall(function() return Perks[perkName] end)
            if perkOk and perk and perkData.level then
                pcall(function()
                    player:level0(perk)
                    for lvl = 1, perkData.level do
                        player:LevelPerk(perk, false)
                    end
                    restored.perks = restored.perks + 1

                    if xp then
                        pcall(function() xp:setXPToLevel(perk, perkData.level) end)
                    end
                end)
            end
        end
    end

    if data.inventory and options.restoreInventory ~= false then
        local inventory = player:getInventory()
        if inventory then
            local MAX_DEPTH = 3
            local MAX_ITEMS = 500
            local totalAdded = 0
            local function addItems(container, itemList, depth)
                if depth > MAX_DEPTH then return end
                if type(itemList) ~= "table" then return end
                for _, itemData in ipairs(itemList) do
                    if totalAdded >= MAX_ITEMS then break end
                    if type(itemData) ~= "table" or not itemData.fullType then
                    else
                        local ok, result = pcall(function()
                            local count = math.min(itemData.count or 1, 100)
                            for c = 1, count do
                                if totalAdded >= MAX_ITEMS then break end
                                local newItem = container:AddItem(itemData.fullType)
                                if newItem then
                                    if itemData.condition and newItem.setCondition then
                                        newItem:setCondition(itemData.condition)
                                    end
                                    if itemData.uses and newItem.setCurrentUses then
                                        newItem:setCurrentUses(itemData.uses)
                                    end
                                    if itemData.jobDelta and newItem.setJobDelta then
                                        newItem:setJobDelta(itemData.jobDelta)
                                    end
                                    if itemData.useDelta and newItem.setUseDelta then
                                        newItem:setUseDelta(itemData.useDelta)
                                    end
                                    if itemData.delta and newItem.setDelta then
                                        newItem:setDelta(itemData.delta)
                                    end
                                    if itemData.contents and type(itemData.contents) == "table" and newItem.getItemContainer then
                                        local subContainer = newItem:getItemContainer()
                                        if subContainer then
                                            addItems(subContainer, itemData.contents, depth + 1)
                                        end
                                    end
                                    totalAdded = totalAdded + 1
                                    restored.items = restored.items + 1
                                end
                            end
                        end)
                    end
                end
            end

            addItems(inventory, data.inventory, 1)

            pcall(function()
                if sendPlayerExtraInfo then sendPlayerExtraInfo(player) end
            end)
        end
    end

    return true, {
        message = "Player data imported",
        restored = restored
    }
end

handlers.teleportPlayer = function(args)
    local username = args.username
    local x = tonumber(args.x)
    local y = tonumber(args.y)
    local z = tonumber(args.z) or 0

    if not username or not x or not y then
        return false, nil, "Username, x, y required"
    end

    if x < 0 or x > 24000 or y < 0 or y > 24000 then
        return false, nil, "Coordinates out of range (x/y: 0-24000)"
    end
    z = math.max(0, math.min(math.floor(z), 8))

    local player = getPlayerByUsername(username)
    if not player then
        return false, nil, "Player not found: " .. username
    end

    local oldX = player:getX()
    local oldY = player:getY()
    local oldZ = player:getZ()
    local debugInfo = {}

    pcall(function()
        local v = PanelBridge.tryGet(player, "getVehicle")
        if v then
            if PanelBridge.invoke(v, "exit", player) then
                table.insert(debugInfo, "vehicle exit")
            end
        end
    end)

    pcall(function()
        if ISTimedActionQueue and ISTimedActionQueue.clear then
            ISTimedActionQueue.clear(player)
            table.insert(debugInfo, "timedActionQueue cleared")
        end
    end)

    if PanelBridge.invoke(player, "setNetworkTeleportEnabled", true) then
        table.insert(debugInfo, "networkTeleportEnabled(pre) set")
    end

    local okTeleport, teleportErr = PanelBridge.invoke(player, "teleportTo", x, y, z)
    if okTeleport then
        table.insert(debugInfo, "teleportTo called")
    else
        table.insert(debugInfo, "teleportTo unavailable: " .. tostring(teleportErr))
    end

    local forcedX = PanelBridge.invoke(player, "setX", x)
    local forcedY = PanelBridge.invoke(player, "setY", y)
    local forcedZ = PanelBridge.invoke(player, "setZ", z)
    if forcedX or forcedY or forcedZ then
        table.insert(debugInfo, "setXYZ forced")
    end

    if PanelBridge.invoke(player, "setLx", x) then
        PanelBridge.invoke(player, "setLy", y)
        PanelBridge.invoke(player, "setLz", z)
        table.insert(debugInfo, "setLxyz done")
    end

    if PanelBridge.invoke(player, "setNetworkTeleportEnabled", true) then
        table.insert(debugInfo, "networkTeleportEnabled(post) set")
    end

    pcall(function()
        if sendPlayerExtraInfo then
            sendPlayerExtraInfo(player)
            table.insert(debugInfo, "sendPlayerExtraInfo pushed")
        end
    end)

    local verifyX = player:getX()
    local verifyY = player:getY()
    local verifyZ = player:getZ()
    table.insert(debugInfo, "verify pos: " .. verifyX .. "," .. verifyY .. "," .. verifyZ)

    pcall(function()
        local probe = {}
        for _, name in ipairs({
            "setNetworkTeleportEnabled", "setLx", "setPosition", "teleportTo",
            "setForceUpdate", "sendObjectChange", "getOnlineID",
        }) do
            if player[name] then table.insert(probe, name) end
        end
        for _, name in ipairs({
            "sendPlayerExtraInfo", "syncPlayerFields", "NetworkTeleport",
            "sendServerCommand", "getPlayerInfo", "updatePlayerPosition",
        }) do
            if _G[name] then table.insert(probe, "_G." .. name) end
        end
        table.insert(debugInfo, "available: " .. table.concat(probe, ","))
    end)

    local debugStr = table.concat(debugInfo, " | ")
    PanelBridge.debug("teleportPlayer: " .. username .. " from " .. oldX .. "," .. oldY .. "," .. oldZ
        .. " to " .. x .. "," .. y .. "," .. z .. " — " .. debugStr)

    local EPSILON = 0.5
    local function dist3(ax, ay, az, bx, by, bz)
        return math.sqrt((ax - bx) ^ 2 + (ay - by) ^ 2 + (az - bz) ^ 2)
    end
    local requestedDistance = dist3(oldX, oldY, oldZ, x, y, z)
    local actualDistance = dist3(oldX, oldY, oldZ, verifyX, verifyY, verifyZ)

    local verified
    if requestedDistance <= EPSILON then
        verified = nil
    elseif actualDistance <= EPSILON then
        verified = false
    else
        verified = true
    end

    if verified == false then
        return false, {
            oldPosition = { x = oldX, y = oldY, z = oldZ },
            newPosition = { x = x, y = y, z = z },
            verifyPosition = { x = verifyX, y = verifyY, z = verifyZ },
            debug = debugStr
        }, "Teleport call succeeded but the player did not move (still at origin)"
    end

    local verifiedStr = "unverifiable"
    if verified == true then verifiedStr = "confirmed" end

    return true, {
        message = "Player teleported",
        oldPosition = { x = oldX, y = oldY, z = oldZ },
        newPosition = { x = x, y = y, z = z },
        verifyPosition = { x = verifyX, y = verifyY, z = verifyZ },
        verified = verifiedStr,
        debug = debugStr
    }
end

handlers.getSandboxOptions = function(args)
    return handlers.getAllSandboxOptions(args)
end

handlers.getAllSandboxOptions = function(args)
    local sandbox = getSandboxOptions()
    if not sandbox then
        return false, nil, "SandboxOptions not available"
    end

    local allOptions = {}
    local totalCount = 0

    local function getOptionValue(opt)
        local raw = nil
        raw = PanelBridge.tryGet(opt, "getValue")
        if raw == nil then
            raw = PanelBridge.tryGet(opt, "getIntValue")
        end
        if raw == nil and opt.value ~= nil then raw = opt.value end
        if raw == nil then return nil end
        local t = type(raw)
        if t == "string" or t == "number" or t == "boolean" then return raw end
        local ok2, str = pcall(tostring, raw)
        return ok2 and str or nil
    end

    local function safeStr(fn)
        local ok, val = pcall(fn)
        if ok and val ~= nil then return tostring(val) end
        return nil
    end

    local function getOptionInfo(opt)
        local info = {}
        info.name = safeStr(function() return opt:getName() end)
        info.shortName = safeStr(function() return opt:getShortName() end)
        info.tableName = safeStr(function() return opt:getTableName() end)
        info.tooltip = safeStr(function() return opt:getTooltip() end)
        if info.tooltip then
            pcall(function()
                local translated = getText(info.tooltip)
                if translated and translated ~= info.tooltip and translated ~= "" then
                    info.tooltipText = translated
                end
            end)
            if not info.tooltipText and info.tooltip:find(" ") then
                info.tooltipText = info.tooltip
            end
        end
        info.translatedName = safeStr(function() return opt:getTranslatedName() end)
        info.pageName = safeStr(function() return opt:getPageName() end)
        info.value = getOptionValue(opt)
        pcall(function()
            if not opt.getClass then return end
            local classObj = opt:getClass()
            if not classObj then return end
            local className = tostring(classObj)
            if className:find("Boolean") then
                info.type = "boolean"
            elseif className:find("Double") or className:find("Integer") or className:find("Numeric") then
                info.type = "number"
            elseif className:find("Enum") then
                info.type = "enum"
                pcall(function()
                    local numVals = tonumber(PanelBridge.tryGet(opt, "getNumValues"))
                    if numVals and numVals > 0 then
                        info.enumValues = {}
                        local cap = math.min(numVals, 50)
                        for i = 0, cap - 1 do
                            local translated = PanelBridge.tryGet(opt, "getValueTranslationByIndexOrNull", i)
                            if translated ~= nil then
                                table.insert(info.enumValues, tostring(translated))
                            end
                        end
                    end
                end)
                info.selectedIndex = PanelBridge.tryGet(opt, "getValue")
            elseif className:find("String") then
                info.type = "string"
            else
                info.type = className
            end
        end)
        local minValue = PanelBridge.tryGet(opt, "getMin")
        if type(minValue) == "number" then info.min = minValue end
        local maxValue = PanelBridge.tryGet(opt, "getMax")
        if type(maxValue) == "number" then info.max = maxValue end
        local defaultValue = PanelBridge.tryGet(opt, "getDefaultValue")
        if defaultValue ~= nil then
            local t = type(defaultValue)
            if t == "string" or t == "number" or t == "boolean" then
                info.default = defaultValue
            else
                local ok2, str = pcall(tostring, defaultValue)
                if ok2 then info.default = str end
            end
        end
        return info
    end

    local enumerated = false
    pcall(function()
        local numOptions = sandbox:getNumOptions()
        if numOptions and numOptions > 0 then
            for i = 0, numOptions - 1 do
                pcall(function()
                    local opt = sandbox:getOptionByIndex(i)
                    if opt then
                        local info = getOptionInfo(opt)
                        if info.name then
                            local group = (info.tableName and info.tableName ~= "") and info.tableName or "Vanilla"
                            if not allOptions[group] then
                                allOptions[group] = {}
                            end
                            table.insert(allOptions[group], info)
                            totalCount = totalCount + 1
                        end
                    end
                end)
            end
            enumerated = true
        end
    end)

    if not enumerated then
        pcall(function()
            local optionsList = sandbox:getOptions()
            if optionsList then
                local size = optionsList:size()
                for i = 0, size - 1 do
                    pcall(function()
                        local opt = optionsList:get(i)
                        if opt then
                            local info = getOptionInfo(opt)
                            if info.name then
                                local group = (info.tableName and info.tableName ~= "") and info.tableName or "Vanilla"
                                if not allOptions[group] then
                                    allOptions[group] = {}
                                end
                                table.insert(allOptions[group], info)
                                totalCount = totalCount + 1
                            end
                        end
                    end)
                end
                enumerated = true
            end
        end)
    end

    if not enumerated then
        pcall(function()
            for k, v in pairs(sandbox) do
                if type(v) ~= "function" then
                    pcall(function()
                        if v and type(v) == "userdata" and v.getName then
                            local info = getOptionInfo(v)
                            if info.name then
                                local group = (info.tableName and info.tableName ~= "") and info.tableName or "Vanilla"
                                if not allOptions[group] then
                                    allOptions[group] = {}
                                end
                                table.insert(allOptions[group], info)
                                totalCount = totalCount + 1
                            end
                        else
                            local group = "Vanilla"
                            if tostring(k):find("%.") then
                                group = tostring(k):match("^([^%.]+)")
                            end
                            if not allOptions[group] then
                                allOptions[group] = {}
                            end
                            local safeVal = v
                            local vt = type(v)
                            if vt ~= "string" and vt ~= "number" and vt ~= "boolean" and v ~= nil then
                                local ok3, str3 = pcall(tostring, v)
                                safeVal = ok3 and str3 or nil
                            end
                            table.insert(allOptions[group], {
                                name = tostring(k),
                                value = safeVal,
                                type = type(v)
                            })
                            totalCount = totalCount + 1
                        end
                    end)
                end
            end
            if totalCount > 0 then enumerated = true end
        end)
    end

    for group, opts in pairs(allOptions) do
        table.sort(opts, function(a, b)
            return (a.name or "") < (b.name or "")
        end)
    end

    local groups = {}
    for group, opts in pairs(allOptions) do
        table.insert(groups, { name = group, count = #opts })
    end
    table.sort(groups, function(a, b) return a.name < b.name end)

    PanelBridge.info("Sandbox options enumerated", {
        totalOptions = totalCount,
        groups = #groups,
        enumerated = enumerated
    })

    return true, {
        options = allOptions,
        groups = groups,
        totalCount = totalCount,
        enumerated = enumerated
    }
end

handlers.setSandboxOption = function(args)
    local optName = args and args.name
    local newValue = args and args.value
    if not optName or optName == "" then
        return false, nil, "Missing option name"
    end
    if newValue == nil then
        return false, nil, "Missing value"
    end

    local sandbox = getSandboxOptions()
    if not sandbox then
        return false, nil, "SandboxOptions not available"
    end

    local targetOpt = nil
    pcall(function()
        local numOptions = sandbox:getNumOptions()
        if numOptions and numOptions > 0 then
            for i = 0, numOptions - 1 do
                local opt = sandbox:getOptionByIndex(i)
                if opt and opt.getName then
                    local name = opt:getName()
                    if name == optName then
                        targetOpt = opt
                        return
                    end
                end
            end
        end
    end)

    if not targetOpt then
        pcall(function()
            local optionsList = sandbox:getOptions()
            if optionsList then
                local size = optionsList:size()
                for i = 0, size - 1 do
                    local opt = optionsList:get(i)
                    if opt and opt.getName then
                        local name = opt:getName()
                        if name == optName then
                            targetOpt = opt
                            return
                        end
                    end
                end
            end
        end)
    end

    if not targetOpt then
        return false, nil, "Option not found: " .. tostring(optName)
    end

    local optType = nil
    pcall(function()
        if not targetOpt.getClass then return end
        local className = tostring(targetOpt:getClass())
        if className:find("Boolean") then optType = "boolean"
        elseif className:find("Double") or className:find("Numeric") then optType = "double"
        elseif className:find("Integer") then optType = "integer"
        elseif className:find("Enum") then optType = "enum"
        elseif className:find("String") then optType = "string"
        end
    end)

    local ok, err
    local appliedValue
    if optType == "boolean" then
        local boolVal = (newValue == true or newValue == "true" or newValue == 1)
        appliedValue = boolVal
        ok, err = pcall(function() targetOpt:setValue(boolVal) end)
    elseif optType == "enum" then
        local intVal = tonumber(newValue)
        if not intVal then return false, nil, "Invalid enum value" end
        intVal = math.floor(intVal)
        local numVals = tonumber(PanelBridge.tryGet(targetOpt, "getNumValues"))
        if numVals and intVal >= numVals then intVal = numVals - 1 end
        if intVal < 0 then intVal = 0 end
        appliedValue = intVal
        ok, err = pcall(function() targetOpt:setValue(intVal) end)
    elseif optType == "integer" then
        local intVal = tonumber(newValue)
        if not intVal then return false, nil, "Invalid integer value" end
        intVal = math.floor(intVal)
        local intMin = PanelBridge.tryGet(targetOpt, "getMin")
        if type(intMin) == "number" and intVal < intMin then intVal = intMin end
        local intMax = PanelBridge.tryGet(targetOpt, "getMax")
        if type(intMax) == "number" and intVal > intMax then intVal = intMax end
        appliedValue = intVal
        ok, err = pcall(function() targetOpt:setValue(intVal) end)
    elseif optType == "double" then
        local numVal = tonumber(newValue)
        if not numVal then return false, nil, "Invalid numeric value" end
        local numMin = PanelBridge.tryGet(targetOpt, "getMin")
        if type(numMin) == "number" and numVal < numMin then numVal = numMin end
        local numMax = PanelBridge.tryGet(targetOpt, "getMax")
        if type(numMax) == "number" and numVal > numMax then numVal = numMax end
        appliedValue = numVal
        ok, err = pcall(function() targetOpt:setValue(numVal) end)
    elseif optType == "string" then
        local strVal = tostring(newValue)
        appliedValue = strVal
        ok, err = pcall(function() targetOpt:setValue(strVal) end)
    else
        ok, err = pcall(function() targetOpt:setValue(newValue) end)
    end

    if not ok then
        return false, nil, "Failed to set value: " .. tostring(err)
    end

    local confirmed = PanelBridge.tryGet(targetOpt, "getValue")
    if confirmed ~= nil then
        local t = type(confirmed)
        if t ~= "string" and t ~= "number" and t ~= "boolean" then
            local ok2, str = pcall(tostring, confirmed)
            confirmed = ok2 and str or nil
        end
    end

    local verified
    if appliedValue == nil or confirmed == nil then
        verified = nil
    elseif optType == "boolean" then
        if type(confirmed) == "boolean" then
            verified = (confirmed == appliedValue)
        else
            verified = (tostring(confirmed):lower() == tostring(appliedValue):lower())
        end
    elseif optType == "enum" or optType == "integer" or optType == "double" then
        local confirmedNum = tonumber(confirmed)
        if confirmedNum == nil then
            verified = nil
        else
            verified = (confirmedNum == appliedValue)
        end
    elseif optType == "string" then
        verified = (tostring(confirmed) == tostring(appliedValue))
    end

    PanelBridge.info("Sandbox option set", { name = optName, value = tostring(newValue), confirmed = tostring(confirmed), verified = verified })

    if verified == false then
        return false, nil, "Value set but did not take effect (requested " .. tostring(appliedValue) .. ", confirmed " .. tostring(confirmed) .. ")"
    end

    PanelBridge.invoke(sandbox, "toLua")

    local persisted = false
    local saveErr = nil
    local saveOk, saveErrMsg = pcall(function() saveGame() end)
    if saveOk then
        persisted = true
    else
        saveErr = tostring(saveErrMsg)
    end
    if not persisted then
        PanelBridge.error("Sandbox option set but world save failed", { name = optName, error = saveErr })
    end

    local verifiedStr = "unverifiable"
    if verified == true then verifiedStr = "confirmed" end

    return true, {
        name = optName,
        value = confirmed,
        type = optType,
        verified = verifiedStr,
        persisted = persisted,
        saveError = saveErr
    }
end


local function resolveJavaClass(globalName, fullPath)
    local ok1, g = pcall(function() return _G[globalName] end)
    if ok1 and g then return g end
    local parts = {}
    for part in fullPath:gmatch("[^%.]+") do parts[#parts + 1] = part end
    local cur
    local ok
    ok, cur = pcall(function() return _G[parts[1]] end)
    if not ok or not cur then return nil end
    for i = 2, #parts do
        local parent = cur
        ok, cur = pcall(function() return parent[parts[i]] end)
        if not ok or not cur then return nil end
    end
    return cur
end

local function getChatSystem()
    local result = {}
    local ChatServerClass = resolveJavaClass("ChatServer", "zombie.network.chat.ChatServer")
    if not ChatServerClass then
        ChatServerClass = resolveJavaClass("ChatServer", "zombie.chat.ChatServer")
    end
    if not ChatServerClass then
        local ok, cs = pcall(function() return getChatServer end)
        if ok and cs and type(cs) == "function" then
            local ok2, inst = pcall(cs)
            if ok2 and inst then
                result.server = inst
                return result
            end
        end
    end
    if ChatServerClass then
        local inited = true
        if ChatServerClass.isInited then
            local ok, val = pcall(function() return ChatServerClass.isInited() end)
            if ok then inited = val end
        end
        if inited then
            local ok, inst = pcall(function() return ChatServerClass.getInstance() end)
            if ok and inst then
                result.server = inst
            end
        end
    end
    if result.server then return result end
    return nil
end

handlers.sendToServerChat = function(args)
    local message = normalizeMessage(args.message, 1000)
    local isAlert = args.alert or args.isAlert or false

    if not message then
        return false, nil, "Message required"
    end

    local chat = getChatSystem()

    if chat and chat.server then
        local ok, err = pcall(function()
            if isAlert then
                chat.server:sendServerAlertMessageToServerChat(message)
            else
                chat.server:sendMessageToServerChat(message)
            end
        end)
        if ok then
            return true, { message = "Message sent to server chat", isAlert = isAlert, method = "ChatServer" }
        end
    end

    local ok3, sent3 = pcall(function()
        local players = getOnlinePlayers()
        if players and players:size() > 0 then
            for i = 0, players:size() - 1 do
                local p = players:get(i)
                if p then p:Say(message) end
            end
            return true
        end
        return false
    end)
    if ok3 and sent3 then
        return true, { message = "Message sent via player:Say (overhead text only)", isAlert = isAlert, method = "player:Say" }
    end

    return false, nil, "useRCON"
end

handlers.sendToAdminChat = function(args)
    local message = normalizeMessage(args.message, 1000)

    if not message then
        return false, nil, "Message required"
    end

    local chat = getChatSystem()

    if chat and chat.server then
        local ok, err = pcall(function()
            chat.server:sendMessageToAdminChat(message)
        end)
        if ok then
            return true, { message = "Message sent to admin chat", method = "ChatServer" }
        end
    end

    local ok3, sent3 = pcall(function()
        local players = getOnlinePlayers()
        if players and players:size() > 0 then
            for i = 0, players:size() - 1 do
                local p = players:get(i)
                if p and p.accessLevel and p:getAccessLevel() ~= "" then
                    p:Say("[ADMIN] " .. message)
                end
            end
            return true
        end
        return false
    end)
    if ok3 and sent3 then
        return true, { message = "Message sent via player:Say (admin, overhead text only)", method = "player:Say" }
    end

    return false, nil, "useRCON"
end

handlers.sendToGeneralChat = function(args)
    local message = normalizeMessage(args.message, 1000)
    local author = normalizeMessage(args.author, 80) or "[Panel]"
    if author then
        author = author:gsub("[%c]", " ")
        if author == "" then author = "[Panel]" end
    end

    if not message then
        return false, nil, "Message required"
    end

    local chat = getChatSystem()

    if chat and chat.server then
        local ok, err = pcall(function()
            chat.server:sendMessageFromDiscordToGeneralChat(author, message)
        end)
        if ok then
            return true, { message = "Message sent to general chat", author = author, method = "ChatServer" }
        end
    end

    local ok3, sent3 = pcall(function()
        local players = getOnlinePlayers()
        if players and players:size() > 0 then
            for i = 0, players:size() - 1 do
                local p = players:get(i)
                if p then p:Say("[" .. author .. "] " .. message) end
            end
            return true
        end
        return false
    end)
    if ok3 and sent3 then
        return true, { message = "Message sent via player:Say (overhead text only)", author = author, method = "player:Say" }
    end

    return false, nil, "useRCON"
end

handlers.getChatInfo = function(args)
    local chat = getChatSystem()
    local info = {
        availableChats = {
            "serverChat - Messages from server to all players",
            "adminChat - Messages visible only to admins",
            "generalChat - General chat with custom author name"
        },
        note = "Chat handlers try native ChatServer API first, then player:Say, then signal backend to use RCON",
        chatServerAvailable = chat ~= nil and chat.server ~= nil,
        rconFallback = chat == nil or chat.server == nil
    }

    return true, info
end

handlers.saveWorld = function(args)
    local success, err = pcall(function()
        saveGame()
    end)
    if success then
        return true, { message = "World save triggered" }
    else
        return false, nil, "World save failed: " .. tostring(err)
    end
end


handlers.getUtilitiesStatus = function(args)
    local world = getWorld()
    if not world then
        return false, nil, "World not available"
    end

    local hydroPowerOn = false
    local success, err = pcall(function()
        hydroPowerOn = world:isHydroPowerOn()
    end)

    if not success then
        return false, nil, "Failed to get utilities status: " .. tostring(err)
    end

    local sandbox = getSandboxOptions()
    local elecShut = "unknown"
    local waterShut = "unknown"
    local elecModifier = 0
    local waterModifier = 0

    local currentHour = 0
    local currentDay = 0
    local nightsSurvived = 0
    local timeSinceApo = 1
    local powerActuallyOn = false
    local waterActuallyOn = false

    pcall(function()
        if sandbox then
            local elecOpt = sandbox:getOptionByName("ElecShut")
            local waterOpt = sandbox:getOptionByName("WaterShut")
            if elecOpt and elecOpt.getValue then
                elecShut = tostring(elecOpt:getValue())
            end
            if waterOpt and waterOpt.getValue then
                waterShut = tostring(waterOpt:getValue())
            end
            elecModifier = sandbox:getElecShutModifier()
            waterModifier = sandbox:getWaterShutModifier()
            timeSinceApo = PanelBridge.tryGet(sandbox, "getTimeSinceApo") or timeSinceApo
        end

        local gameTime = GameTime.getInstance()
        if gameTime then
            currentHour = gameTime:getWorldAgeHours()
            currentDay = currentHour / 24
            nightsSurvived = gameTime:getNightsSurvived()
        end

        local worldAgeDays = currentHour / 24 + (timeSinceApo - 1) * 30

        if elecModifier > -1 and worldAgeDays < elecModifier then
            powerActuallyOn = true
        end

        if waterModifier > -1 and worldAgeDays < waterModifier then
            waterActuallyOn = true
        end
    end)

    return true, {
        hydroPowerOn = hydroPowerOn,
        powerOn = powerActuallyOn,
        waterOn = waterActuallyOn,
        currentWorldHour = currentHour,
        currentWorldDay = currentDay,
        nightsSurvived = nightsSurvived,
        timeSinceApo = timeSinceApo,
        elecShut = elecShut,
        waterShut = waterShut,
        elecShutModifier = elecModifier,
        waterShutModifier = waterModifier
    }
end

local function setElectricityOnLoadedSquares(enabled)
    local cell = getCell()
    if not cell then
        return 0, "No cell available"
    end

    local players = getOnlinePlayers()
    if not players or players:size() == 0 then
        return 0, "No players online"
    end

    local squareCount = 0

    for p = 0, players:size() - 1 do
        local player = players:get(p)
        if player then
            local px, py = math.floor(player:getX()), math.floor(player:getY())

            for x = px - 50, px + 50 do
                for y = py - 50, py + 50 do
                    for z = 0, 3 do
                        local sq = cell:getGridSquare(x, y, z)
                        if sq then
                            pcall(function()
                                sq:setHaveElectricity(enabled)
                            end)
                            squareCount = squareCount + 1
                        end
                    end
                end
            end
        end
    end

    return squareCount, "success"
end

function PanelBridge.reconcileStartupPower()
    local world = getWorld()
    local sandbox = getSandboxOptions()
    local gameTime = getGameTime()
    if not world or not sandbox or not gameTime then return false end

    local shutdownDay = tonumber(PanelBridge.tryGet(sandbox, "getElecShutModifier"))
    local worldAgeHours = tonumber(PanelBridge.tryGet(gameTime, "getWorldAgeHours")) or 0
    local timeSinceApo = tonumber(PanelBridge.tryGet(sandbox, "getTimeSinceApo")) or 1
    local worldAgeDays = worldAgeHours / 24 + (timeSinceApo - 1) * 30
    if not shutdownDay or shutdownDay < 0 or worldAgeDays >= shutdownDay then
        return false
    end

    if PanelBridge.tryGet(world, "isHydroPowerOn") ~= false then return false end
    if not PanelBridge.invoke(world, "setHydroPowerOn", true) then return false end
    if PanelBridge.tryGet(world, "isHydroPowerOn") ~= true then return false end

    setElectricityOnLoadedSquares(true)
    PanelBridge.invoke(world, "transmitWeather")
    return true
end

local function setLightSwitchState(obj, enabled)
    local state = PanelBridge.tryGet(obj, "isActivated")
    if state == enabled then return true, false end
    if not PanelBridge.invoke(obj, "toggle") then
        if not PanelBridge.invoke(obj, "setActive", enabled) then
            return false, false
        end
    end
    return PanelBridge.tryGet(obj, "isActivated") == enabled, true
end

local function activateLightSwitchesInLoadedChunks()
    local cell = getCell()
    if not cell then
        return 0, "No cell available"
    end

    local activatedCount = 0

    local players = getOnlinePlayers()
    if not players or players:size() == 0 then
        return 0, "No players online"
    end

    for p = 0, players:size() - 1 do
        local player = players:get(p)
        if player then
            local px, py = math.floor(player:getX()), math.floor(player:getY())

            for x = px - 30, px + 30 do
                for y = py - 30, py + 30 do
                    for z = 0, 3 do
                        local sq = cell:getGridSquare(x, y, z)
                        if sq then
                            local objects = sq:getObjects()
                            if objects then
                                for i = 0, objects:size() - 1 do
                                    local obj = objects:get(i)
                                    if obj and instanceof(obj, "IsoLightSwitch") then
                                        local success, toggleErr = pcall(function()
                                            if setLightSwitchState(obj, true) then
                                                activatedCount = activatedCount + 1
                                            end
                                        end)
                                    end
                                end
                            end
                        end
                    end
                end
            end
        end
    end

    return activatedCount, "success"
end

local function deactivateLightSwitchesInLoadedChunks()
    local cell = getCell()
    if not cell then
        return 0, "No cell available"
    end

    local deactivatedCount = 0

    local players = getOnlinePlayers()
    if not players or players:size() == 0 then
        return 0, "No players online"
    end

    for p = 0, players:size() - 1 do
        local player = players:get(p)
        if player then
            local px, py = math.floor(player:getX()), math.floor(player:getY())

            for x = px - 30, px + 30 do
                for y = py - 30, py + 30 do
                    for z = 0, 3 do
                        local sq = cell:getGridSquare(x, y, z)
                        if sq then
                            PanelBridge.invoke(sq, "switchLight", false)

                            local objects = sq:getObjects()
                            if objects then
                                for i = 0, objects:size() - 1 do
                                    local obj = objects:get(i)
                                    if obj and instanceof(obj, "IsoLightSwitch") then
                                        local success, err = pcall(function()
                                            local inState, changed = setLightSwitchState(obj, false)
                                            if inState and changed then
                                                deactivatedCount = deactivatedCount + 1
                                            end
                                        end)
                                    end
                                end
                            end
                        end
                    end
                end
            end
        end
    end

    return deactivatedCount, "success"
end

PanelBridge.activeJob = nil
local JOB_UNITS_PER_TICK = 1500

function PanelBridge.processActiveJob()
    local job = PanelBridge.activeJob
    if not job then return end

    local phase = job.phases[job.phaseIdx]
    if not phase then
        PanelBridge.activeJob = nil
        local ok, success, data, errMsg = pcall(job.onComplete)
        if not ok then
            PanelBridge.stats.commandsFailed = PanelBridge.stats.commandsFailed + 1
            PanelBridge.error("Background job finalize failed", { error = tostring(success) })
            PanelBridge.sendResult(job.cmdId, false, nil, "Background job finalize failed: " .. tostring(success))
        else
            if success then
                PanelBridge.stats.commandsSucceeded = PanelBridge.stats.commandsSucceeded + 1
            else
                PanelBridge.stats.commandsFailed = PanelBridge.stats.commandsFailed + 1
            end
            PanelBridge.sendResult(job.cmdId, success, data, errMsg)
        end
        return
    end

    job.phaseDone = false
    local ok, err = pcall(phase, job, JOB_UNITS_PER_TICK)
    if not ok then
        PanelBridge.activeJob = nil
        PanelBridge.stats.commandsFailed = PanelBridge.stats.commandsFailed + 1
        PanelBridge.error("Background job step failed", { error = tostring(err) })
        PanelBridge.sendResult(job.cmdId, false, nil, "Background job step failed: " .. tostring(err))
        return
    end
    if job.phaseDone then
        job.phaseIdx = job.phaseIdx + 1
    end
end

local function startBackgroundJob(cmdId, phases, onComplete)
    PanelBridge.activeJob = {
        cmdId = cmdId,
        phases = phases,
        phaseIdx = 1,
        onComplete = onComplete,
    }
end

local function makeSquareScanStepFn(radius, zMax, applyFn)
    local players = getOnlinePlayers()
    local playerCoords = {}
    if players then
        for p = 0, players:size() - 1 do
            local player = players:get(p)
            if player then
                table.insert(playerCoords, { x = math.floor(player:getX()), y = math.floor(player:getY()) })
            end
        end
    end

    local playerIdx = 1
    local xOff, yOff, z = -radius, -radius, 0

    return function(job, budget)
        if #playerCoords == 0 then
            job.phaseDone = true
            return
        end
        local cell = getCell()
        if not cell then
            job.phaseDone = true
            return
        end
        local remaining = budget
        while remaining > 0 and playerIdx <= #playerCoords do
            local pc = playerCoords[playerIdx]
            local sq = cell:getGridSquare(pc.x + xOff, pc.y + yOff, z)
            if sq then
                pcall(applyFn, sq)
            end
            remaining = remaining - 1

            z = z + 1
            if z > zMax then
                z = 0
                yOff = yOff + 1
                if yOff > radius then
                    yOff = -radius
                    xOff = xOff + 1
                    if xOff > radius then
                        xOff = -radius
                        playerIdx = playerIdx + 1
                    end
                end
            end
        end
        if playerIdx > #playerCoords then
            job.phaseDone = true
        end
    end
end

local function makeElectricitySetter(enabled, counter)
    return function(sq)
        sq:setHaveElectricity(enabled)
        counter.n = counter.n + 1
    end
end

local function makeLightSwitchActivator(counter)
    return function(sq)
        local objects = sq:getObjects()
        if not objects then return end
        for i = 0, objects:size() - 1 do
            local obj = objects:get(i)
            if obj and instanceof(obj, "IsoLightSwitch") then
                if setLightSwitchState(obj, true) then
                    counter.n = counter.n + 1
                end
            end
        end
    end
end

local function makeLightSwitchDeactivator(counter)
    return function(sq)
        PanelBridge.invoke(sq, "switchLight", false)
        local objects = sq:getObjects()
        if not objects then return end
        for i = 0, objects:size() - 1 do
            local obj = objects:get(i)
            if obj and instanceof(obj, "IsoLightSwitch") then
                local inState, changed = setLightSwitchState(obj, false)
                if inState and changed then
                    counter.n = counter.n + 1
                end
            end
        end
    end
end

handlers.restoreUtilities = function(args, cmdId)
    local world = getWorld()
    if not world then
        return false, nil, "World not available"
    end

    if cmdId and PanelBridge.activeJob then
        return false, nil, "Another utilities operation is already in progress"
    end

    local restorePower = args.power ~= false
    local restoreWater = args.water ~= false

    local debugInfo = {}

    local success, err = pcall(function()
        local gameTime = GameTime.getInstance()
        local nightsSurvived = 0
        if gameTime then
            nightsSurvived = gameTime:getNightsSurvived()
        end
        table.insert(debugInfo, "nightsSurvived=" .. tostring(nightsSurvived))

        local sandboxOptions = getSandboxOptions()

        local restoreDays = 2147483647
        if restorePower then
            SandboxVars.ElecShut = 9
            SandboxVars.ElecShutModifier = restoreDays
            table.insert(debugInfo, "Lua ElecShut=9(Disabled) ElecShutModifier=" .. tostring(restoreDays))
        end

        if restoreWater then
            SandboxVars.WaterShut = 9
            SandboxVars.WaterShutModifier = restoreDays
            table.insert(debugInfo, "Lua WaterShut=9(Disabled) WaterShutModifier=" .. tostring(restoreDays))
        end

        if sandboxOptions then
            if PanelBridge.invoke(sandboxOptions, "updateFromLua") then
                table.insert(debugInfo, "updateFromLua OK")
            end
            if PanelBridge.invoke(sandboxOptions, "applySettings") then
                table.insert(debugInfo, "applySettings OK")
            end
            table.insert(debugInfo, "Java getElecShutModifier=" .. tostring(sandboxOptions:getElecShutModifier()))
            table.insert(debugInfo, "Java getWaterShutModifier=" .. tostring(sandboxOptions:getWaterShutModifier()))
            if restorePower and sandboxOptions:getElecShutModifier() ~= restoreDays then
                PanelBridge.invoke(sandboxOptions:getOptionByName("ElecShutModifier"), "setValue", restoreDays)
                table.insert(debugInfo, "FORCED Java ElecShutModifier=" .. tostring(restoreDays))
            end
            if restoreWater and sandboxOptions:getWaterShutModifier() ~= restoreDays then
                PanelBridge.invoke(sandboxOptions:getOptionByName("WaterShutModifier"), "setValue", restoreDays)
                table.insert(debugInfo, "FORCED Java WaterShutModifier=" .. tostring(restoreDays))
            end
            if PanelBridge.invoke(sandboxOptions, "applySettings") then
                table.insert(debugInfo, "applySettings(post-force) OK")
            end
            if PanelBridge.invoke(sandboxOptions, "toLua") then
                table.insert(debugInfo, "toLua OK")
            end
        end

        if restorePower then
            world:setHydroPowerOn(true)
            table.insert(debugInfo, "setHydroPowerOn(true)")
        end
    end)

    if not success then
        local hydroPowerOn = nil
        pcall(function() hydroPowerOn = world:isHydroPowerOn() end)
        return false, {
            power = restorePower,
            water = restoreWater,
            hydroPowerOn = hydroPowerOn,
            debug = debugInfo
        }, "Failed to restore utilities: " .. tostring(err)
    end

    local function finishRestoreUtilities()
        pcall(function()
            if executeCommand then
                executeCommand("/reloadoptions")
                table.insert(debugInfo, "executeCommand /reloadoptions OK")
            end
        end)

            if PanelBridge.invoke(world, "transmitWeather") then
                table.insert(debugInfo, "transmitWeather OK")
            end


        table.insert(debugInfo, "FINAL isHydroPowerOn=" .. tostring(world:isHydroPowerOn()))
        table.insert(debugInfo, "FINAL SandboxVars.ElecShutModifier=" .. tostring(SandboxVars.ElecShutModifier))
        table.insert(debugInfo, "FINAL SandboxVars.WaterShutModifier=" .. tostring(SandboxVars.WaterShutModifier))

        print("[PanelBridge] restoreUtilities debug: " .. table.concat(debugInfo, " | "))

        local actualHydroPowerOn = world:isHydroPowerOn()
        local verified = (not restorePower) or actualHydroPowerOn
        local errMsg = nil
        if not verified then
            errMsg = "Power restore did not take effect (hydro power is still off)"
        end
        return verified, {
            message = verified and "Utilities restored" or errMsg,
            power = restorePower,
            water = restoreWater,
            hydroPowerOn = actualHydroPowerOn,
            debug = debugInfo
        }, errMsg
    end

    if not restorePower then
        return finishRestoreUtilities()
    end

    if not cmdId then
        local squareCount = setElectricityOnLoadedSquares(true)
        table.insert(debugInfo, "setHaveElectricity(true) squares=" .. tostring(squareCount))
        local switchesActivated = activateLightSwitchesInLoadedChunks()
        table.insert(debugInfo, "switches=" .. tostring(switchesActivated))
        return finishRestoreUtilities()
    end

    local elecCounter = { n = 0 }
    local switchCounter = { n = 0 }
    startBackgroundJob(cmdId, {
        makeSquareScanStepFn(50, 3, makeElectricitySetter(true, elecCounter)),
        makeSquareScanStepFn(30, 3, makeLightSwitchActivator(switchCounter)),
    }, function()
        table.insert(debugInfo, "setHaveElectricity(true) squares=" .. tostring(elecCounter.n))
        table.insert(debugInfo, "switches=" .. tostring(switchCounter.n))
        return finishRestoreUtilities()
    end)

    return "DEFERRED"
end

handlers.shutOffUtilities = function(args, cmdId)
    local world = getWorld()
    if not world then
        return false, nil, "World not available"
    end

    if cmdId and PanelBridge.activeJob then
        return false, nil, "Another utilities operation is already in progress"
    end

    local shutPower = args.power ~= false
    local shutWater = args.water ~= false

    local debugInfo = {}

    local success, err = pcall(function()
        local gameTime = GameTime.getInstance()
        local nightsSurvived = 0
        if gameTime then
            nightsSurvived = gameTime:getNightsSurvived()
        end
        table.insert(debugInfo, "nightsSurvived=" .. tostring(nightsSurvived))

        if shutPower then
            SandboxVars.ElecShut = 1
            SandboxVars.ElecShutModifier = 0
            table.insert(debugInfo, "Lua ElecShut=1(Instant) ElecShutModifier=0")
        end

        if shutWater then
            SandboxVars.WaterShut = 1
            SandboxVars.WaterShutModifier = 0
            table.insert(debugInfo, "Lua WaterShut=1(Instant) WaterShutModifier=0")
        end

        local sandboxOptions = getSandboxOptions()
        if sandboxOptions then
            PanelBridge.invoke(sandboxOptions, "updateFromLua")
            PanelBridge.invoke(sandboxOptions, "applySettings")
            table.insert(debugInfo, "Java getElecShutModifier=" .. tostring(sandboxOptions:getElecShutModifier()))
            table.insert(debugInfo, "Java getWaterShutModifier=" .. tostring(sandboxOptions:getWaterShutModifier()))
            if shutPower and sandboxOptions:getElecShutModifier() ~= 0 then
                PanelBridge.invoke(sandboxOptions:getOptionByName("ElecShutModifier"), "setValue", 0)
                table.insert(debugInfo, "FORCED Java ElecShutModifier=0")
            end
            if shutWater and sandboxOptions:getWaterShutModifier() ~= 0 then
                PanelBridge.invoke(sandboxOptions:getOptionByName("WaterShutModifier"), "setValue", 0)
                table.insert(debugInfo, "FORCED Java WaterShutModifier=0")
            end
            PanelBridge.invoke(sandboxOptions, "applySettings")
            PanelBridge.invoke(sandboxOptions, "toLua")
            table.insert(debugInfo, "sandbox sync OK")
        end

        if shutPower then
            world:setHydroPowerOn(false)
            table.insert(debugInfo, "setHydroPowerOn(false)")
        end
    end)

    if not success then
        local hydroPowerOn = nil
        pcall(function() hydroPowerOn = world:isHydroPowerOn() end)
        return false, {
            power = shutPower,
            water = shutWater,
            hydroPowerOn = hydroPowerOn,
            debug = debugInfo
        }, "Failed to shut off utilities: " .. tostring(err)
    end

    local function finishShutOffUtilities()
        pcall(function()
            if executeCommand then
                executeCommand("/reloadoptions")
                table.insert(debugInfo, "executeCommand /reloadoptions OK")
            end
        end)

        if PanelBridge.invoke(world, "transmitWeather") then
            table.insert(debugInfo, "transmitWeather OK")
        end


        table.insert(debugInfo, "FINAL isHydroPowerOn=" .. tostring(world:isHydroPowerOn()))

        print("[PanelBridge] shutOffUtilities debug: " .. table.concat(debugInfo, " | "))

        local actualHydroPowerOn = world:isHydroPowerOn()
        local verified = (not shutPower) or (not actualHydroPowerOn)
        local errMsg = nil
        if not verified then
            errMsg = "Power shutoff did not take effect (hydro power is still on)"
        end
        return verified, {
            message = verified and "Utilities shut off" or errMsg,
            power = shutPower,
            water = shutWater,
            hydroPowerOn = actualHydroPowerOn,
            debug = debugInfo
        }, errMsg
    end

    if not shutPower then
        return finishShutOffUtilities()
    end

    if not cmdId then
        local squareCount = setElectricityOnLoadedSquares(false)
        table.insert(debugInfo, "setHaveElectricity(false) squares=" .. tostring(squareCount))
        local switchesDeactivated = deactivateLightSwitchesInLoadedChunks()
        table.insert(debugInfo, "switches deactivated=" .. tostring(switchesDeactivated))
        return finishShutOffUtilities()
    end

    local elecCounter = { n = 0 }
    local switchCounter = { n = 0 }
    startBackgroundJob(cmdId, {
        makeSquareScanStepFn(50, 3, makeElectricitySetter(false, elecCounter)),
        makeSquareScanStepFn(30, 3, makeLightSwitchDeactivator(switchCounter)),
    }, function()
        table.insert(debugInfo, "setHaveElectricity(false) squares=" .. tostring(elecCounter.n))
        table.insert(debugInfo, "switches deactivated=" .. tostring(switchCounter.n))
        return finishShutOffUtilities()
    end)

    return "DEFERRED"
end


handlers.healPlayer = function(args)
    local username = args.username
    if not username then
        return false, nil, "Username required"
    end

    local player = getPlayerByUsername(username)
    if not player then
        return false, nil, "Player not found: " .. username
    end

    local bodyDamage = player:getBodyDamage()
    if not bodyDamage then
        return false, nil, "Could not access player body damage; nothing was healed"
    end

    local healed = {}
    local errors = {}

    local ok1, err1 = pcall(function()
        local bodyParts = bodyDamage:getBodyParts()
        for i = 0, bodyParts:size() - 1 do
            local part = bodyParts:get(i)
            part:RestoreToFullHealth()
            part:SetFakeInfected(false)
            healed.bodyDamage = true
        end
    end)
    if not ok1 then table.insert(errors, "bodyDamage: " .. tostring(err1)) end

    local ok4, err4 = pcall(function()
        local synced = false
        if sendPlayerExtraInfo then
            sendPlayerExtraInfo(player)
            synced = true
            healed.syncMethod = "sendPlayerExtraInfo"
        end
        if syncPlayerFields then
            syncPlayerFields(player)
            synced = true
            healed.syncMethod = (healed.syncMethod or "") .. "+syncPlayerFields"
        end
        healed.networkSync = synced
    end)
    if not ok4 then table.insert(errors, "sync: " .. tostring(err4)) end

    if #errors > 0 then
        healed.errors = errors
    end

    PanelBridge.info("Healed player", { username = username, healed = healed })

    if not ok1 or not healed.bodyDamage then
        local reason = ok1 and "No body parts were healed (empty body part collection)"
            or ("Body healing failed: " .. tostring(err1))
        return false, { username = username, healed = healed }, reason
    end

    return true, { message = "Player healed", username = username, healed = healed }
end

handlers.killPlayer = function(args)
    local username = args.username
    if not username then
        return false, nil, "Username required"
    end

    local player = getPlayerByUsername(username)
    if not player then
        return false, nil, "Player not found: " .. username
    end

    local debugInfo = {}

    if PanelBridge.setCharacterCheatBypassingRoleGate(player, "setGodMod", false) then
        table.insert(debugInfo, "godMod disabled")
    elseif PanelBridge.setCharacterCheatBypassingRoleGate(player, "setGodMode", false) then
        table.insert(debugInfo, "godMode disabled")
    end
    if PanelBridge.invoke(player, "setInvincible", false) then
        table.insert(debugInfo, "invincible disabled")
    end

    if PanelBridge.invoke(player, "Kill", nil) then
        table.insert(debugInfo, "Kill(nil) called")
    end

    pcall(function()
        if sendPlayerExtraInfo then
            sendPlayerExtraInfo(player)
            table.insert(debugInfo, "sendPlayerExtraInfo")
        end
    end)
    pcall(function()
        if sendPlayerDeath then
            sendPlayerDeath(player)
            table.insert(debugInfo, "sendPlayerDeath")
        end
    end)

    local isDead = PanelBridge.tryGet(player, "isDead") == true

    local debugStr = table.concat(debugInfo, " | ")
    PanelBridge.info("Killed player", { username = username, isDead = isDead, debug = debugStr })

    if not isDead then
        return false, {
            username = username,
            isDead = false,
            debug = debugStr
        }, "Kill attempted but player is not dead (Kill(nil) may have had no effect on this build, or the player respawned) -- godmode/invincibility were already disabled by this call and were NOT restored"
    end

    return true, {
        message = "Player killed",
        username = username,
        isDead = true,
        debug = debugStr
    }
end

handlers.setGodMode = function(args)
    local username = args.username
    local enabled = args.enabled == true

    if not username then
        return false, nil, "Username required"
    end

    local player = getPlayerByUsername(username)
    if not player then
        return false, nil, "Player not found: " .. username
    end

    local method = nil
    local success, err
    success, err = PanelBridge.setCharacterCheatBypassingRoleGate(player, "setGodMod", enabled)
    if success then method = "setGodMod" end
    if not success then
        success, err = PanelBridge.setCharacterCheatBypassingRoleGate(player, "setGodMode", enabled)
        if success then method = "setGodMode" end
    end

    if not success then
        return false, nil, "Failed to set godmode: " .. tostring(err or "No godmode method available on player object")
    end

    local godModeState = PanelBridge.tryGet(player, "isGodMod")
    local verified
    if godModeState == nil then
        verified = nil
    elseif godModeState == enabled then
        verified = true
    else
        verified = false
    end

    PanelBridge.info("Set godmode", { username = username, enabled = enabled, method = method, verified = verified })

    return PanelBridge.verifiedResult(verified, {
        message = "Godmode " .. (enabled and "enabled" or "disabled"),
        username = username
    }, "Godmode call succeeded but did not take effect (state is still " .. tostring(godModeState) .. ")")
end

handlers.setInvisible = function(args)
    local username = args.username
    local enabled = args.enabled == true

    if not username then
        return false, nil, "Username required"
    end

    local player = getPlayerByUsername(username)
    if not player then
        return false, nil, "Player not found: " .. username
    end

    local success, err = PanelBridge.setCharacterCheatBypassingRoleGate(player, "setInvisible", enabled)

    if not success then
        return false, nil, "Failed to set invisible: " .. tostring(err)
    end

    local invisibleState = PanelBridge.tryGet(player, "isInvisible")
    local verified
    if invisibleState == nil then
        verified = nil
    elseif invisibleState == enabled then
        verified = true
    else
        verified = false
    end

    PanelBridge.info("Set invisible", { username = username, enabled = enabled, verified = verified })

    return PanelBridge.verifiedResult(verified, {
        message = "Invisibility " .. (enabled and "enabled" or "disabled"),
        username = username
    }, "Invisibility call succeeded but did not take effect (state is still " .. tostring(invisibleState) .. ")")
end

handlers.setNoclip = function(args)
    local username = args.username
    local enabled = args.enabled == true

    if not username then
        return false, nil, "Username required"
    end

    local player = getPlayerByUsername(username)
    if not player then
        return false, nil, "Player not found: " .. username
    end

    local success, err = PanelBridge.setCharacterCheatBypassingRoleGate(player, "setNoClip", enabled)

    if not success then
        return false, nil, "Failed to set noclip: " .. tostring(err)
    end

    local noclipState = PanelBridge.tryGet(player, "isNoClip")
    local verified
    if noclipState == nil then
        verified = nil
    elseif noclipState == enabled then
        verified = true
    else
        verified = false
    end

    PanelBridge.info("Set noclip", { username = username, enabled = enabled, verified = verified })

    return PanelBridge.verifiedResult(verified,
        { message = "Noclip " .. (enabled and "enabled" or "disabled"), username = username },
        "Noclip call succeeded but did not take effect (state is still " .. tostring(noclipState) .. ")")
end

handlers.giveItem = function(args)
    local username = args.username
    local itemType = args.itemType
    local count = math.min(math.max(tonumber(args.count) or 1, 1), 100)

    if not username then
        return false, nil, "Username required"
    end
    if type(itemType) ~= "string" then
        return false, nil, "Item type required (e.g., 'Base.Axe')"
    end
    if not itemType:match("^[%w_]+%.[%w_&%#%+%.%-]+$") then
        return false, nil, "Invalid item type format (expected Module.ItemName): " .. tostring(itemType)
    end

    local player = getPlayerByUsername(username)
    if not player then
        return false, nil, "Player not found: " .. username
    end

    local inventory = PanelBridge.tryGet(player, "getInventory")
    if not inventory then
        return false, nil, "Could not access player inventory"
    end

    local added = 0
    local lastError = nil
    for i = 1, count do
        local ok, item = pcall(function()
            return inventory:AddItem(itemType)
        end)
        if ok and item then
            added = added + 1
        elseif not ok then
            lastError = tostring(item)
        end
    end

    if added == 0 then
        return false, nil, "Failed to add item '" .. itemType .. "'" .. (lastError and (": " .. lastError) or ". Item type may not exist.")
    end

    PanelBridge.invoke(player, "sendObjectChange", "inventory")
    pcall(function()
        if sendPlayerExtraInfo then
            sendPlayerExtraInfo(player)
        end
    end)

    PanelBridge.info("Gave items", { username = username, itemType = itemType, count = added })
    return true, {
        message = "Gave " .. added .. "x " .. itemType,
        username = username,
        itemType = itemType,
        count = added
    }
end


local AIRDROP_PRESETS = {
    military = {
        "Base.AssaultRifle2", "Base.Pistol3", "Base.556Bullets", "Base.9mmClip",
        "Base.Bullets9mmBox", "Base.556Box", "Base.HolsterSimple",
        "Base.Helmet_Army", "Base.Vest_BulletArmy", "Base.MilitaryBoots",
        "Base.WalkieTalkie5", "Base.KnifeHunting"
    },
    medical = {
        "Base.Bandage", "Base.Bandage", "Base.Bandage", "Base.AlcoholBandage",
        "Base.AlcoholBandage", "Base.SutureNeedle", "Base.Antibiotics",
        "Base.Disinfectant", "Base.Pills", "Base.PillsVitamins",
        "Base.FirstAidKit", "Base.Tweezers"
    },
    food = {
        "Base.CannedBeans", "Base.CannedBeans", "Base.CannedChili",
        "Base.CannedCorn", "Base.CannedTomato2", "Base.TunaTin",
        "Base.WaterBottleFull", "Base.WaterBottleFull", "Base.Pop3",
        "Base.CannedSardines", "Base.CannedPeaches", "Base.MRE"
    },
    building = {
        "Base.Plank", "Base.Plank", "Base.Plank", "Base.Plank",
        "Base.Nails", "Base.Nails", "Base.NailsBox",
        "Base.Hammer", "Base.Saw", "Base.Screwdriver",
        "Base.SheetRope", "Base.Axe"
    },
    weapons = {
        "Base.Shotgun", "Base.ShotgunShellsBox", "Base.ShotgunShellsBox",
        "Base.HuntingRifle", "Base.308Box", "Base.Pistol",
        "Base.Bullets9mmBox", "Base.BaseballBat", "Base.Crowbar",
        "Base.Katana", "Base.Machete", "Base.HolsterSimple"
    },
    tools = {
        "Base.Axe", "Base.Hammer", "Base.Saw", "Base.Screwdriver",
        "Base.Wrench", "Base.WeldingRods", "Base.BlowTorch",
        "Base.Crowbar", "Base.HandTorch", "Base.Battery",
        "Base.Rope", "Base.DuctTape"
    }
}

handlers.airdrop = function(args)
    local x = math.floor(tonumber(args.x) or 0)
    local y = math.floor(tonumber(args.y) or 0)
    local z = 0
    local preset = args.preset
    local customItems = args.items
    local announce = args.announce ~= false
    local attractZombies = args.attractZombies ~= false
    local soundRadius = math.min(math.max(tonumber(args.soundRadius) or 150, 10), 500)

    if x < 0 or x > 24000 or y < 0 or y > 24000 then
        return false, nil, "Coordinates out of range (valid: 0 to 24000)"
    end
    if x == 0 and y == 0 then
        return false, nil, "Valid x and y coordinates are required"
    end

    if preset and not AIRDROP_PRESETS[preset] then
        if customItems == nil then
            return false, nil, "Unknown preset '" .. tostring(preset) .. "'. Valid: military, medical, food, building, weapons, tools"
        end
        preset = nil
    end

    local itemsToSpawn = {}
    if customItems and type(customItems) == "table" then
        for _, entry in ipairs(customItems) do
            if entry.itemType and type(entry.itemType) == "string" then
                if not entry.itemType:match("^[%w_]+%.[%w_&%#%+%.%-]+$") then
                    return false, nil, "Invalid item type format: " .. tostring(entry.itemType) .. " (expected Module.ItemName)"
                end
                local count = math.min(math.max(tonumber(entry.count) or 1, 1), 20)
                for i = 1, count do
                    table.insert(itemsToSpawn, entry.itemType)
                end
            end
        end
    elseif preset and AIRDROP_PRESETS[preset] then
        itemsToSpawn = AIRDROP_PRESETS[preset]
    else
        return false, nil, "Either 'preset' (military/medical/food/building/weapons/tools) or 'items' array is required"
    end

    if #itemsToSpawn == 0 then
        return false, nil, "No items to drop"
    end

    if #itemsToSpawn > 50 then
        local clamped = {}
        for i = 1, 50 do
            clamped[i] = itemsToSpawn[i]
        end
        itemsToSpawn = clamped
    end

    local world = getWorld()
    if not world then
        return false, nil, "World not available"
    end

    local cell = world:getCell()
    if not cell then
        return false, nil, "Cell not available"
    end

    local sq = cell:getGridSquare(x, y, z)
    if not sq then
        return false, nil, "Grid square not loaded at " .. x .. "," .. y .. " — a player must be nearby"
    end

    local added = 0
    local attempted = #itemsToSpawn
    local failedTypes = {}
    for _, itemType in ipairs(itemsToSpawn) do
        local ok, result = pcall(function()
            local placedOk, placed = PanelBridge.invoke(sq, "AddWorldInventoryItem", itemType, 0.5, 0.5, 0)
            if placedOk and placed then return placed end
            local item = InventoryItemFactory.CreateItem(itemType)
            if item and PanelBridge.invoke(sq, "AddWorldInventoryItem", item, 0.5, 0.5, 0) then
                return item
            end
            return nil
        end)
        if ok and result then
            added = added + 1
        else
            failedTypes[itemType] = true
        end
    end

    if added == 0 then
        return false, nil, "Failed to spawn any items (" .. attempted .. " attempted). The area may not be loaded or item types may be invalid."
    end

    if attractZombies then
        pcall(function()
            addSound(nil, x, y, z, soundRadius, 200)
        end)
    end

    if announce then
        pcall(function()
            local presetName = preset and (preset:sub(1,1):upper() .. preset:sub(2)) or "Custom"
            local msg = "[AIRDROP] " .. presetName .. " supply drop at coordinates " .. x .. ", " .. y .. "!"
            if sendServerMessage then
                sendServerMessage(msg)
            end
        end)
    end

    PanelBridge.info("Airdrop deployed", { x = x, y = y, preset = preset, itemCount = added, attempted = attempted })
    local failedCount = attempted - added
    local failedList = {}
    for typeName, _ in pairs(failedTypes) do
        table.insert(failedList, typeName)
    end
    return true, {
        message = "Airdrop deployed: " .. added .. "/" .. attempted .. " items at " .. x .. ", " .. y,
        x = x,
        y = y,
        itemCount = added,
        attempted = attempted,
        failed = failedCount,
        failedTypes = #failedList > 0 and failedList or nil,
        preset = preset or "custom"
    }
end


handlers.getZombieCount = function(args)
    local world = getWorld()
    if not world then
        return false, nil, "World not available"
    end

    local cell = world:getCell()
    if not cell then
        return false, nil, "Cell not available"
    end

    local zombieCount = 0
    local ok, list = pcall(function()
        return cell:getZombieList()
    end)

    if ok and list then
        zombieCount = list:size()
    end

    return true, {
        zombieCount = zombieCount,
        note = "Count is for currently loaded cells only"
    }
end

handlers.clearZombiesNearPlayer = function(args)
    local username = args.username
    local radius = tonumber(args.radius) or 50

    if not username then
        return false, nil, "Username required"
    end

    local player = getPlayerByUsername(username)
    if not player then
        return false, nil, "Player not found: " .. username
    end

    local px, py, pz = player:getX(), player:getY(), player:getZ()
    local world = getWorld()
    local cell = world and world:getCell()

    if not cell then
        return false, nil, "Could not access world cell"
    end

    local removed = 0
    local ok, err = pcall(function()
        local zombies = cell:getZombieList()
        if zombies then
            for i = zombies:size() - 1, 0, -1 do
                local zombie = zombies:get(i)
                if zombie then
                    pcall(function()
                        local zx, zy, zz = zombie:getX(), zombie:getY(), zombie:getZ()
                        if zx and zy and zz then
                            local dist = math.sqrt((zx - px)^2 + (zy - py)^2 + (zz - pz)^2)
                            if dist <= radius then
                                zombie:removeFromSquare()
                                zombie:removeFromWorld()
                                removed = removed + 1
                            end
                        end
                    end)
                end
            end
        end
    end)

    if not ok then
        PanelBridge.warn("Error clearing zombies", { error = tostring(err) })
    end

    PanelBridge.info("Cleared zombies", { username = username, radius = radius, removed = removed })
    return true, {
        message = "Removed " .. removed .. " zombies",
        radius = radius,
        removed = removed
    }
end

handlers.clearAllZombies = function(args)
    local world = getWorld()
    if not world then
        return false, nil, "World not available"
    end

    local removed = 0
    local usedForceKill = PanelBridge.invoke(world, "ForceKillAllZombies") and true or false

    if not usedForceKill then
        local cell = world:getCell()
        if not cell then
            return false, nil, "Could not access world cell"
        end
        local ok, err = pcall(function()
            local zombies = cell:getZombieList()
            if zombies then
                for i = zombies:size() - 1, 0, -1 do
                    local zombie = zombies:get(i)
                    if zombie then
                        pcall(function()
                            zombie:removeFromSquare()
                            zombie:removeFromWorld()
                            removed = removed + 1
                        end)
                    end
                end
            end
        end)
        if not ok then
            PanelBridge.warn("Error clearing zombies manually", { error = tostring(err) })
        end
    end

    PanelBridge.warn("Cleared zombies", { usedForceKill = usedForceKill, manualRemoved = removed })
    return true, {
        message = usedForceKill and "Force-killed all zombies" or ("Removed " .. removed .. " zombies from loaded cells"),
        removed = removed,
        usedForceKill = usedForceKill
    }
end

local function getZombiePopManager()
    local ZPM = resolveJavaClass("ZombiePopulationManager", "zombie.popman.ZombiePopulationManager")
    if ZPM and ZPM.instance then
        return ZPM.instance
    end
    return nil
end

handlers.spawnHordeNearPlayer = function(args)
    local username = args.username
    local count = math.floor(tonumber(args.count) or 50)
    count = math.min(math.max(count, 1), 500)

    if not username then
        return false, nil, "Username required"
    end

    local player = getPlayerByUsername(username)
    if not player then
        return false, nil, "Player not found: " .. username
    end

    local px, py, pz = player:getX(), player:getY(), player:getZ()

    local angle = ZombRand(360) * math.pi / 180
    local dist = 15 + ZombRand(11)
    local cx = math.floor(px + math.cos(angle) * dist)
    local cy = math.floor(py + math.sin(angle) * dist)
    local half = 8
    local method = "unknown"
    local spawned = 0
    local verified = false

    local ok, err = pcall(function()
        local vzm = _G.VirtualZombieManager and _G.VirtualZombieManager.instance
        if vzm and vzm.createRealZombieNow then
            for i = 1, count do
                local dx = ZombRand(half * 2 + 1) - half
                local dy = ZombRand(half * 2 + 1) - half
                local tx = cx + dx
                local ty = cy + dy
                local okZ, zombie = pcall(function()
                    return vzm:createRealZombieNow(tx, ty, pz)
                end)
                if okZ and zombie then spawned = spawned + 1 end
            end
            method = "VirtualZombieManager.createRealZombieNow"
            verified = true
        else
            local zpop = getZombiePopManager()
            if zpop and zpop.createHordeInAreaTo then
                zpop:createHordeInAreaTo(cx - half, cy - half, half * 2, half * 2, math.floor(px), math.floor(py), count)
                method = "createHordeInAreaTo"
                spawned = nil
            elseif zpop and zpop.createHordeFromTo then
                zpop:createHordeFromTo(cx, cy, math.floor(px), math.floor(py), count)
                method = "createHordeFromTo"
                spawned = nil
            else
                local world = getWorld()
                if world and world.CreateSwarm then
                    world:CreateSwarm(count, cx - half, cy - half, cx + half, cy + half)
                    method = "CreateSwarm"
                    spawned = nil
                else
                    error("No zombie spawning API available (VirtualZombieManager / ZombiePopulationManager / IsoWorld.CreateSwarm all missing)")
                end
            end
        end
    end)

    if not ok then
        return false, nil, "Failed to spawn horde: " .. tostring(err)
    end

    local verifiedStr = "unverifiable"
    if verified == true then verifiedStr = "confirmed" end

    if verified == true and spawned == 0 then
        PanelBridge.warn("Horde spawn created no zombies", { username = username, count = count, spawned = spawned, verified = verified, cx = cx, cy = cy, method = method })
        return false, nil, "Failed to spawn horde: no zombies were created (0/" .. count .. "); the target area may not be loaded or available"
    end

    PanelBridge.warn("Spawned horde near player", { username = username, count = count, spawned = spawned, verified = verified, cx = cx, cy = cy, method = method })

    return true, {
        message = verified
            and ("Spawned " .. spawned .. "/" .. count .. " zombies near " .. username)
            or ("Requested " .. count .. " zombies near " .. username .. " via " .. method .. " (spawn count not verifiable for this method)"),
        count = count,
        spawned = spawned,
        verified = verifiedStr,
        center = { x = cx, y = cy },
        distance = dist,
        method = method
    }
end

handlers.spawnHordeBehindPlayer = function(args)
    local username = args.username
    local count = math.floor(tonumber(args.count) or 50)
    count = math.min(math.max(count, 1), 500)

    if not username then
        return false, nil, "Username required"
    end

    local player = getPlayerByUsername(username)
    if not player then
        return false, nil, "Player not found: " .. username
    end

    local px, py = player:getX(), player:getY()
    local pz = player:getZ()

    local dir = player:getDir()
    local behindX, behindY
    if     dir == IsoDirections.N  then behindX, behindY =  0,  1
    elseif dir == IsoDirections.NE then behindX, behindY = -1,  1
    elseif dir == IsoDirections.E  then behindX, behindY = -1,  0
    elseif dir == IsoDirections.SE then behindX, behindY = -1, -1
    elseif dir == IsoDirections.S  then behindX, behindY =  0, -1
    elseif dir == IsoDirections.SW then behindX, behindY =  1, -1
    elseif dir == IsoDirections.W  then behindX, behindY =  1,  0
    elseif dir == IsoDirections.NW then behindX, behindY =  1,  1
    else   behindX, behindY =  0,  1
    end
    local dirName = "unknown"
    if dir then
        local ok, name = pcall(function() return dir:toString() end)
        if ok and name then dirName = name end
    end

    local dist = 15 + ZombRand(11)
    local cx = math.floor(px + behindX * dist)
    local cy = math.floor(py + behindY * dist)
    local half = 8
    local method = "unknown"
    local spawned = 0
    local verified = false

    local ok, err = pcall(function()
        local vzm = _G.VirtualZombieManager and _G.VirtualZombieManager.instance
        if vzm and vzm.createRealZombieNow then
            for i = 1, count do
                local dx = ZombRand(half * 2 + 1) - half
                local dy = ZombRand(half * 2 + 1) - half
                local tx = cx + dx
                local ty = cy + dy
                local okZ, zombie = pcall(function()
                    return vzm:createRealZombieNow(tx, ty, pz)
                end)
                if okZ and zombie then spawned = spawned + 1 end
            end
            method = "VirtualZombieManager.createRealZombieNow"
            verified = true
        else
            local zpop = getZombiePopManager()
            if zpop and zpop.createHordeInAreaTo then
                zpop:createHordeInAreaTo(cx - half, cy - half, half * 2, half * 2, math.floor(px), math.floor(py), count)
                method = "createHordeInAreaTo"
                spawned = nil
            elseif zpop and zpop.createHordeFromTo then
                zpop:createHordeFromTo(cx, cy, math.floor(px), math.floor(py), count)
                method = "createHordeFromTo"
                spawned = nil
            else
                local world = getWorld()
                if world and world.CreateSwarm then
                    world:CreateSwarm(count, cx - half, cy - half, cx + half, cy + half)
                    method = "CreateSwarm"
                    spawned = nil
                else
                    error("No zombie spawning API available")
                end
            end
        end
    end)

    if not ok then
        return false, nil, "Failed to spawn horde behind: " .. tostring(err)
    end

    local verifiedStr = "unverifiable"
    if verified == true then verifiedStr = "confirmed" end

    if verified == true and spawned == 0 then
        PanelBridge.warn("Horde spawn created no zombies", { username = username, count = count, spawned = spawned, verified = verified, direction = dirName, cx = cx, cy = cy, method = method })
        return false, nil, "Failed to spawn horde behind: no zombies were created (0/" .. count .. "); the target area may not be loaded or available"
    end

    PanelBridge.warn("Spawned horde behind player", { username = username, count = count, spawned = spawned, verified = verified, direction = dirName, cx = cx, cy = cy, method = method })

    return true, {
        message = verified
            and ("Spawned " .. spawned .. "/" .. count .. " zombies behind " .. username)
            or ("Requested " .. count .. " zombies behind " .. username .. " via " .. method .. " (spawn count not verifiable for this method)"),
        count = count,
        spawned = spawned,
        verified = verifiedStr,
        center = { x = cx, y = cy },
        playerDirection = dirName,
        distance = dist,
        method = method
    }
end


local function findSafehouseByRef(ref)
    if not ref then return nil, "safehouseRef required" end
    if not SafeHouse or not SafeHouse.getSafehouseList then
        return nil, "SafeHouse API not available"
    end

    local list = SafeHouse.getSafehouseList()
    if not list then return nil, "No safehouses found" end

    local refStr = tostring(ref)
    for i = 0, list:size() - 1 do
        local sh = list:get(i)
        if sh then
            local idOk, sid = pcall(function() return sh:getId() end)
            local titleOk, title = pcall(function() return sh:getTitle() end)
            if not idOk then sid = nil end
            if not titleOk then title = nil end
            if tostring(sid) == refStr or tostring(title) == refStr then
                return sh
            end
        end
    end

    return nil, "Safehouse not found: " .. refStr
end

handlers.getSafehouses = function(args)
    if not SafeHouse or not SafeHouse.getSafehouseList then
        return false, nil, "SafeHouse API not available"
    end

    local list = SafeHouse.getSafehouseList()
    local out = {}
    if list then
        for i = 0, list:size() - 1 do
            local sh = list:get(i)
            if sh then
                local players = {}
                pcall(function()
                    local pList = sh:getPlayers()
                    if pList then
                        for j = 0, pList:size() - 1 do
                            table.insert(players, tostring(pList:get(j)))
                        end
                    end
                end)

                table.insert(out, {
                    id = safeGetValue(sh, "getId", nil),
                    title = safeGetValue(sh, "getTitle", nil),
                    owner = safeGetValue(sh, "getOwner", nil),
                    x = safeGetValue(sh, "getX", nil),
                    y = safeGetValue(sh, "getY", nil),
                    w = safeGetValue(sh, "getW", nil),
                    h = safeGetValue(sh, "getH", nil),
                    players = players,
                    playerConnected = safeGetValue(sh, "getPlayerConnected", 0),
                    lastVisited = safeGetValue(sh, "getLastVisited", nil)
                })
            end
        end
    end

    return true, { safehouses = out, count = #out }
end

handlers.safehouseAddPlayer = function(args)
    local sh, err = findSafehouseByRef(args.safehouseRef)
    if not sh then return false, nil, err end

    local username = normalizeMessage(args.username, 64)
    if not username then return false, nil, "Username required" end

    local ok, addErr = pcall(function()
        sh:addPlayer(username)
    end)
    if not ok then
        return false, nil, "Failed to add player to safehouse: " .. tostring(addErr)
    end

    local verified
    local ok2, players = pcall(function() return sh:getPlayers() end)
    if ok2 and players then
        local found = false
        local ok3 = pcall(function()
            for i = 0, players:size() - 1 do
                if tostring(players:get(i)) == username then
                    found = true
                    break
                end
            end
        end)
        if ok3 then verified = found end
    end

    return PanelBridge.verifiedResult(verified,
        { message = "Player added to safehouse", safehouseRef = args.safehouseRef, username = username },
        "Add player call succeeded but " .. username .. " is not in the safehouse player list")
end

handlers.safehouseRemovePlayer = function(args)
    local sh, err = findSafehouseByRef(args.safehouseRef)
    if not sh then return false, nil, err end

    local username = normalizeMessage(args.username, 64)
    if not username then return false, nil, "Username required" end

    local ok, removeErr = pcall(function()
        sh:removePlayer(username)
    end)
    if not ok then
        return false, nil, "Failed to remove player from safehouse: " .. tostring(removeErr)
    end

    local verified
    local ok2, players = pcall(function() return sh:getPlayers() end)
    if ok2 and players then
        local found = false
        local ok3 = pcall(function()
            for i = 0, players:size() - 1 do
                if tostring(players:get(i)) == username then
                    found = true
                    break
                end
            end
        end)
        if ok3 then verified = not found end
    end

    return PanelBridge.verifiedResult(verified,
        { message = "Player removed from safehouse", safehouseRef = args.safehouseRef, username = username },
        "Remove player call succeeded but " .. username .. " is still in the safehouse player list")
end

handlers.safehouseSetOwner = function(args)
    local sh, err = findSafehouseByRef(args.safehouseRef)
    if not sh then return false, nil, err end

    local owner = normalizeMessage(args.owner, 64)
    if not owner then return false, nil, "Owner username required" end

    local ok, setErr = pcall(function()
        sh:setOwner(owner)
    end)
    if not ok then
        return false, nil, "Failed to set safehouse owner: " .. tostring(setErr)
    end

    local ok2, actualOwner = pcall(function() return sh:getOwner() end)
    local verified
    if not ok2 then
        verified = nil
    elseif actualOwner == owner then
        verified = true
    else
        verified = false
    end

    return PanelBridge.verifiedResult(verified,
        { message = "Safehouse owner updated", safehouseRef = args.safehouseRef, owner = owner },
        "Set owner call succeeded but safehouse owner is still " .. tostring(actualOwner))
end

handlers.safehouseSetRespawn = function(args)
    local sh, err = findSafehouseByRef(args.safehouseRef)
    if not sh then return false, nil, err end

    local username = normalizeMessage(args.username, 64)
    if not username then return false, nil, "Username required" end
    local enabled = args.enabled == true

    local ok, setErr = pcall(function()
        sh:setRespawnInSafehouse(enabled, username)
    end)
    if not ok then
        return false, nil, "Failed to set safehouse respawn: " .. tostring(setErr)
    end

    local ok2, actualRespawn = pcall(function() return sh:isRespawnInSafehouse(username) end)
    local verified
    if not ok2 then
        verified = nil
    elseif actualRespawn == enabled then
        verified = true
    else
        verified = false
    end

    return PanelBridge.verifiedResult(verified, {
        message = "Safehouse respawn updated",
        safehouseRef = args.safehouseRef,
        username = username,
        enabled = enabled
    }, "Set respawn call succeeded but did not take effect (still " .. tostring(actualRespawn) .. ")")
end


handlers.getFactions = function(args)
    if not Faction or not Faction.getFactions then
        return false, nil, "Faction API not available"
    end

    local factions = Faction.getFactions()
    local out = {}
    if factions then
        for i = 0, factions:size() - 1 do
            local f = factions:get(i)
            if f then
                local players = {}
                local playersOk, fPlayers = pcall(function() return f:getPlayers() end)
                if not playersOk then fPlayers = nil end
                if fPlayers then
                    for j = 0, fPlayers:size() - 1 do
                        table.insert(players, tostring(fPlayers:get(j)))
                    end
                end
                table.insert(out, {
                    name = safeGetValue(f, "getName", nil),
                    owner = safeGetValue(f, "getOwner", nil),
                    tag = safeGetValue(f, "getTag", nil),
                    players = players,
                    playerCount = #players
                })
            end
        end
    end

    return true, { factions = out, count = #out }
end

handlers.createFaction = function(args)
    if not Faction or not Faction.createFaction then
        return false, nil, "Faction API not available"
    end

    local name = normalizeMessage(args.name, 64)
    local owner = normalizeMessage(args.owner, 64)
    if not name then return false, nil, "Faction name required" end
    if not owner then return false, nil, "Faction owner required" end

    if Faction.factionExist and Faction.factionExist(name) then
        return false, nil, "A faction named '" .. name .. "' already exists"
    end

    if Faction.isAlreadyInFaction then
        local alreadyIn = false
        local okChk, _ = pcall(function() alreadyIn = Faction.isAlreadyInFaction(owner) end)
        if okChk and alreadyIn then
            local existingName = ""
            pcall(function()
                local f = Faction.getPlayerFaction(owner)
                if f then existingName = " (" .. tostring(f:getName()) .. ")" end
            end)
            return false, nil, "Owner '" .. owner .. "' is already in a faction" .. existingName
        end
    end

    local ok, factionOrErr = pcall(function()
        return Faction.createFaction(name, owner)
    end)
    if not ok then
        return false, nil, "Failed to create faction: " .. tostring(factionOrErr)
    end

    if not factionOrErr then
        return false, nil, "Faction creation failed (name may be taken or owner ineligible)"
    end

    PanelBridge.invoke(factionOrErr, "syncFaction")

    return true, { message = "Faction '" .. name .. "' created with owner '" .. owner .. "'", name = name, owner = owner }
end

handlers.factionAddPlayer = function(args)
    if not Faction or not Faction.getFaction then
        return false, nil, "Faction API not available"
    end

    local factionName = normalizeMessage(args.factionName, 64)
    local username = normalizeMessage(args.username, 64)
    if not factionName then return false, nil, "factionName required" end
    if not username then return false, nil, "username required" end

    local faction = Faction.getFaction(factionName)
    if not faction then return false, nil, "Faction not found: " .. factionName end

    local ok, err = pcall(function()
        faction:addPlayer(username)
    end)
    if not ok then
        return false, nil, "Failed to add player to faction: " .. tostring(err)
    end

    local ok2, isMemberNow = pcall(function() return faction:isMember(username) end)
    local verified
    if not ok2 then
        verified = nil
    else
        verified = (isMemberNow == true)
    end

    local data = {
        message = "Player added to faction (applied server-side only -- not pushed to already-connected clients; they will see it on reconnect)",
        factionName = factionName,
        username = username,
        synced = false
    }
    return PanelBridge.verifiedResult(verified, data,
        "Add player call succeeded but " .. username .. " is not a faction member")
end

handlers.factionRemovePlayer = function(args)
    if not Faction or not Faction.getFaction then
        return false, nil, "Faction API not available"
    end

    local factionName = normalizeMessage(args.factionName, 64)
    local username = normalizeMessage(args.username, 64)
    if not factionName then return false, nil, "factionName required" end
    if not username then return false, nil, "username required" end

    local faction = Faction.getFaction(factionName)
    if not faction then return false, nil, "Faction not found: " .. factionName end

    local ok, err = pcall(function()
        faction:removePlayer(username)
    end)
    if not ok then
        return false, nil, "Failed to remove player from faction: " .. tostring(err)
    end

    local ok2, isMemberNow = pcall(function() return faction:isMember(username) end)
    local verified
    if not ok2 then
        verified = nil
    else
        verified = (isMemberNow == false)
    end

    local data = {
        message = "Player removed from faction (applied server-side only -- not pushed to already-connected clients; they will see it on reconnect)",
        factionName = factionName,
        username = username,
        synced = false
    }
    return PanelBridge.verifiedResult(verified, data,
        "Remove player call succeeded but " .. username .. " is still a faction member")
end

handlers.factionSetTag = function(args)
    if not Faction or not Faction.getFaction then
        return false, nil, "Faction API not available"
    end

    local factionName = normalizeMessage(args.factionName, 64)
    local tag = normalizeMessage(args.tag, 8)
    if not factionName then return false, nil, "factionName required" end
    if not tag then return false, nil, "tag required" end

    local faction = Faction.getFaction(factionName)
    if not faction then return false, nil, "Faction not found: " .. factionName end

    local ok, err = pcall(function()
        faction:setTag(tag)
    end)
    if not ok then
        return false, nil, "Failed to set faction tag: " .. tostring(err)
    end

    local ok2, actualTag = pcall(function() return faction:getTag() end)
    local verified
    if not ok2 then
        verified = nil
    elseif actualTag == tag then
        verified = true
    else
        verified = false
    end

    local data = {
        message = "Faction tag updated (applied server-side only -- not pushed to already-connected clients; they will see it on reconnect)",
        factionName = factionName,
        tag = tag,
        synced = false
    }
    return PanelBridge.verifiedResult(verified, data,
        "Set tag call succeeded but faction tag is still " .. tostring(actualTag))
end

handlers.removeFaction = function(args)
    if not Faction or not Faction.getFaction then
        return false, nil, "Faction API not available"
    end

    local factionName = normalizeMessage(args.factionName, 64)
    if not factionName then return false, nil, "factionName required" end

    local faction = Faction.getFaction(factionName)
    if not faction then return false, nil, "Faction not found: " .. factionName end

    local ok, err = pcall(function()
        faction:removeFaction()
    end)
    if not ok then
        return false, nil, "Failed to remove faction: " .. tostring(err)
    end

    return true, { message = "Faction removed", factionName = factionName }
end


local function getVehiclesList()
    local world = getWorld()
    if not world then return nil end
    local cellOk, cell = PanelBridge.invoke(world, "getCell")
    if not cellOk or not cell then return nil end
    local listOk, vehicles = PanelBridge.invoke(cell, "getVehicles")
    if not listOk then return nil end
    return vehicles
end

local function vehicleCount(vehicles)
    local ok, size = PanelBridge.invoke(vehicles, "size")
    if not ok then return nil end
    return tonumber(size)
end

local function vehicleAt(vehicles, i)
    local ok, v = PanelBridge.invoke(vehicles, "get", i)
    if ok then return v end
    return nil
end

local function collectVehicles(vehicles)
    local size = vehicleCount(vehicles)
    if not size then return nil, "Vehicle list size lookup failed" end
    if size == 0 then return {}, nil end

    local out = {}
    for i = 0, size - 1 do
        local v = vehicleAt(vehicles, i)
        if v then table.insert(out, v) end
    end
    if #out > 0 then return out, nil end

    local iterOk, iterator = PanelBridge.invoke(vehicles, "iterator")
    if iterOk and iterator then
        while true do
            local hasNextOk, hasNext = PanelBridge.invoke(iterator, "hasNext")
            if not hasNextOk or not hasNext then break end
            local nextOk, item = PanelBridge.invoke(iterator, "next")
            if not nextOk or not item then break end
            table.insert(out, item)
        end
    end
    if #out > 0 then return out, nil end

    return nil, "size() reported " .. size ..
        " vehicle(s) but neither get(i) nor iterator() could read any of them " ..
        "-- this build's vehicle-list object exposes neither access pattern this bridge knows"
end

local function vehicleGet(v, methodName)
    local ok, value = PanelBridge.invoke(v, methodName)
    if ok then return value end
    return nil
end

local function vehicleParts(vehicle)
    return PanelBridge.tryGet(vehicle, "getParts")
end

local function findVehicleById(vehicleId)
    local vehicles = getVehiclesList()
    if not vehicles then return nil, "Vehicle list not available" end

    local targetId = tonumber(vehicleId)
    if not targetId then return nil, "Invalid vehicle id" end

    local list, collectErr = collectVehicles(vehicles)
    if not list then return nil, collectErr end

    for _, v in ipairs(list) do
        local idOk, id = PanelBridge.invoke(v, "getId")
        if idOk and tonumber(id) == targetId then
            return v
        end
    end
    return nil, "Vehicle not found: " .. tostring(vehicleId)
end

handlers.getVehiclesDetailed = function(args)
    local listOk, vehicles = pcall(getVehiclesList)
    if not listOk then
        return false, nil, "Vehicle list lookup failed: " .. tostring(vehicles)
    end
    if not vehicles then
        return false, nil, "Vehicle list not available"
    end

    local list, collectErr = collectVehicles(vehicles)
    if not list then
        return false, nil, "Vehicle list lookup failed: " .. collectErr
    end

    local out = {}
    local skipped = 0
    for _, v in ipairs(list) do
        local ok, entry = pcall(function()
            local function get(methodName)
                return vehicleGet(v, methodName)
            end
            local sirenModeObj = PanelBridge.tryGet(v, "getLightbarSirenModeObject")
            local sirenLevel = tonumber(PanelBridge.tryGet(sirenModeObj, "get")) or 0
            local parts = vehicleParts(v)
            return {
                id = get("getId"),
                x = get("getX"),
                y = get("getY"),
                z = get("getZ"),
                scriptName = get("getScriptName"),
                type = get("getVehicleType"),
                speedKmh = get("getCurrentSpeedKmHour") or 0,
                batteryCharge = parts and PanelBridge.tryGet(parts, "getBatteryCharge") or nil,
                fuelPct = get("getRemainingFuelPercentage"),
                alarmed = get("isAlarmed") == true,
                sirening = sirenLevel > 0,
                trunkLocked = get("isTrunkLocked") == true
            }
        end)
        if ok and entry then
            table.insert(out, entry)
        else
            skipped = skipped + 1
        end
    end

    return true, { vehicles = out, count = #out, skipped = skipped }
end

handlers.vehicleRepair = function(args)
    local vehicle, findErr = findVehicleById(args.vehicleId)
    if not vehicle then return false, nil, findErr or "Vehicle not found" end

    local ok, repairedOrErr = pcall(function()
        local parts = vehicleParts(vehicle)
        if not parts then
            error("Vehicle has no accessible parts container (getParts() returned nothing on this build)")
        end
        local partCount = tonumber(PanelBridge.tryGet(parts, "getPartCount")) or 0
        local repaired = 0
        for i = 0, partCount - 1 do
            local part = PanelBridge.tryGet(parts, "getPartByIndex", i)
            if part then
                local item = PanelBridge.tryGet(part, "getInventoryItem")
                local condition = (item and tonumber(PanelBridge.tryGet(item, "getConditionMax"))) or 100
                if PanelBridge.invoke(part, "setCondition", condition) then
                    if item then
                        PanelBridge.invoke(item, "setCondition", condition)
                        PanelBridge.invoke(part, "doInventoryItemStats", item,
                            PanelBridge.tryGet(part, "getMechanicSkillInstaller"))
                    end
                    PanelBridge.invoke(vehicle, "transmitPartCondition", part)
                    if item then PanelBridge.invoke(vehicle, "transmitPartItem", part) end
                    PanelBridge.invoke(vehicle, "transmitPartModData", part)
                    repaired = repaired + 1
                end
            end
        end
        if repaired == 0 then
            if partCount == 0 then
                error("This vehicle reports 0 parts -- nothing to repair")
            else
                error("Found " .. partCount .. " part(s) but none accepted a repaired condition (setCondition failed on all of them)")
            end
        end
        PanelBridge.invoke(vehicle, "updatePartStats")
        PanelBridge.invoke(vehicle, "updateBulletStats")
        return repaired
    end)
    if not ok then return false, nil, "Vehicle repair failed: " .. tostring(repairedOrErr) end

    return true, { message = "Vehicle repaired", vehicleId = tonumber(args.vehicleId), parts = repairedOrErr }
end

handlers.vehicleSetAlarm = function(args)
    local vehicle, findErr = findVehicleById(args.vehicleId)
    if not vehicle then return false, nil, findErr or "Vehicle not found" end
    local enabled = args.enabled == true

    local ok, err = pcall(function()
        if not PanelBridge.invoke(vehicle, "setAlarmed", enabled) then
            error("setAlarmed not available")
        end
        if enabled then PanelBridge.invoke(vehicle, "triggerAlarm") end
    end)
    if not ok then return false, nil, "Failed to update vehicle alarm: " .. tostring(err) end

    local okGet, actualAlarmed = PanelBridge.invoke(vehicle, "isAlarmed")
    local verified
    if not okGet then
        verified = nil
    else
        verified = ((actualAlarmed == true) == enabled)
    end

    return PanelBridge.verifiedResult(verified,
        { message = "Vehicle alarm updated", vehicleId = tonumber(args.vehicleId), enabled = enabled },
        "Alarm call succeeded but did not take effect (still " .. tostring(actualAlarmed) .. ")")
end

handlers.vehicleSetSiren = function(args)
    local vehicle, findErr = findVehicleById(args.vehicleId)
    if not vehicle then return false, nil, findErr or "Vehicle not found" end

    local mode = tonumber(args.mode)
    if not mode then mode = (args.enabled == false and 0 or 1) end

    local ok, err = pcall(function()
        if not PanelBridge.invoke(vehicle, "setLightbarSirenMode", mode) then
            error("setLightbarSirenMode not available")
        end
    end)
    if not ok then return false, nil, "Failed to set vehicle siren mode: " .. tostring(err) end

    local sirenModeObj = PanelBridge.tryGet(vehicle, "getLightbarSirenModeObject")
    local actualMode = tonumber(PanelBridge.tryGet(sirenModeObj, "get"))
    local verified
    if actualMode == nil then
        verified = nil
    else
        verified = (actualMode == mode)
    end

    return PanelBridge.verifiedResult(verified,
        { message = "Vehicle siren mode updated", vehicleId = tonumber(args.vehicleId), mode = mode },
        "Siren mode call succeeded but did not take effect (still " .. tostring(actualMode) .. ")")
end

handlers.vehicleSetTrunkLocked = function(args)
    local vehicle, findErr = findVehicleById(args.vehicleId)
    if not vehicle then return false, nil, findErr or "Vehicle not found" end
    local locked = args.locked == true

    local ok, err = pcall(function()
        if not PanelBridge.invoke(vehicle, "setTrunkLocked", locked) then
            error("setTrunkLocked not available")
        end
    end)
    if not ok then return false, nil, "Failed to set trunk lock state: " .. tostring(err) end

    local okGet, actualLocked = PanelBridge.invoke(vehicle, "isTrunkLocked")
    local verified
    if not okGet then
        verified = nil
    else
        verified = ((actualLocked == true) == locked)
    end

    return PanelBridge.verifiedResult(verified,
        { message = "Vehicle trunk lock updated", vehicleId = tonumber(args.vehicleId), locked = locked },
        "Trunk lock call succeeded but did not take effect (still " .. tostring(actualLocked) .. ")")
end

handlers.vehicleSetFuel = function(args)
    local vehicle, findErr = findVehicleById(args.vehicleId)
    if not vehicle then return false, nil, findErr or "Vehicle not found" end

    local pct = tonumber(args.percent)
    if not pct then return false, nil, "percent required (0-100)" end
    pct = math.min(math.max(pct, 0), 100)

    local ok, err = pcall(function()
        local parts = vehicleParts(vehicle)
        local part = parts and PanelBridge.tryGet(parts, "getPartById", "GasTank")
        local capacity = part and tonumber(PanelBridge.tryGet(part, "getContainerCapacity"))
        if capacity and capacity > 0 then
            local amount = capacity * pct / 100
            if PanelBridge.invoke(part, "setContainerContentAmount", amount) then
                PanelBridge.invoke(vehicle, "transmitPartModData", part)
                return
            end
        end
        if not PanelBridge.invoke(vehicle, "setRemainingFuelPercentage", pct) then
            error("No fuel setter available")
        end
    end)
    if not ok then return false, nil, "Failed to set fuel: " .. tostring(err) end

    local FUEL_TOLERANCE = 1.0
    local okGet, actualPct = PanelBridge.invoke(vehicle, "getRemainingFuelPercentage")
    local verified
    if not okGet or tonumber(actualPct) == nil then
        verified = nil
    else
        verified = (math.abs(tonumber(actualPct) - pct) <= FUEL_TOLERANCE)
    end

    return PanelBridge.verifiedResult(verified,
        { message = "Vehicle fuel set to " .. pct .. "%", vehicleId = tonumber(args.vehicleId), percent = pct },
        "Fuel call succeeded but did not take effect (still " .. tostring(actualPct) .. "%)")
end

handlers.vehicleSetBattery = function(args)
    local vehicle, findErr = findVehicleById(args.vehicleId)
    if not vehicle then return false, nil, findErr or "Vehicle not found" end

    local charge = tonumber(args.charge)
    if not charge then return false, nil, "charge required (0-100)" end
    charge = math.min(math.max(charge, 0), 100)

    local parts = vehicleParts(vehicle)

    local ok, err = pcall(function()
        local battery = parts and PanelBridge.tryGet(parts, "getBattery")
        local item = battery and PanelBridge.tryGet(battery, "getInventoryItem")
        local currentUses = item and tonumber(PanelBridge.tryGet(item, "getCurrentUsesFloat"))
        if currentUses and VehicleUtils and VehicleUtils.chargeBattery then
            VehicleUtils.chargeBattery(vehicle, charge / 100 - currentUses)
            return
        end
        if not PanelBridge.invoke(vehicle, "setBatteryCharge", charge) then
            error("No working battery setter on this build: the battery item route needs a battery with an inventory item (none found), and setBatteryCharge does not exist in the B42 vehicle API")
        end
    end)
    if not ok then return false, nil, "Failed to set battery: " .. tostring(err) end

    local BATTERY_TOLERANCE = 1.0
    local okGet, actualCharge = false, nil
    if parts then
        okGet, actualCharge = PanelBridge.invoke(parts, "getBatteryCharge")
    end
    local verified
    if not okGet or tonumber(actualCharge) == nil then
        verified = nil
    else
        verified = (math.abs(tonumber(actualCharge) - charge) <= BATTERY_TOLERANCE)
    end

    return PanelBridge.verifiedResult(verified,
        { message = "Vehicle battery set to " .. charge, vehicleId = tonumber(args.vehicleId), charge = charge },
        "Battery call succeeded but did not take effect (still " .. tostring(actualCharge) .. ")")
end

handlers.removeVehicle = function(args)
    local vehicle, findErr = findVehicleById(args.vehicleId)
    if not vehicle then return false, nil, findErr or "Vehicle not found" end

    local vId = tonumber(args.vehicleId)
    local vx = tonumber(PanelBridge.tryGet(vehicle, "getX")) or 0
    local vy = tonumber(PanelBridge.tryGet(vehicle, "getY")) or 0
    local scriptName = PanelBridge.tryGet(vehicle, "getScriptName") or "unknown"

    local ok, err = pcall(function()
        if PanelBridge.invoke(vehicle, "permanentlyRemove") then return end
        if PanelBridge.invoke(vehicle, "removeFromWorld") then return end
        if PanelBridge.invoke(vehicle, "removeVehicle") then return end
        local world = getWorld()
        local cell = world and PanelBridge.tryGet(world, "getCell")
        if not (cell and PanelBridge.invoke(cell, "removeVehicle", vehicle)) then
            error("No removal method available on this PZ build")
        end
    end)
    if not ok then return false, nil, "Failed to remove vehicle: " .. tostring(err) end

    local stillPresent, recheckErr = findVehicleById(vId)
    local verified
    if stillPresent ~= nil then
        verified = false
    elseif type(recheckErr) == "string" and recheckErr:find("^Vehicle not found") then
        verified = true
    else
        verified = nil
    end

    return PanelBridge.verifiedResult(verified,
        { message = "Vehicle removed", vehicleId = vId, scriptName = scriptName, x = vx, y = vy },
        "Vehicle removal call succeeded but the vehicle is still present in getVehiclesList()")
end

handlers.removeVehiclesInArea = function(args)
    if args.minX == nil or args.minY == nil or args.maxX == nil or args.maxY == nil then
        return false, nil, "minX, minY, maxX, maxY required"
    end
    local minX = math.floor(tonumber(args.minX) or 0)
    local minY = math.floor(tonumber(args.minY) or 0)
    local maxX = math.floor(tonumber(args.maxX) or 0)
    local maxY = math.floor(tonumber(args.maxY) or 0)
    if maxX < minX then minX, maxX = maxX, minX end
    if maxY < minY then minY, maxY = maxY, minY end

    local areaW = maxX - minX
    local areaH = maxY - minY
    if areaW > 2000 or areaH > 2000 then
        return false, nil, "Area too large (max 2000x2000 tiles). Use smaller selections."
    end

    local vehicles = getVehiclesList()
    if not vehicles then return false, nil, "Vehicle list not available" end

    local list, collectErr = collectVehicles(vehicles)
    if not list then
        return false, nil, "Vehicle list lookup failed: " .. collectErr
    end

    local attempted = {}

    for i = #list, 1, -1 do
        local v = list[i]
        local vx = tonumber(vehicleGet(v, "getX")) or 0
        local vy = tonumber(vehicleGet(v, "getY")) or 0
        if vx >= minX and vx <= maxX and vy >= minY and vy <= maxY then
            local vId = vehicleGet(v, "getId")
            local scriptName = vehicleGet(v, "getScriptName") or "unknown"
            local didRemove = PanelBridge.invoke(v, "permanentlyRemove")
            if not didRemove then
                didRemove = PanelBridge.invoke(v, "removeFromWorld")
            end
            if didRemove then
                table.insert(attempted, { id = vId, scriptName = scriptName, x = vx, y = vy })
            end
        end
    end

    local stillPresentIds = {}
    local verifyOk = false
    if #attempted > 0 then
        local freshVehicles = getVehiclesList()
        local freshList
        if freshVehicles then
            freshList = collectVehicles(freshVehicles)
        end
        if freshList then
            verifyOk = true
            for _, v in ipairs(freshList) do
                local idOk, id = PanelBridge.invoke(v, "getId")
                if idOk then stillPresentIds[tonumber(id)] = true end
            end
        end
    end

    local removed = 0
    local removedList = {}
    for _, entry in ipairs(attempted) do
        if not verifyOk or not stillPresentIds[tonumber(entry.id)] then
            removed = removed + 1
            table.insert(removedList, entry)
        end
    end

    return true, {
        message = removed .. " vehicle(s) removed from area",
        removed = removed,
        vehicles = removedList,
        bounds = { minX = minX, minY = minY, maxX = maxX, maxY = maxY },
        verified = verifyOk and "confirmed" or "unverifiable",
    }
end

handlers.spawnVehicleAt = function(args)
    return false, nil, "Vehicle spawning is handled by the panel through RCON on Build 42"
end

handlers.vehicleHotwire = function(args)
    local vehicle, findErr = findVehicleById(args.vehicleId)
    if not vehicle then return false, nil, findErr or "Vehicle not found" end

    local actions = {}

    local ok, err = pcall(function()
        if PanelBridge.invoke(vehicle, "setHotwired", true) then
            table.insert(actions, "hotwired")
        end
        if PanelBridge.invoke(vehicle, "setHotwiredBroken", false) then
            table.insert(actions, "hotwireBroken=false")
        end
        if PanelBridge.invoke(vehicle, "setKeysInIgnition", true) then
            table.insert(actions, "keysInIgnition")
        end

        local parts = vehicleParts(vehicle)

        local partCount = parts and tonumber(PanelBridge.tryGet(parts, "getPartCount")) or 0
        for i = 0, partCount - 1 do
            local part = PanelBridge.tryGet(parts, "getPartByIndex", i)
            if part then
                local door = PanelBridge.tryGet(part, "getDoor")
                if door then
                    PanelBridge.invoke(door, "setLocked", false)
                end
            end
        end
        PanelBridge.invoke(vehicle, "setTrunkLocked", false)
        table.insert(actions, "unlocked")

        local enginePart = parts and PanelBridge.tryGet(parts, "getPartById", "Engine")
        local engineCond = enginePart and tonumber(PanelBridge.tryGet(enginePart, "getCondition"))
        if engineCond and engineCond < 10 then
            if PanelBridge.invoke(enginePart, "setCondition", 20) then
                table.insert(actions, "engineCondRepaired")
            end
        end

        local engineStarted = false

        if not engineStarted and vehicle.startEngine then
            vehicle:startEngine()
            engineStarted = true
            table.insert(actions, "startEngine")
        end

        if not engineStarted and vehicle.setEngineRunning then
            vehicle:setEngineRunning(true)
            engineStarted = true
            table.insert(actions, "setEngineRunning")
        end

        if not engineStarted and vehicle.engineDoStarting then
            vehicle:engineDoStarting()
            engineStarted = true
            table.insert(actions, "engineDoStarting")
        end

        if not engineStarted then
            table.insert(actions, "noEngineMethod")
        end

        if PanelBridge.invoke(vehicle, "transmitEngine") then
            table.insert(actions, "transmitEngine")
        end
        if PanelBridge.invoke(vehicle, "transmitVehicle") then
            table.insert(actions, "transmitVehicle")
        end
        if PanelBridge.invoke(vehicle, "updateFlags") then
            table.insert(actions, "updateFlags")
        end
    end)

    if not ok then
        return false, nil, "Hotwire failed: " .. tostring(err) .. " (completed: " .. table.concat(actions, ", ") .. ")"
    end

    return true, {
        message = "Vehicle hotwired and engine started",
        vehicleId = tonumber(args.vehicleId),
        actions = actions
    }
end


handlers.triggerSwarmEvent = function(args)
    local count = math.floor(tonumber(args.count) or 25)
    local x1 = math.floor(tonumber(args.x1) or 0)
    local y1 = math.floor(tonumber(args.y1) or 0)
    local x2 = math.floor(tonumber(args.x2) or x1)
    local y2 = math.floor(tonumber(args.y2) or y1)
    local z = math.floor(tonumber(args.z) or 0)

    count = math.min(math.max(count, 1), 500)
    if x2 < x1 then x1, x2 = x2, x1 end
    if y2 < y1 then y1, y2 = y2, y1 end

    local midX = math.floor((x1 + x2) / 2)
    local midY = math.floor((y1 + y2) / 2)
    local method = "unknown"
    local spawned = 0
    local verified = false

    local ok, err = pcall(function()
        local vzm = _G.VirtualZombieManager and _G.VirtualZombieManager.instance
        if vzm and vzm.createRealZombieNow then
            for i = 1, count do
                local tx = x1 + ZombRand(x2 - x1 + 1)
                local ty = y1 + ZombRand(y2 - y1 + 1)
                local okZ, zombie = pcall(function()
                    return vzm:createRealZombieNow(tx, ty, z)
                end)
                if okZ and zombie then spawned = spawned + 1 end
            end
            method = "VirtualZombieManager.createRealZombieNow"
            verified = true
        else
            local zpop = getZombiePopManager()
            if zpop and zpop.createHordeInAreaTo then
                zpop:createHordeInAreaTo(x1, y1, x2 - x1, y2 - y1, midX, midY, count)
                method = "createHordeInAreaTo"
                spawned = nil
            elseif zpop and zpop.createHordeFromTo then
                zpop:createHordeFromTo(x1, y1, midX, midY, count)
                method = "createHordeFromTo"
                spawned = nil
            else
                local world = getWorld()
                if world and world.CreateSwarm then
                    world:CreateSwarm(count, x1, y1, x2, y2)
                    method = "CreateSwarm"
                    spawned = nil
                else
                    error("No zombie spawning API available (VirtualZombieManager / ZombiePopulationManager / IsoWorld.CreateSwarm all missing)")
                end
            end
        end
    end)
    if not ok then return false, nil, "Failed to trigger swarm: " .. tostring(err) end

    local verifiedStr = "unverifiable"
    if verified == true then verifiedStr = "confirmed" end

    if verified == true and spawned == 0 then
        PanelBridge.warn("Swarm event created no zombies", { count = count, area = { x1 = x1, y1 = y1, x2 = x2, y2 = y2 }, spawned = spawned, verified = verified, method = method })
        return false, nil, "Failed to trigger swarm: no zombies were created (0/" .. count .. "); the target area may not be loaded or available"
    end

    PanelBridge.warn("Swarm event triggered", { count = count, area = { x1 = x1, y1 = y1, x2 = x2, y2 = y2 }, spawned = spawned, verified = verified, method = method })
    return true, {
        message = verified
            and ("Spawned " .. spawned .. "/" .. count .. " zombies in the area")
            or ("Requested " .. count .. " zombies in the area via " .. method .. " (spawn count not verifiable for this method)"),
        count = count,
        spawned = spawned,
        verified = verifiedStr,
        area = { x1 = x1, y1 = y1, x2 = x2, y2 = y2 },
        method = method
    }
end

handlers.runEventSequence = function(args)
    local steps = args.steps
    if type(steps) ~= "table" then
        return false, nil, "steps array required"
    end

    local maxSteps = math.min(math.max(tonumber(args.maxSteps) or 20, 1), 50)
    local results = {}
    local executed = 0
    local failedCount = 0

    for i, step in ipairs(steps) do
        if executed >= maxSteps then break end
        if type(step) == "table" then
            local kind = tostring(step.kind or "")
            local ok, handlerSuccess, handlerData, handlerError = pcall(function()
                if kind == "chat" then
                    local msg = normalizeMessage(step.message, 1000)
                    if not msg then error("chat.message required") end
                    if step.channel == "admin" then
                        return handlers.sendToAdminChat({ message = msg })
                    elseif step.channel == "general" then
                        return handlers.sendToGeneralChat({ message = msg, author = step.author })
                    end
                    return handlers.sendToServerChat({ message = msg, isAlert = step.alert == true })
                elseif kind == "swarm" then
                    return handlers.triggerSwarmEvent(step)
                elseif kind == "weather" then
                    local weatherType = tostring(step.weatherType or "storm")
                    if weatherType == "blizzard" then
                        return handlers.triggerBlizzard({ duration = step.duration })
                    elseif weatherType == "tropical" then
                        return handlers.triggerTropicalStorm({ duration = step.duration })
                    elseif weatherType == "stop" then
                        return handlers.stopWeather({})
                    end
                    return handlers.triggerStorm({ duration = step.duration })
                elseif kind == "utilities" then
                    if step.mode == "off" then
                        return handlers.shutOffUtilities({ power = step.power, water = step.water })
                    end
                    return handlers.restoreUtilities({ power = step.power, water = step.water })
                elseif kind == "noise" then
                    return handlers.createNoise(step)
                else
                    error("Unsupported sequence step kind: " .. kind)
                end
            end)

            executed = executed + 1
            if not ok then
                failedCount = failedCount + 1
                table.insert(results, { index = i, kind = kind, success = false, error = tostring(handlerSuccess) })
            elseif handlerSuccess then
                table.insert(results, { index = i, kind = kind, success = true, data = handlerData })
            else
                failedCount = failedCount + 1
                table.insert(results, { index = i, kind = kind, success = false, error = tostring(handlerError) })
            end
        end
    end

    local allVerified = failedCount == 0
    local data = {
        message = allVerified
            and "Event sequence executed"
            or ("Event sequence completed with " .. failedCount .. "/" .. executed .. " step(s) failed"),
        executed = executed,
        maxSteps = maxSteps,
        failedCount = failedCount,
        results = results
    }

    if allVerified then
        return true, data
    end
    return false, data, data.message
end


handlers.getInfrastructureSnapshot = function(args)
    local world = getWorld()
    local cell = (getCell and getCell()) or (world and PanelBridge.tryGet(world, "getCell"))
    if not world then return false, nil, "World not available" end

    local snapshot = {
        hydroPowerOn = PanelBridge.tryGet(world, "isHydroPowerOn"),
        globalTemperature = PanelBridge.tryGet(world, "getGlobalTemperature"),
        weather = PanelBridge.tryGet(world, "getWeather"),
        sample = nil
    }

    local sx = tonumber(args.x)
    local sy = tonumber(args.y)
    local sz = tonumber(args.z) or 0
    if cell and sx and sy then
        local sample = { x = sx, y = sy, z = sz }
        local ix, iy, iz = math.floor(sx), math.floor(sy), math.floor(sz)
        sample.dangerScore = PanelBridge.tryGet(cell, "getDangerScore", ix, iy)
        sample.heatSourceTemperature = PanelBridge.tryGet(cell, "getHeatSourceTemperature", ix, iy, iz)
        sample.heatSourceHighestTemperature = PanelBridge.tryGet(cell, "getHeatSourceHighestTemperature",
            snapshot.globalTemperature or 0, ix, iy, iz)
        local lightOk, lightSource = PanelBridge.invoke(cell, "getLightSourceAt", ix, iy, iz)
        if lightOk then sample.hasLamppost = lightSource ~= nil end
        snapshot.sample = sample
    end

    return true, snapshot
end


handlers.moderationKickUser = function(args)
    local username = normalizeMessage(args.username, 64)
    local reason = normalizeMessage(args.reason, 120) or "Kicked by admin panel"
    local description = normalizeMessage(args.description, 240) or reason

    if not username then return false, nil, "Username required" end

    local ok, err = pcall(function()
        if BanSystem and BanSystem.KickUser then
            BanSystem.KickUser(username, reason, description)
        else
            error("BanSystem.KickUser not available")
        end
    end)
    if not ok then return false, nil, "Kick failed: " .. tostring(err) end

    return true, { message = "User kicked", username = username, reason = reason }
end

handlers.moderationBanUser = function(args)
    local username = normalizeMessage(args.username, 64)
    local reason = normalizeMessage(args.reason, 120) or "Banned by admin panel"
    local ban = args.ban ~= false

    if not username then return false, nil, "Username required" end

    local ok, resultOrErr = pcall(function()
        if BanSystem and BanSystem.BanUser then
            return BanSystem.BanUser(username, nil, reason, ban)
        end
        error("BanSystem.BanUser not available")
    end)
    if not ok then return false, nil, "Ban user failed: " .. tostring(resultOrErr) end

    if resultOrErr ~= nil and resultOrErr ~= "" then
        return false, nil, "Ban user rejected: " .. tostring(resultOrErr)
    end

    return true, {
        message = ban and "User banned" or "User unbanned",
        username = username,
        details = resultOrErr,
        verified = "confirmed"
    }
end

handlers.moderationBanIP = function(args)
    local ip = normalizeMessage(args.ip, 64)
    local reason = normalizeMessage(args.reason, 120) or "IP ban from admin panel"
    local ban = args.ban ~= false

    if not ip then return false, nil, "IP required" end

    local ok, resultOrErr = pcall(function()
        if BanSystem and BanSystem.BanIP then
            return BanSystem.BanIP(ip, nil, reason, ban)
        end
        error("BanSystem.BanIP not available")
    end)
    if not ok then return false, nil, "Ban IP failed: " .. tostring(resultOrErr) end

    if resultOrErr ~= nil and resultOrErr ~= "" then
        return false, nil, "Ban IP rejected: " .. tostring(resultOrErr)
    end

    return true, {
        message = ban and "IP banned" or "IP unbanned",
        ip = ip,
        details = resultOrErr,
        verified = "confirmed"
    }
end

handlers.moderationBanSteamID = function(args)
    local steamId = normalizeMessage(args.steamId, 32)
    local reason = normalizeMessage(args.reason, 120) or "SteamID ban from admin panel"
    local ban = args.ban ~= false

    if not steamId then return false, nil, "steamId required" end

    local ok, resultOrErr = pcall(function()
        if BanSystem and BanSystem.BanUserBySteamID then
            return BanSystem.BanUserBySteamID(steamId, nil, reason, ban)
        end
        error("BanSystem.BanUserBySteamID not available")
    end)
    if not ok then return false, nil, "Ban SteamID failed: " .. tostring(resultOrErr) end

    if resultOrErr ~= nil and resultOrErr ~= "" then
        return false, nil, "Ban SteamID rejected: " .. tostring(resultOrErr)
    end

    return true, {
        message = ban and "SteamID banned" or "SteamID unbanned",
        steamId = steamId,
        details = resultOrErr,
        verified = "confirmed"
    }
end


handlers.debugItemScript = function(args)
    local sm = ScriptManager and ScriptManager.instance
    if not sm then return false, nil, "ScriptManager not available" end

    local allItems = nil
    pcall(function() allItems = sm:getAllItems() end)
    if not allItems or allItems:size() == 0 then
        return false, nil, "No items found"
    end

    local probes = {}
    local limit = math.min(3, allItems:size())
    for i = 0, limit - 1 do
        local script = allItems:get(i)
        if script then
            local probe = {}
            local nameOk, name = pcall(function() return script:getFullName() end)
            probe.id = nameOk and tostring(name) or "?"

            local methods = {"getTypeString", "getType", "getCategory", "getDisplayCategory",
                             "getBodyLocation", "getSubCategory", "getCategories",
                             "getTypeToItem", "getScriptObjectType"}
            for _, m in ipairs(methods) do
                local ok, val = pcall(function()
                    if script[m] then
                        return script[m](script)
                    end
                    return nil
                end)
                if ok and val ~= nil then
                    probe[m] = tostring(val)
                else
                    probe[m] = ok and "nil" or ("ERROR: " .. tostring(val))
                end
            end
            table.insert(probes, probe)
        end
    end
    return true, { probes = probes }
end

handlers.getItemCatalog = function(args)
    local sm = ScriptManager and ScriptManager.instance
    if not sm then
        return false, nil, "ScriptManager not available"
    end

    local allItems = nil
    local ok, err = pcall(function()
        allItems = sm:getAllItems()
    end)
    if not ok or not allItems then
        return false, nil, "Failed to enumerate items: " .. tostring(err)
    end

    local catalog = {}
    local errors = 0
    local count = allItems:size()
    for i = 0, count - 1 do
        local script = allItems:get(i)
        if script then
            local entry = {}
            local fullOk, fullType = pcall(function() return script:getFullName() end)
            if not fullOk or not fullType then
                fullOk, fullType = pcall(function() return script:getName() end)
            end
            if fullOk and fullType then
                entry.id = fullType

                local nameOk, displayName = pcall(function() return script:getDisplayName() end)
                entry.name = (nameOk and displayName) or fullType

                local cat = nil

                local dcOk, dcVal = pcall(function() return script:getDisplayCategory() end)
                if dcOk and dcVal and tostring(dcVal) ~= "" then
                    cat = tostring(dcVal)
                end

                if not cat and fullType then
                    local module = fullType:match("^([^%.]+)%.")
                    if module then cat = module end
                end

                entry.category = cat or "Other"

                local wOk, w = pcall(function() return script:getActualWeight() end)
                if wOk and w then entry.weight = w end

                table.insert(catalog, entry)
            else
                errors = errors + 1
            end
        end
    end

    PanelBridge.info("Item catalog scanned", { count = #catalog, errors = errors })
    return true, { items = catalog, count = #catalog }
end

handlers.getVehicleCatalog = function(args)
    local sm = ScriptManager and ScriptManager.instance
    if not sm then
        return false, nil, "ScriptManager not available"
    end

    local allVehicles = PanelBridge.tryGet(sm, "getAllVehicleScripts")
        or PanelBridge.tryGet(sm, "getAllVehicles")
    if not allVehicles then
        return false, nil, "Failed to enumerate vehicles: API not available"
    end

    local catalog = {}
    local count = allVehicles:size()
    for i = 0, count - 1 do
        local script = allVehicles:get(i)
        if script then
            local entry = {}
            local nameOk, fullName = pcall(function() return script:getFullName() end)
            if not nameOk or not fullName then
                nameOk, fullName = pcall(function() return script:getName() end)
            end
            if nameOk and fullName then
                entry.id = fullName

                local displayName = nil
                local shortOk, shortName = pcall(function() return script:getName() end)
                if shortOk and shortName and shortName ~= "" then
                    displayName = shortName
                else
                    displayName = fullName:match("%.(.+)$") or fullName
                end
                entry.name = displayName

                local massOk, mass = pcall(function() return script:getMass() end)
                if massOk and mass then entry.mass = mass end

                local seats = nil
                if script.getPassengerCount then
                    local pcOk, pc = pcall(script.getPassengerCount, script)
                    if pcOk and pc then seats = pc end
                end
                if not seats and script.getMaxPassengers then
                    local mpOk, mp = pcall(script.getMaxPassengers, script)
                    if mpOk and mp then seats = mp end
                end
                if seats then entry.seats = seats end

                table.insert(catalog, entry)
            end
        end
    end

    PanelBridge.info("Vehicle catalog scanned", { count = #catalog })
    return true, { vehicles = catalog, count = #catalog }
end


function PanelBridge.processCommands()
    local processedCount = 0
    local scannedCount = 0
    local queueProcessed, queueScanned = processQueuedCommands(PanelBridge.MAX_COMMANDS_PER_TICK)
    processedCount = processedCount + queueProcessed
    scannedCount = scannedCount + queueScanned

    local nowMs = getTimestampMs()
    local commands = nil
    if nowMs - PanelBridge.lastLegacyCheck >= PanelBridge.LEGACY_COMMANDS_INTERVAL then
        PanelBridge.lastLegacyCheck = nowMs
        commands = PanelBridge.readJSON("commands.json")
    end
    if not commands or not commands.commands then
        if processedCount > 0 then
            PanelBridge.debug("Processed " .. processedCount .. " commands")
        end
        return
    end

    local deferredCommands = nil

    PanelBridge.clearFile("commands.json")

    for idx, cmd in ipairs(commands.commands) do
        if scannedCount >= PanelBridge.MAX_COMMANDS_PER_TICK then
            deferredCommands = {}
            for j = idx, #commands.commands do
                table.insert(deferredCommands, commands.commands[j])
            end
            PanelBridge.warn("Command batch limit reached; deferring remaining commands", {
                processed = processedCount,
                scanned = scannedCount,
                maxPerTick = PanelBridge.MAX_COMMANDS_PER_TICK,
                totalInFile = #commands.commands,
                deferredCount = #deferredCommands
            })
            break
        end

        scannedCount = scannedCount + 1
        if processSingleCommand(cmd) then
            processedCount = processedCount + 1
        end
    end

    if processedCount > 0 then
        PanelBridge.debug("Processed " .. processedCount .. " commands")
    end

    if deferredCommands and #deferredCommands > 0 then
        local existing = PanelBridge.readJSON("commands.json") or { commands = {} }
        local merged = { commands = {} }

        for _, cmd in ipairs(deferredCommands) do
            table.insert(merged.commands, cmd)
        end

        if existing.commands then
            for _, cmd in ipairs(existing.commands) do
                table.insert(merged.commands, cmd)
            end
        end

        local requeueOk = PanelBridge.writeJSON("commands.json", merged)
        if not requeueOk then
            PanelBridge.error("Failed to requeue deferred commands", { count = #deferredCommands })
        end
    end

    if PanelBridge.processedIdCount > 500 then
        local oldCount = PanelBridge.processedIdCount
        local skip = math.floor(oldCount / 2)
        local newOrder = {}
        local newSet = {}
        for i = skip + 1, #PanelBridge.processedIdOrder do
            local id = PanelBridge.processedIdOrder[i]
            newOrder[#newOrder + 1] = id
            newSet[id] = true
        end
        PanelBridge.processedIds = newSet
        PanelBridge.processedIdOrder = newOrder
        PanelBridge.processedIdCount = #newOrder
        PanelBridge.debug("Trimmed processed IDs", { previous = oldCount, kept = PanelBridge.processedIdCount })
    end
end

function PanelBridge.updateStatus()
    local ok, err = pcall(function()
        local onlinePlayers = getOnlinePlayers()
        local playerNames = {}
        if onlinePlayers then
            for i = 0, onlinePlayers:size() - 1 do
                local player = onlinePlayers:get(i)
                if player then
                    table.insert(playerNames, player:getUsername())
                end
            end
        end

        local status = {
            alive = true,
            version = PanelBridge.VERSION,
            protocolVersion = PanelBridge.PROTOCOL_VERSION,
            timestamp = getTimestampMs(),
            serverName = getServerName(),
            playerCount = onlinePlayers and onlinePlayers:size() or 0,
            players = playerNames,
            path = PanelBridge.getBasePath(),
            debugMode = PanelBridge.DEBUG_MODE,
            stats = {
                processed = PanelBridge.stats.commandsProcessed,
                succeeded = PanelBridge.stats.commandsSucceeded,
                failed = PanelBridge.stats.commandsFailed
            },
            queue = {
                lastCommandSeq = PanelBridge.queueState.lastCommandSeq,
                nextResultSeq = PanelBridge.queueState.nextResultSeq
            }
        }

        PanelBridge.writeJSON("status.json", status)
    end)

    if not ok then
        PanelBridge.error("Failed to update status", { error = tostring(err) })
    end
end

function PanelBridge.onTick()
    if not PanelBridge.initialized then return end

    local now = getTimestampMs()

    local jobOk, jobErr = pcall(PanelBridge.processActiveJob)
    if not jobOk then
        PanelBridge.error("Tick error in processActiveJob", { error = tostring(jobErr) })
    end

    if now - PanelBridge.lastCheck >= PanelBridge.CHECK_INTERVAL then
        PanelBridge.lastCheck = now
        local success, err = pcall(PanelBridge.processCommands)
        if not success then
            PanelBridge.error("Tick error in processCommands", { error = tostring(err) })
        end
        local flushOk, flushErr = pcall(PanelBridge.flushResults)
        if not flushOk then
            PanelBridge.error("Tick error in flushResults", { error = tostring(flushErr) })
        end
    end

    if now - PanelBridge.lastStatusUpdate >= PanelBridge.STATUS_INTERVAL then
        PanelBridge.lastStatusUpdate = now
        pcall(PanelBridge.updateStatus)
    end
end

function PanelBridge.onServerStarted()
    print("[PanelBridge] ========================================")
    print("[PanelBridge] Initializing v" .. PanelBridge.VERSION)

    if not isServer() then
        print("[PanelBridge] Not running on server, disabling")
        return
    end

    PanelBridge.stats.startTime = getTimestampMs()
    PanelBridge.stats.commandsProcessed = 0
    PanelBridge.stats.commandsSucceeded = 0
    PanelBridge.stats.commandsFailed = 0
    PanelBridge.stats.errors = {}

    if not PanelBridge.ensureDirectory() then
        PanelBridge.error("Could not create directory")
        print("[PanelBridge] ERROR: Could not create directory")
        return
    end


    PanelBridge.readQueueState()
    PanelBridge.writeQueueState()
    PanelBridge.writeInboxCursor(PanelBridge.queueState.lastCommandSeq)

    PanelBridge.detectVersion()

    if PanelBridge.reconcileStartupPower() then
        print("[PanelBridge] Restored startup power from the configured sandbox countdown")
    end

    PanelBridge.updateStatus()

    PanelBridge.clearFile("commands.json")
    PanelBridge.clearFile("results.json")

    PanelBridge.writeJSON("startup.json", {
        version = PanelBridge.VERSION,
        startTime = PanelBridge.stats.startTime,
        path = PanelBridge.getBasePath(),
        detectedVersion = PanelBridge.detectedVersion,
        serverName = getServerName()
    })

    pcall(function()
        local gt = getGameTime()
        local multiplier = tonumber(PanelBridge.tryGet(gt, "getMultiplier"))
        if multiplier and multiplier ~= 1 then
            if PanelBridge.invoke(gt, "setMultiplier", 1) then
                print("[PanelBridge] Reset time speed from " .. tostring(multiplier) .. "x to 1x")
            end
        end
    end)

    PanelBridge.initialized = true
    PanelBridge.info("PanelBridge ready", { path = PanelBridge.getBasePath() })
    print("[PanelBridge] Ready at: " .. PanelBridge.getBasePath())
    print("[PanelBridge] Debug mode: " .. (PanelBridge.DEBUG_MODE and "ON" or "OFF"))

    local chatProbe = getChatSystem()
    if chatProbe and chatProbe.server then
        print("[PanelBridge] ChatServer: available (native chat API)")
    else
        print("[PanelBridge] ChatServer: not exposed to Lua (normal on B42 — chat uses RCON servermsg)")
    end

    print("[PanelBridge] ========================================")
end

Events.OnServerStarted.Add(PanelBridge.onServerStarted)
Events.OnTickEvenPaused.Add(PanelBridge.onTick)

PanelBridge.handlers = handlers

PanelBridge.json = json

return PanelBridge
