
export function parseClass(buf) {
  let p = 0;
  const u1 = () => buf[p++];
  const u2 = () => {
    const v = buf.readUInt16BE(p);
    p += 2;
    return v;
  };
  const u4 = () => {
    const v = buf.readUInt32BE(p);
    p += 4;
    return v;
  };

  const magic = u4();
  if (magic !== 0xcafebabe) {
    throw new Error("not a Java class file (bad magic number)");
  }
  u2();
  u2();

  const cpCount = u2();
  const cp = new Array(cpCount);
  for (let i = 1; i < cpCount; i++) {
    const tag = u1();
    switch (tag) {
      case 1: {
        const len = u2();
        const bytes = buf.slice(p, p + len);
        p += len;
        cp[i] = { tag, value: bytes.toString("utf8") };
        break;
      }
      case 7:
      case 8:
      case 16:
      case 19:
      case 20:
        cp[i] = { tag, ref: u2() };
        break;
      case 15:
        cp[i] = { tag, refKind: u1(), ref: u2() };
        break;
      case 9:
      case 10:
      case 11:
      case 12:
      case 17:
      case 18:
        cp[i] = { tag, ref1: u2(), ref2: u2() };
        break;
      case 3:
      case 4:
        cp[i] = { tag, val: u4() };
        break;
      case 5:
      case 6:
        cp[i] = { tag, val: u4() * 2 ** 32 + u4() };
        i++;
        break;
      default:
        throw new Error(`unknown constant pool tag ${tag} at index ${i}`);
    }
  }

  const utf8 = (idx) => (cp[idx] && cp[idx].tag === 1 ? cp[idx].value : null);
  const className = (idx) => (cp[idx] && cp[idx].tag === 7 ? utf8(cp[idx].ref) : null);

  u2();
  const thisClass = className(u2());
  const superClass = className(u2());

  const ifaceCount = u2();
  const interfaces = [];
  for (let i = 0; i < ifaceCount; i++) interfaces.push(className(u2()));

  function skipAttributes() {
    const count = u2();
    for (let i = 0; i < count; i++) {
      u2();
      const len = u4();
      p += len;
    }
  }

  const fieldsCount = u2();
  const fields = [];
  for (let i = 0; i < fieldsCount; i++) {
    u2();
    const nameIdx = u2();
    const descIdx = u2();
    fields.push({ name: utf8(nameIdx), descriptor: utf8(descIdx) });
    skipAttributes();
  }

  const methodsCount = u2();
  const methods = [];
  for (let i = 0; i < methodsCount; i++) {
    const accessFlags = u2();
    const nameIdx = u2();
    const descIdx = u2();
    methods.push({ name: utf8(nameIdx), descriptor: utf8(descIdx), accessFlags });
    skipAttributes();
  }

  const classAnnotations = [];
  {
    const attrCount = u2();
    for (let i = 0; i < attrCount; i++) {
      const nameIdx = u2();
      const attrName = utf8(nameIdx);
      const len = u4();
      const attrEnd = p + len;
      if (attrName === "RuntimeVisibleAnnotations") {
        const numAnnotations = u2();
        for (let a = 0; a < numAnnotations; a++) {
          classAnnotations.push(parseAnnotation());
        }
      } else {
        p = attrEnd;
      }
      p = attrEnd;
    }
  }

  function parseElementValue() {
    const tag = String.fromCharCode(u1());
    switch (tag) {
      case "s": // String
        return utf8(u2());
      case "e": {
        u2();
        return utf8(u2());
      }
      case "c": // class_info_index
        return className(u2()) || utf8(u2());
      case "@":
        return parseAnnotation();
      case "[": {
        const count = u2();
        const arr = [];
        for (let i = 0; i < count; i++) arr.push(parseElementValue());
        return arr;
      }
      case "Z":
      case "B":
      case "C":
      case "S":
      case "I": {
        const idx = u2();
        return cp[idx] ? cp[idx].val : null;
      }
      case "J":
      case "F":
      case "D": {
        const idx = u2();
        return cp[idx] ? cp[idx].val : null;
      }
      default:
        u2();
        return null;
    }
  }

  function parseAnnotation() {
    const typeIdx = u2();
    const type = utf8(typeIdx);
    const numPairs = u2();
    const elements = {};
    for (let i = 0; i < numPairs; i++) {
      const nameIdx = u2();
      const name = utf8(nameIdx);
      elements[name] = parseElementValue();
    }
    return { type, elements };
  }

  return { thisClass, superClass, interfaces, fields, methods, classAnnotations, constantPool: cp };
}

export function hasMethod(classInfo, methodName) {
  return classInfo.methods.some((m) => m.name === methodName);
}

export function listMethodRefs(classInfo) {
  const cp = classInfo.constantPool;
  const utf8 = (idx) => (cp[idx] && cp[idx].tag === 1 ? cp[idx].value : null);
  const className = (idx) => (cp[idx] && cp[idx].tag === 7 ? utf8(cp[idx].ref) : null);
  const refs = [];
  for (let i = 1; i < cp.length; i++) {
    const entry = cp[i];
    if (!entry || (entry.tag !== 10 && entry.tag !== 11)) continue;
    const ownerClass = className(entry.ref1);
    const nameAndType = cp[entry.ref2];
    if (!nameAndType) continue;
    refs.push({
      ownerClass,
      name: utf8(nameAndType.ref1),
      descriptor: utf8(nameAndType.ref2),
    });
  }
  return refs;
}
