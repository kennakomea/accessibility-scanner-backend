module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  plugins: [
    '@typescript-eslint',
    'prettier'
  ],
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
    'prettier'
  ],
  rules: {
    'prettier/prettier': 'error',
    // Add any project-specific rules here
  },
  env: {
    node: true,
    es2022: true
  },
  overrides: [
    {
      files: ['**/__tests__/**/*', '**/*.spec.ts', '**/*.test.ts'],
      env: {
        jest: true,
      },
    },
  ],
  ignorePatterns: ['node_modules', 'dist', 'coverage', '.eslintrc.js', 'jest.config.js']
}; 