import { defineConfig } from 'cypress';

// `npm run test:e2e` passes baseUrl and the API's address for each run.
export default defineConfig({
  e2e: {
    specPattern: 'cypress/e2e/**/*.cy.ts',
    supportFile: false,
    video: false,
  },
});
