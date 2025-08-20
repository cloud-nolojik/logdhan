import js from '@eslint/js';
import prettier from 'eslint-plugin-prettier/recommended';

export default [
  js.configs.recommended,
  prettier,
  {
    ignores: [
      'node_modules/',
      'dist/',
      'coverage/',
      '.env',
      '.env.*',
      '*.log'
    ],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        process: 'readonly'
      }
    },
    env: {
      node: true,
      es2021: true,
      jest: true
    },
    rules: {
      'no-console': 'warn',
      'no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      'prettier/prettier': 'error'
    }
  }
]; 