import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import noRawErrorMessage from '../../scripts/eslint-rules/no-raw-error-message.js'
import noDuplicateInterfaceName from '../../scripts/eslint-rules/no-duplicate-interface-name.js'
import noDeadDisabledTitle from '../../scripts/eslint-rules/no-dead-disabled-title.js'

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

      // The design system is coss ui on Base UI. Colors come from theme
      // tokens (styles/theme.css), not one-off values in class names.
      'no-restricted-imports': ['error', { patterns: [{ group: ['@radix-ui/*'], message: 'Use the coss component in components/ui.' }] }],
      'no-restricted-syntax': [
        'error',
        {
          selector: 'JSXAttribute[name.name="className"] :matches(Literal[value=/-\\[(#|rgba?\\(|hsla?\\(|oklch\\()/], TemplateElement[value.raw=/-\\[(#|rgba?\\(|hsla?\\(|oklch\\()/])',
          message: 'Use a theme color token instead of an arbitrary color value.',
        },
      ],
    },
  },
)
