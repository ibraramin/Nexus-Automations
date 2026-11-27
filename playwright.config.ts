import { defineConfig, devices } from "@playwright/test";

/**
 * E2E against the SHIPPED artifact, not a Next.js dev/SSR server.
 *
 * `next.config.ts` keeps `output: "export"`, so `npm run build` writes plain
 * HTML/CSS/JS into `out/`. Playwright's webServer serves that directory over
 * loopback with Python's stdlib http.server — no app/api route, no live URL and
 * no external service are involved. Run `npm run build` before these tests.
 */
const port = 4173;
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: "list",
  use: {
    baseURL,
    viewport: { width: 1280, height: 720 },
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: `python3 -m http.server ${port} --bind 127.0.0.1 --directory out`,
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
});
