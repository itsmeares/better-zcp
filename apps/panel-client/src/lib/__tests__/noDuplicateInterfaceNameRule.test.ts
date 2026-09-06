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
        code: 'export interface BackupFile { filename: string; size: number; created: string }\nexport interface BackupFile { name: string; path: string; size: number; created: string }',
        errors: [{ messageId: 'duplicate' }],
      },
      {
        code: 'export interface Foo { a: string }\nexport interface Foo { b: string }\nexport interface Foo { c: string }',
        errors: [{ messageId: 'duplicate' }, { messageId: 'duplicate' }],
      },
      {
        code: 'export interface Foo { a: string }\nexport interface Foo { a: string }',
        errors: [{ messageId: 'duplicate' }],
      },
    ],
  })
})
