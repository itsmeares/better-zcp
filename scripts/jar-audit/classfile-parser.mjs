// Minimal Java .class file parser: walks the constant pool and the methods
// table STRUCTURALLY, per the JVM class file format (JVMS 4), rather than
// treating the file as an opaque blob to grep. This is what makes it
// trustworthy where a flat "extract printable strings" pass is not -- a
// strings dump mixes real method names in with every other UTF8 constant in
// the file (log messages, exception text, field names), and there is no way
// to tell them apart after the fact. Reading the methods_count/method_info
// table properly means every name returned here is a genuine declared
// method on the class, nothing else.
//
// Deliberately narrow: this reads just enough of the format to answer "what
// methods (name + descriptor) does this class declare, and what is its
// superclass/interfaces" -- attribute bodies (bytecode, line numbers, etc.)
// are skipped, not parsed. It cannot tell you whether a method is actually
// CALLED correctly (argument types, overload resolution) -- only whether a
// method with that exact name is declared on that exact class.
//
// See scripts/jar-audit/README.md for the technique's limitations.

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
  u2(); // minor, major version -- not needed here

  const cpCount = u2();
  const cp = new Array(cpCount); // 1-indexed; cp[0] is unused
  for (let i = 1; i < cpCount; i++) {
    const tag = u1();
    switch (tag) {
      case 1: {
        // CONSTANT_Utf8
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
        // Class, String, MethodType, Module, Package -- all a single u2 ref
        cp[i] = { tag, ref: u2() };
        break;
      case 15:
        // MethodHandle
        cp[i] = { tag, refKind: u1(), ref: u2() };
        break;
      case 9:
      case 10:
      case 11:
      case 12:
      case 17:
      case 18:
        // Fieldref, Methodref, InterfaceMethodref, NameAndType, Dynamic, InvokeDynamic
        cp[i] = { tag, ref1: u2(), ref2: u2() };
        break;
      case 3:
      case 4:
        // Integer, Float
        cp[i] = { tag, val: u4() };
        break;
      case 5:
      case 6:
        // Long, Double -- these take TWO constant pool slots
        cp[i] = { tag, val: u4() * 2 ** 32 + u4() };
        i++;
        break;
      default:
        throw new Error(`unknown constant pool tag ${tag} at index ${i}`);
    }
  }

  const utf8 = (idx) => (cp[idx] && cp[idx].tag === 1 ? cp[idx].value : null);
  const className = (idx) => (cp[idx] && cp[idx].tag === 7 ? utf8(cp[idx].ref) : null);

  u2(); // access_flags
  const thisClass = className(u2());
  const superClass = className(u2());

  const ifaceCount = u2();
  const interfaces = [];
  for (let i = 0; i < ifaceCount; i++) interfaces.push(className(u2()));

  function skipAttributes() {
    const count = u2();
    for (let i = 0; i < count; i++) {
      u2(); // attribute_name_index
      const len = u4();
      p += len; // attribute body -- not needed for this tool's purpose
    }
  }

  const fieldsCount = u2();
  const fields = [];
  for (let i = 0; i < fieldsCount; i++) {
    u2(); // access_flags
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

  // Class-level RuntimeVisibleAnnotations (used by the RCON command classes:
  // @CommandName, @CommandArgs, @AltCommandArgs, @DisabledCommand,
  // @RequiredCapability). Parsed opportunistically as a flat list of
  // {type, elements} -- element_value parsing covers the shapes this
  // codebase's command classes actually use (const string/enum, and
  // arrays of those); it is not a complete annotation-value parser.
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
        // enum_const_value: type_name_index, const_name_index
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
        // Unknown/unsupported element tag -- skip its index and move on
        // rather than throwing, since this parser only needs to survive
        // the specific annotations this codebase's command classes use.
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

// Resolves every Methodref/InterfaceMethodref constant pool entry into
// {ownerClass, name, descriptor} -- i.e. every method this class's bytecode
// CALLS OUT to (a different question from classInfo.methods, which is what
// the class itself DECLARES). Constant-pool level, so it does not know
// which call sites are actually reachable or how many times each runs --
// see README.md's "what this cannot tell you" section before drawing
// conclusions from presence/absence of a particular call.
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
