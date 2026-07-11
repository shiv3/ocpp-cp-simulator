// @ts-check
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import prettier from "eslint-config-prettier";
import globals from "globals";

// Flat config (ESLint 9). Port of the old .eslintrc.cjs: same recommended sets,
// same custom rules, same per-path overrides.

// #101 class: scenario persistence must go through the scenarioPersistence
// helpers, never straight at the repository / service. Enforced in components.
const restrictedScenarioPersistence = [
  {
    selector:
      "CallExpression[callee.type='MemberExpression'][callee.object.name='scenarioRepository'][callee.property.name='save']",
    message:
      "route scenario persistence through scenarioPersistence helpers (#101 class).",
  },
  {
    selector:
      "CallExpression[callee.type='MemberExpression'][callee.object.name='scenarioRepository'][callee.property.name='load']",
    message:
      "route scenario persistence through scenarioPersistence helpers (#101 class).",
  },
  {
    selector:
      "CallExpression[callee.type='MemberExpression'][callee.object.name='scenarioRepository'][callee.property.name='delete']",
    message:
      "route scenario persistence through scenarioPersistence helpers (#101 class).",
  },
  {
    selector:
      "CallExpression[callee.type='MemberExpression'][callee.object.name='chargePointService'][callee.property.name='loadScenario']",
    message:
      "route scenario persistence through scenarioPersistence helpers (#101 class).",
  },
  {
    selector:
      "CallExpression[callee.type='MemberExpression'][callee.object.name='chargePointService'][callee.property.name='removeScenario']",
    message:
      "route scenario persistence through scenarioPersistence helpers (#101 class).",
  },
];

export default tseslint.config(
  // Only TypeScript sources are linted (matches the old `--ext ts,tsx`); build
  // output and JS config files (vite/tailwind/postcss/this file) are skipped.
  { ignores: ["dist", "**/*.{js,cjs,mjs}"] },

  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,

  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      globals: globals.browser,
    },
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
    },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
      "react-refresh/only-export-components": [
        "warn",
        { allowConstantExport: true },
      ],
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          destructuredArrayIgnorePattern: "^_",
        },
      ],
      // Empty interfaces are intentional here (generated OCPP empty-payload
      // response types, placeholder prop types); keep the rule for misuse of
      // the `{}` type but allow the interface form. Matches pre-ESLint-9 intent.
      "@typescript-eslint/no-empty-object-type": [
        "error",
        { allowInterfaces: "always" },
      ],
      // `cond && sideEffect()` / ternary short-circuits are used in the legacy
      // src/v1 code; allow them as before.
      "@typescript-eslint/no-unused-expressions": [
        "error",
        { allowShortCircuit: true, allowTernary: true },
      ],
    },
  },

  {
    files: ["src/components/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-syntax": ["error", ...restrictedScenarioPersistence],
    },
  },
  {
    files: ["src/components/scenario/scenarioPersistence.ts"],
    rules: { "no-restricted-syntax": "off" },
  },
  {
    files: [
      "src/components/ui/**/*.tsx",
      "src/contexts/**/*.tsx",
      "src/data/providers/**/*.tsx",
      "src/components/ChargePointConfigModal.tsx",
      "src/components/MeterValueCurveModal.tsx",
    ],
    rules: { "react-refresh/only-export-components": "off" },
  },
);
