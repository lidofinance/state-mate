import path from "node:path";
import { fileURLToPath } from "node:url";

import { includeIgnoreFile } from "@eslint/compat";
import tseslint from "@typescript-eslint/eslint-plugin";
import tsParser from "@typescript-eslint/parser";
import importPlugin from "eslint-plugin-import";
import prettierRecommended from "eslint-plugin-prettier/recommended";
import eslintPluginUnicorn from "eslint-plugin-unicorn";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const gitignorePath = path.resolve(__dirname, ".gitignore");

export default [
  ...tseslint.configs["flat/recommended"],
  prettierRecommended,
  importPlugin.flatConfigs.recommended,
  importPlugin.flatConfigs.typescript,
  eslintPluginUnicorn.configs.recommended,

  includeIgnoreFile(gitignorePath),
  {
    // CommonJS entrypoints: no top-level await, main().catch() is the pattern
    files: ["src/state-mate.ts", "src/gen-schemas.ts"],
    rules: {
      "unicorn/prefer-top-level-await": "off",
      "unicorn/prefer-await": "off",
    },
  },
  {
    languageOptions: {
      parser: tsParser,
      ecmaVersion: 2022,
      sourceType: "module",
    },
    settings: {
      "import/resolver": {
        typescript: {
          project: "./tsconfig.json",
        },
      },
    },
    rules: {
      "unicorn/no-null": "off",
      "unicorn/prefer-module": "off",
      "unicorn/no-process-exit": "off",
      "unicorn/no-object-as-default-parameter": "off",
      // unicorn v69 migration: opinionated new rules that conflict with the codebase style
      "unicorn/max-nested-calls": "off", // chalk calls inside template literals
      "unicorn/no-top-level-assignment-in-function": "off", // g_* module-level state is deliberate
      "unicorn/no-break-in-nested-loop": "off", // flags mandatory breaks of a switch inside a loop
      "unicorn/no-top-level-side-effects": "off", // CLI entrypoints
      "unicorn/consistent-boolean-name": "off", // its is*-prefix autofix produces worse names (reverted in review)
      "unicorn/consistent-function-scoping": "off",
      "@typescript-eslint/no-explicit-any": ["warn"],
      "@typescript-eslint/no-unused-vars": ["warn"],
      "import/no-unresolved": ["warn"],
      "import/no-absolute-path": ["warn"],
      "import/no-duplicates": ["warn"],
      "@typescript-eslint/no-unused-vars": ["warn", { varsIgnorePattern: "^_" }],
      "import/order": [
        "warn",
        {
          groups: ["builtin", "external", "internal", ["parent", "sibling", "index"]],
          "newlines-between": "always",
          alphabetize: {
            order: "asc",
            caseInsensitive: true,
          },
        },
      ],
    },
  },
];
