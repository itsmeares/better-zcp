import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";
import requireResultHandling from "../../scripts/eslint-rules/require-result-handling.js";

export default [
  {
    ignores: [
      "node_modules/**",
      "dist/**",
      "build/**",
      "release/**",
      "coverage/**",
      "*.cjs",
    ],
  },
  {
    files: ["**/*.{js,ts,mts}"],
    plugins: {
      local: { rules: { "require-result-handling": requireResultHandling } },
    },
    languageOptions: {
      parser: tseslint.parser,
      ecmaVersion: 2023,
      sourceType: "module",
      globals: {
        ...globals.node,
        PANEL_VERSION: "readonly",
        PANEL_BUILD_SHA: "readonly",
        PANEL_API_CONTRACT_VERSION: "readonly",
        PANEL_BRIDGE_LUA_B64: "readonly",
        PANEL_CLIENT_DIST_B64: "readonly",
      },
    },
    rules: {
      ...js.configs.recommended.rules,

      // Much of this codebase reports failure by returning { success: false }
      // rather than by throwing, so a discarded result is a swallowed error.
      "local/require-result-handling": "error",

      // Control chars in regexes are deliberate input sanitization (RCON args,
      // player names, PanelBridge payloads).
      "no-control-regex": "off",

      "no-unused-vars": [
        "warn",
        {
          args: "after-used",
          argsIgnorePattern: "^(_|next$|serverName$|reason$|skipLog$)",
          varsIgnorePattern: "^_",
          caughtErrors: "none",
        },
      ],

      // Per-request and per-socket objects make this rule too noisy here.
      "require-atomic-updates": "off",

      // Escaping `-` and `[` inside character classes is deliberate defensive
      // style here; rewriting 20 working regexes would risk real bugs.
      "no-useless-escape": "off",

      "no-empty": ["warn", { allowEmptyCatch: false }],
      "no-fallthrough": "error",
      "no-constant-condition": ["error", { checkLoops: false }],
      "no-unsafe-optional-chaining": "error",
      "no-self-compare": "error",
      "no-template-curly-in-string": "warn",
      "no-unmodified-loop-condition": "error",
      // Express handlers and service interfaces intentionally remain async,
      // including paths that do not await on every code path.
      "require-await": "off",
    },
  },
  {
    files: ["**/*.ts"],
    rules: {
      // TypeScript's compiler owns type names and declaration merging.
      "no-undef": "off",
      "no-redeclare": "off",
      "no-unused-vars": "off",
    },
  },
  {
    files: ["tests/**/*.{ts,mts}"],
    rules: {
      // A test calls these for their effect on a stub, not for the result.
      "local/require-result-handling": "off",
      "require-await": "off",
      // Test doubles often mirror a wider production interface than the
      // assertion needs, so unused parameters/imports are not useful here.
      "no-unused-vars": "off",
      "no-template-curly-in-string": "off",
    },
  },
];
