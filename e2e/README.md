# Browser demo story

The Playwright spec follows the handover demo across the family app (`5174`), resident kiosk (`5173`), and staff console (`5175`). The config starts the local Vite/API stack and the synthetic mock gateway; the gateway process uses `robot-demo-token` and `ROBOT_ADAPTER=mock`.

Install the optional browser test dependency and Chromium in an environment with the required package cache/network, then run `npm run e2e`. If `@playwright/test` or Chromium is unavailable, the e2e run is intentionally skipped and must be reported as not run; no browser binaries are committed. The media annotation distinguishes a real LiveKit video track from the call-screen-only path.
