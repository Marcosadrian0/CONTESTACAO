// Configuração do Playwright Test para a suíte de regressão em tests/.
// Sem passo de build: sobe o próprio index.html com um servidor estático simples.
const { defineConfig, devices } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './tests',
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: 'http://localhost:4173',
    trace: 'retain-on-failure',
    actionTimeout: 8000,
    navigationTimeout: 15000,
  },
  webServer: {
    command: 'python3 -m http.server 4173',
    url: 'http://localhost:4173/index.html',
    reuseExistingServer: !process.env.CI,
    timeout: 20000,
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
});
