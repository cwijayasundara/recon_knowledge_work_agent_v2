import tseslint from "typescript-eslint";
export default tseslint.config(
  ...tseslint.configs.recommended,
  {
    // Workbook data must never reach a log: no console in src; src/main.tsx alone may use console.warn.
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "no-console": "error",
      "no-restricted-syntax": ["error", { selector: "MemberExpression[property.name='innerHTML']", message: "Use text nodes; workbook text is untrusted." }],
    },
    files: ["src/**/*.{ts,tsx}"],
  },
  { files: ["src/main.tsx"], rules: { "no-console": ["error", { allow: ["warn"] }] } },
  { ignores: ["dist", "node_modules", "coverage"] },
);
