import { describe } from 'vitest'
import { RuleTester } from 'eslint'
import tseslint from 'typescript-eslint'
// @ts-expect-error -- plain JS rule module, no type declarations
import rule from '../../../../../scripts/eslint-rules/no-duplicate-interface-name.js'

const ruleTester = new RuleTester({
  languageOptions: {
    ecmaVersion: 2023,
    sourceType: 'module',
    parser: tseslint.parser,
  },
})

// scripts/eslint-rules/no-duplicate-interface-name.js: the structural fix for the
// 2026-08-27 api.ts type-architecture survey's Finding 1 -- api.ts declared
// `export interface BackupFile` twice, for two unrelated real shapes
// (server-files/backups' {filename,size,created} vs backup.js's
// {name,path,size,created}), and TypeScript's declaration merging silently
// unioned them into one type requiring all five fields. `tsc -b --noEmit`
// reported zero errors on it -- this rule is what now catches that class of
// collision, as a real AST check (TSInterfaceDeclaration), not a regex.
describe('local/no-duplicate-interface-name', () => {
  ruleTester.run('no-duplicate-interface-name', rule, {
    valid: [
      // A single declaration -- nothing to collide with.
      'export interface Foo { a: string }',

      // Two distinctly-named interfaces -- the fixed api.ts shape
      // (ConfigBackupFile / ServerBackupArchive).
      'export interface ConfigBackupFile { filename: string; size: number; created: string }\nexport interface ServerBackupArchive { name: string; path: string; size: number; created: string }',

      // `extends` is deliberate composition, not a same-name collision --
      // a different AST shape (an Identifier in the extends clause, not a
      // second TSInterfaceDeclaration named ConfigTemplate).
      'export interface ConfigTemplate { id: string }\nexport interface ConfigTemplateDetail extends ConfigTemplate { content: string }',

      // A non-exported interface isn't the flat-file collision this rule
      // targets -- module-local, not part of the public shape surface.
      'interface Foo { a: string }\ninterface Foo { b: string }',

      // Same name, but only one of the two is actually exported at the top
      // level -- the selector requires `Program > ExportNamedDeclaration >
      // TSInterfaceDeclaration` for BOTH to be seen as a collision.
      'export interface Foo { a: string }\ninterface Foo { b: string }',
    ],
    invalid: [
      {
        // The exact api.ts BackupFile shape before the 2026-08-27 fix.
        code: 'export interface BackupFile { filename: string; size: number; created: string }\nexport interface BackupFile { name: string; path: string; size: number; created: string }',
        errors: [{ messageId: 'duplicate' }],
      },
      {
        // Three declarations of the same name -- the second AND third both
        // collide with the first.
        code: 'export interface Foo { a: string }\nexport interface Foo { b: string }\nexport interface Foo { c: string }',
        errors: [{ messageId: 'duplicate' }, { messageId: 'duplicate' }],
      },
      {
        // Identical field sets doesn't make it safe -- still two
        // declarations claiming the same name, still worth a rename.
        code: 'export interface Foo { a: string }\nexport interface Foo { a: string }',
        errors: [{ messageId: 'duplicate' }],
      },
    ],
  })
})
