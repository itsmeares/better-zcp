
export default {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow declaring the same top-level exported interface name more than once in a file",
    },
    schema: [],
    messages: {
      duplicate:
        "'{{name}}' is exported as an interface more than once in this file (first declared at line {{firstLine}}). TypeScript silently merges same-named interfaces into one type requiring every field from both -- if the two declarations describe two different real shapes, give them distinct names instead (see this rule's file header for the api.ts BackupFile case this is modeled on).",
    },
  },

  create(context) {
    const seen = new Map();

    return {
      "Program > ExportNamedDeclaration > TSInterfaceDeclaration"(node) {
        const name = node.id.name;
        const firstLine = seen.get(name);
        if (firstLine) {
          context.report({
            node: node.id,
            messageId: "duplicate",
            data: { name, firstLine: String(firstLine) },
          });
        } else {
          seen.set(name, node.loc.start.line);
        }
      },
    };
  },
};
