const eslintPluginPrettierRecommended = require('eslint-plugin-prettier/recommended');
const tseslint = require('typescript-eslint');

module.exports = tseslint.config(
  {
    ignores: ['node_modules', 'dist', 'coverage', 'eslint.config.js', '**/dist/*', '**/node_modules/*', '**/coverage/*']
  },
  {
    files: ['**/*.ts', '**/*.tsx'],
    extends: [
      ...tseslint.configs.recommended,
      eslintPluginPrettierRecommended
    ],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        project: true,
        tsconfigRootDir: __dirname,
      },
    },
    rules: {
      // Add any project-specific rules here
    },
  },
  {
    files: ['**/__tests__/**/*', '**/*.spec.ts', '**/*.test.ts'],
    // You might need to configure Jest specific things here if you use Jest globals
    // For example, by using eslint-plugin-jest
  }
); 