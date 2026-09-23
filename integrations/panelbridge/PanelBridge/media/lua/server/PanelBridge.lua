---@diagnostic disable: undefined-global, deprecated

local json

local PanelBridge = {
    VERSION = "1.7.57",
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
        features = {}
    }

    pcall(function()
        if getCore and getCore() and getCore().getVersion then
            version.build = getCore():getVersion()
        end
    end)

    if version.build ~= "unknown" then
        local major = version.build:match("^(%d+)%.")
        if major then
            local majorNum = tonumber(major)
            if majorNum and majorNum >= 42 then
                version.isB42 = true
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
    local decodeOk, decoded = pcall(json.decode, content)
    if not decodeOk then
        PanelBridge.warn("Failed to decode JSON file, treating as absent", {
            file = filename,
            parseError = tostring(decoded)
        })
        return nil
    end
    return decoded
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
    getAllSandboxOptions = { ttl = 300000, live = true },
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

    local quietCommands = { getServerInfo=true, ping=true, getWorldStats=true, getUtilitiesStatus=true, getAllPlayerDetails=true, getSandboxOptions=true }
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
            local age = cached and (getTimestampMs() - cached.at)
            if cached and age >= 0 and age < cacheTtl then
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
    if now < stuck.since then
        stuck.since = now
        stuck.nextCheckAt = now
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
