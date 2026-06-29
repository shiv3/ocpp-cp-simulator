module.exports = {
  root: true,
  env: { browser: true, es2020: true },
  extends: [
    "eslint:recommended",
    "plugin:@typescript-eslint/recommended",
    "plugin:react-hooks/recommended",
    "prettier",
  ],
  ignorePatterns: ["dist", ".eslintrc.cjs"],
  parser: "@typescript-eslint/parser",
  plugins: ["react-refresh"],
  rules: {
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
  },
  overrides: [
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
  ],
};
