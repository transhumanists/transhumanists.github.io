import { defineConfig } from '@playwright/test';

// Layout facts are asserted, not pixels. A screenshot baseline would need a human to
// sign off on the current appearance, and it would then fail on every legitimate
// restyle; measuring the frame, the legend bounds and the computed styles catches the
// same class of bug without either cost. Screenshots are still written, as CI
// artifacts, so a human can look when they want to.
export default defineConfig({
  // e2e/ rather than test/: the browser specs need a real browser, and `bun test
  // test/` globs everything under test/. The obvious alternative - excluding them with
  // --path-ignore-patterns - does not work, because Bun 1.2.14, the version CI pins,
  // ignores that flag and runs them anyway.
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  reporter: process.env.CI ? [['github'], ['list']] : [['list']],
  outputDir: './test-results/browser',
  use: {
    baseURL: 'http://127.0.0.1:8788',
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'desktop', use: { viewport: { width: 1440, height: 900 } } },
    { name: 'phone', use: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } },
  ],
  webServer: {
    // A plain static server: the fixture is real HTML, so no Jekyll is needed and the
    // checks run identically on a laptop and on a Linux runner.
    command: 'python -m http.server 8788 --bind 127.0.0.1',
    url: 'http://127.0.0.1:8788/e2e/fixture.html',
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
});