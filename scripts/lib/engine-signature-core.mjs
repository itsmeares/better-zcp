
const LONG_BRACKET_OPEN = /^\[(=*)\[/;

export function stripLuaComments(src) {
  const out = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const c2 = src[i + 1];
    if (c === '"' || c === "'") {
      const quote = c;
      out.push(c);
      i++;
      while (i < n && src[i] !== quote) {
        if (src[i] === '\\' && i + 1 < n) {
          out.push(src[i], src[i + 1]);
          i += 2;
          continue;
        }
        out.push(src[i]);
        i++;
      }
      if (i < n) {
        out.push(src[i]);
        i++;
      }
      continue;
    }
    if (c === '-' && c2 === '-') {
      const rest = src.slice(i + 2);
      const longMatch = LONG_BRACKET_OPEN.exec(rest);
      if (longMatch) {
        const eq = longMatch[1];
        const closer = `]${eq}]`;
        const closeIdx = src.indexOf(closer, i + 2 + longMatch[0].length);
        const end = closeIdx === -1 ? n : closeIdx + closer.length;
        for (let p = i; p < end; p++) out.push(src[p] === '\n' ? '\n' : ' ');
        i = end;
        continue;
      }
      let end = src.indexOf('\n', i);
      if (end === -1) end = n;
      for (let p = i; p < end; p++) out.push(' ');
      i = end;
      continue;
    }
    out.push(c);
    i++;
  }
  return out.join('');
}

export function computeTableConstructorDepths(src) {
  const depthAtOffset = new Int32Array(src.length + 1);
  let depth = 0;
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    depthAtOffset[i] = depth;
    if (c === '"' || c === "'") {
      const quote = c;
      i++;
      while (i < n && src[i] !== quote) {
        if (src[i] === '\\' && i + 1 < n) i += 2;
        else i++;
      }
      i++;
      continue;
    }
    if (c === '{') {
      depth++;
      i++;
      continue;
    }
    if (c === '}') {
      depth = Math.max(0, depth - 1);
      i++;
      continue;
    }
    i++;
  }
  depthAtOffset[n] = depth;
  return depthAtOffset;
}

export function buildLineIndex(src) {
  const offsets = [0];
  for (let i = 0; i < src.length; i++) {
    if (src[i] === '\n') offsets.push(i + 1);
  }
  return offsets;
}

export function lineOfOffset(lineIndex, offset) {
  let lo = 0;
  let hi = lineIndex.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (lineIndex[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

const IDENT_START = /[A-Za-z_]/;
const IDENT_CHAR = /[A-Za-z0-9_]/;
const WS = /\s/;

export function parseChainAt(src, startIdx) {
  let i = startIdx;
  const n = src.length;
  if (!IDENT_START.test(src[i] || '')) return null;

  function skipWs() {
    while (i < n && WS.test(src[i])) i++;
  }
  function readIdent() {
    const s = i;
    while (i < n && IDENT_CHAR.test(src[i])) i++;
    return i > s ? src.slice(s, i) : null;
  }
  function skipBalancedParens() {
    let depth = 0;
    do {
      if (src[i] === '(') depth++;
      else if (src[i] === ')') depth--;
      i++;
    } while (i < n && depth > 0);
  }

  const firstName = readIdent();
  if (firstName === null) return null;
  let called = false;
  skipWs();
  if (src[i] === '(') {
    skipBalancedParens();
    called = true;
  }
  const steps = [{ sep: null, name: firstName, called, offset: startIdx }];

  for (;;) {
    const before = i;
    skipWs();
    if (src[i] === ':' || src[i] === '.') {
      const sep = src[i];
      const sepIdx = i;
      i++;
      skipWs();
      const nameOffset = i;
      const name = readIdent();
      if (name === null) {
        i = before;
        break;
      }
      let stepCalled = false;
      skipWs();
      if (src[i] === '(') {
        skipBalancedParens();
        stepCalled = true;
      }
      steps.push({ sep, name, called: stepCalled, offset: sepIdx, nameOffset });
      continue;
    }
    i = before;
    break;
  }
  return { steps, endIndex: i };
}

export function findAllChains(src) {
  const chains = [];
  const n = src.length;
  let i = 0;
  while (i < n) {
    if (IDENT_START.test(src[i])) {
      let p = i - 1;
      while (p >= 0 && (src[p] === ' ' || src[p] === '\t')) p--;
      const prevChar = p >= 0 ? src[p] : '';
      if (prevChar === '.' || prevChar === ':' || IDENT_CHAR.test(prevChar)) {
        i++;
        continue;
      }
      const result = parseChainAt(src, i);
      if (result) {
        chains.push(result);
        i = Math.max(result.endIndex, i + 1);
        continue;
      }
    }
    i++;
  }
  return chains;
}

export function directCallStepsFromChain(chain) {
  const sites = [];
  for (let k = 1; k < chain.steps.length; k++) {
    const step = chain.steps[k];
    if (step.sep === ':' && step.called) {
      sites.push({ receiverSteps: chain.steps.slice(0, k), methodName: step.name, offset: step.nameOffset });
    }
  }
  return sites;
}

function findMatchingParen(src, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < src.length; i++) {
    const c = src[i];
    if (c === '"' || c === "'") {
      const quote = c;
      i++;
      while (i < src.length && src[i] !== quote) {
        if (src[i] === '\\') i++;
        i++;
      }
      continue;
    }
    if (c === '(') depth++;
    else if (c === ')') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function splitTopLevelArgs(text) {
  const args = [];
  let depth = 0;
  let start = 0;
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (c === '"' || c === "'") {
      const quote = c;
      i++;
      while (i < n && text[i] !== quote) {
        if (text[i] === '\\') i++;
        i++;
      }
      i++;
      continue;
    }
    if (c === '(' || c === '{' || c === '[') depth++;
    else if (c === ')' || c === '}' || c === ']') depth--;
    else if (c === ',' && depth === 0) {
      args.push(text.slice(start, i));
      start = i + 1;
    }
    i++;
  }
  if (start < n || n === 0) args.push(text.slice(start));
  return args.map((s) => s.trim()).filter((s) => s.length > 0);
}

const LOCAL_ENGINE_HELPERS = ['call', 'get', 'safeString'];
const LOCAL_ENGINE_HELPER_RE = new RegExp(`\\b(${LOCAL_ENGINE_HELPERS.join('|')})\\s*\\(`, 'g');

export function extractHelperCallSites(src) {
  const sites = [];
  let m;
  LOCAL_ENGINE_HELPER_RE.lastIndex = 0;
  while ((m = LOCAL_ENGINE_HELPER_RE.exec(src))) {
    // Do not treat `local function call(...)` (or the other wrapper declarations)
    // as calls to an engine method.
    if (/function\s+$/.test(src.slice(Math.max(0, m.index - 16), m.index))) continue;
    const helperName = m[1];
    const openIdx = LOCAL_ENGINE_HELPER_RE.lastIndex - 1;
    const closeIdx = findMatchingParen(src, openIdx);
    if (closeIdx === -1) continue;
    const argsText = src.slice(openIdx + 1, closeIdx);
    const args = splitTopLevelArgs(argsText);
    if (args.length < 2) continue;
    const receiverText = args[0];
    const methodArgText = args[1];
    const litMatch = /^["']([A-Za-z_]\w*)["']$/.exec(methodArgText);
    sites.push({
      kind: 'helper',
      helperName,
      startOffset: m.index,
      receiverText,
      methodNameLiteral: litMatch ? litMatch[1] : null,
      methodArgRaw: methodArgText,
      offset: openIdx,
    });
    LOCAL_ENGINE_HELPER_RE.lastIndex = closeIdx;
  }
  return sites;
}

export const SEED_GLOBALS = {
  getWorld: { class: 'zombie.iso.IsoWorld' },
  getGameTime: { class: 'zombie.GameTime' },
  getOnlinePlayers: { class: 'java.util.ArrayList', elementType: 'zombie.characters.IsoPlayer' },
  getSandboxOptions: { class: 'zombie.SandboxOptions' },
  getScriptManager: { class: 'zombie.scripting.ScriptManager' },
};

export const STATIC_CLASS_SEEDS = {};

const LUA_KEYWORDS = new Set([
  'and', 'break', 'do', 'else', 'elseif', 'end', 'false', 'for', 'function', 'if', 'in', 'local',
  'nil', 'not', 'or', 'repeat', 'return', 'then', 'true', 'until', 'while',
]);
const LUA_STRING_METHODS = new Set(['byte', 'char', 'dump', 'find', 'format', 'gmatch', 'gsub', 'len', 'lower', 'match', 'rep', 'reverse', 'sub', 'upper']);

export function resolveAllCallSites(rawSrc, classProvider) {
  const src = stripLuaComments(rawSrc);
  const lineIndex = buildLineIndex(rawSrc);
  const tableDepth = computeTableConstructorDepths(src);
  const varTypes = new Map();

  const helperSites = extractHelperCallSites(src);

  function walkStepsFrom(steps, startIndex, currentType, elementType) {
    for (let k = startIndex; k < steps.length; k++) {
      const step = steps[k];
      if (step.sep === '.') {
        currentType = null;
        elementType = null;
        continue;
      }
      if (step.sep === ':' && step.called) {
        if (currentType == null) continue;
        const info = classProvider(currentType, step.name);
        if (info && info.exists) {
          if (step.name === 'get' && elementType) {
            currentType = elementType;
            elementType = null;
          } else {
            currentType = info.returnClass || null;
            elementType = info.elementClass || null;
          }
        } else {
          currentType = null;
          elementType = null;
        }
      }
    }
    return { type: currentType, elementType, reason: currentType ? null : 'chain-broke-before-end' };
  }

  function resolveWrapperExpression(receiverText, methodNameLiteral) {
    if (!methodNameLiteral) return { type: null, elementType: null, reason: 'dynamic method name' };
    const receiverChain = parseChainAt(receiverText, 0);
    const receiverResolved = receiverChain
      ? resolveChainType(receiverChain.steps)
      : { type: null, elementType: null, reason: 'unparseable helper receiver' };
    if (!receiverResolved.type) return { type: null, elementType: null, reason: receiverResolved.reason || 'helper receiver unresolved' };
    const info = classProvider(receiverResolved.type, methodNameLiteral);
    if (!info || !info.exists) return { type: null, elementType: null, reason: 'helper method not found' };
    if (methodNameLiteral === 'get' && receiverResolved.elementType) {
      return { type: receiverResolved.elementType, elementType: null, reason: null };
    }
    // call() returns the two values from pcall(), so callers assigning
    // `local ok, value = call(...)` get the engine return type in slot two.
    return { type: info.returnClass || null, elementType: info.elementClass || null, reason: null };
  }

  function resolveAssignmentExpression(text) {
    const wrapper = /^\s*(call|get|safeString)\s*\(/.exec(text);
    if (wrapper) {
      const openIdx = text.indexOf('(', wrapper.index);
      const closeIdx = findMatchingParen(text, openIdx);
      if (closeIdx !== -1) {
        const args = splitTopLevelArgs(text.slice(openIdx + 1, closeIdx));
        const receiverText = args[0] || '';
        const methodMatch = /^['"]([A-Za-z_]\w*)['"]$/.exec(args[1] || '');
        return resolveWrapperExpression(receiverText, methodMatch?.[1] || null);
      }
    }
    let chain = parseChainAt(text, 0);
    if (!chain) return { type: null, elementType: null, reason: 'unparseable assignment' };
    const resolved = resolveChainType(chain.steps);
    if (!resolved.type && !resolved.elementType) {
      // Some engine handles are obtained inside a guarded expression, e.g.
      // `type(getScriptManager) == "function" and getScriptManager() or nil`.
      for (const nested of findAllChains(text)) {
        const nestedResolved = resolveChainType(nested.steps);
        if (nestedResolved.type || nestedResolved.elementType) return nestedResolved;
      }
      for (const [globalName, seed] of Object.entries(SEED_GLOBALS)) {
        if (new RegExp(`\\b${globalName}\\s*\\(`).test(text)) {
          return { type: seed.class, elementType: seed.elementType || null, reason: null };
        }
      }
    }
    // Existing call sites occasionally use a guarded `a and b()` return.
    let after = chain.endIndex;
    while (after < text.length && WS.test(text[after])) after++;
    if (text.slice(after, after + 4) === 'and ') {
      const next = parseChainAt(text, after + 4);
      if (next) return resolveChainType(next.steps);
    }
    return resolved;
  }

  function startState(first) {
    if (first.called) {
      const seed = SEED_GLOBALS[first.name];
      return seed ? [seed.class, seed.elementType || null] : [null, null];
    }
    const known = varTypes.get(first.name);
    return known ? [known.type, known.elementType || null] : [null, null];
  }

  function resolveChainType(steps) {
    if (!steps || steps.length === 0) return { type: null, elementType: null, reason: 'empty-chain' };
    const first = steps[0];
    if (!first.called && STATIC_CLASS_SEEDS[first.name] && steps[1] && steps[1].sep === '.' && steps[1].called) {
      const info = classProvider(STATIC_CLASS_SEEDS[first.name], steps[1].name);
      if (!info || !info.exists) return { type: null, elementType: null, reason: `${first.name}.${steps[1].name}() not found` };
      return walkStepsFrom(steps, 2, info.returnClass || null, info.elementClass || null);
    }
    if (first.called) {
      if (!SEED_GLOBALS[first.name]) return { type: null, elementType: null, reason: `unseeded global '${first.name}()'` };
    } else {
      const known = varTypes.get(first.name);
      if (!known) return { type: null, elementType: null, reason: `unresolved variable '${first.name}'` };
    }
    return walkStepsFrom(steps, 1, ...startState(first));
  }

  const assignRe = /(?:^|[^.\w])(?:local\s+)?([A-Za-z_]\w*(?:\s*,\s*[A-Za-z_]\w*)*)\s*=(?!=)\s*/gm;
  let m;
  while ((m = assignRe.exec(src))) {
    const names = m[1].split(',').map((name) => name.trim());
    if (names.some((name) => LUA_KEYWORDS.has(name))) continue;
    if (tableDepth[m.index] > 0) continue;
    const exprStart = m.index + m[0].length;
    let exprEnd = exprStart;
    let parenDepth = 0;
    while (exprEnd < src.length) {
      const char = src[exprEnd];
      if (char === '(') parenDepth++;
      else if (char === ')') parenDepth = Math.max(0, parenDepth - 1);
      else if ((char === '\n' || char === '\r' || char === ';') && parenDepth === 0) break;
      exprEnd++;
    }
    const expression = src.slice(exprStart, exprEnd).trim();
    const resolved = resolveAssignmentExpression(expression);
    const targetIndex = /^\s*call\s*\(/.test(expression) ? 1 : 0;
    const target = names[targetIndex];
    if (target && (resolved.type || resolved.elementType) && !varTypes.has(target)) {
      varTypes.set(target, { type: resolved.type, elementType: resolved.elementType });
    }
  }

  const callSites = [];
  for (const site of helperSites) {
    const line = lineOfOffset(lineIndex, site.offset);
    if (!site.methodNameLiteral) {
      callSites.push({
        kind: 'helper', helperName: site.helperName, line, methodName: null,
        receiverExpr: site.receiverText, receiverType: null, resolved: false,
        skipReason: `dynamic method name (${site.methodArgRaw})`,
      });
      continue;
    }
    const chain = parseChainAt(site.receiverText, 0);
    const resolved = chain ? resolveChainType(chain.steps) : { type: null, reason: 'unparseable receiver' };
    const receiverType = resolved.type;
    let methodInfo = null;
    if (receiverType) methodInfo = classProvider(receiverType, site.methodNameLiteral);
    callSites.push({
      kind: 'helper', helperName: site.helperName, line, methodName: site.methodNameLiteral,
      receiverExpr: site.receiverText, receiverType, resolved: !!receiverType,
      skipReason: receiverType ? null : resolved.reason, methodInfo,
    });
  }

  for (const chain of findAllChains(src)) {
    for (const site of directCallStepsFromChain(chain)) {
      const line = lineOfOffset(lineIndex, site.offset);
      const resolved = resolveChainType(site.receiverSteps);
      const receiverType = resolved.type;
      if (receiverType === 'java.lang.String' && LUA_STRING_METHODS.has(site.methodName)) continue;
      let methodInfo = null;
      if (receiverType) methodInfo = classProvider(receiverType, site.methodName);
      const receiverExpr = site.receiverSteps
        .map((s, idx) => (idx === 0 ? s.name + (s.called ? '()' : '') : `${s.sep}${s.name}${s.called ? '()' : ''}`))
        .join('');
      callSites.push({
        kind: 'direct', helperName: null, line, methodName: site.methodName,
        receiverExpr, receiverType, resolved: !!receiverType,
        skipReason: receiverType ? null : resolved.reason, methodInfo,
      });
    }
  }

  callSites.sort((a, b) => a.line - b.line);
  return { callSites, varTypes };
}
