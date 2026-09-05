import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import noRawErrorMessage from '../eslint-rules/no-raw-error-message.js'
import noDuplicateInterfaceName from '../eslint-rules/no-duplicate-interface-name.js'
import noDeadDisabledTitle from '../eslint-rules/no-dead-disabled-title.js'
import noUnguardedCapabilityMenuItem from '../eslint-rules/no-unguarded-capability-menu-item.js'

export default tseslint.config(
  {
    ignores: ['dist', 'node_modules'],
  },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
      local: {
        rules: {
          'no-raw-error-message': noRawErrorMessage,
          'no-duplicate-interface-name': noDuplicateInterfaceName,
          'no-dead-disabled-title': noDeadDisabledTitle,
          'no-unguarded-capability-menu-item': noUnguardedCapabilityMenuItem,
        },
      },
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
      '@typescript-eslint/no-empty-object-type': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': 'off',
      'no-case-declarations': 'off',
      'no-extra-boolean-cast': 'off',
      'no-useless-escape': 'off',

      // Keep user-facing errors behind the shared error-message helper.
      'local/no-raw-error-message': 'error',

      // Prevent TypeScript declaration merging from hiding incompatible API
      // response shapes.
      'local/no-duplicate-interface-name': 'error',

      // A disabled element does not expose its native title tooltip. Keep
      // this as a warning until every ambiguous case has been reviewed.
      'local/no-dead-disabled-title': 'warn',

      // Radix menu items are not native buttons, so `disabled` does not stop
      // every click path. Keep this as a warning while existing call sites
      // are reviewed.
      'local/no-unguarded-capability-menu-item': 'warn',
    },
  },
)
