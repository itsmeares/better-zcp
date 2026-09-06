/**
 * TypeScript merges same-named interface declarations in one file into a
 * single type carrying every field from every declaration. If two
 * declarations are meant to describe two DIFFERENT real shapes (rather than
 * deliberately extending one shape across two blocks), the merged type
 * silently claims fields neither producer actually returns, and nothing --
 * not tsc, not a test, not a reviewer skimming a 3000-line file -- notices.
 *
 * Real case (2026-08-27): apps/panel-client/src/lib/api.ts declared `BackupFile` twice
 * -- once for server-files/backups' config-file .bak shape
 * ({filename,size,created}), once for backup.js's full .zip shape
 * ({name,path,size,created}) -- and tsc happily merged them into one type
 * requiring all five fields, non-optional. `tsc -b --noEmit` reported zero
 * errors on it. See ConfigBackupFile/ServerBackupArchive in api.ts for the
 * fix.
 *
 * This rule flags a second top-level exported `interface Name` for a name
 * already declared earlier in the same file. It does not flag `extends`
 * (that's deliberate composition, a different AST shape) or a
 * non-top-level/non-exported interface (declaration merging across scopes
 * is a different, much rarer situation than the flat-file case this rule
 * targets).
 */

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
