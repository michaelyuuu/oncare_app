# iPad kiosk setup

## Network prerequisite

Put the iPad and the development machine on the same LAN. Open the resident preview by using the development machine's LAN IP (for example, `http://192.168.1.25:4173`), never `localhost`: on the iPad, `localhost` means the iPad itself.

The resident client consumes `VITE_API_BASE`. For this same-origin `/api` recipe, leave it unset so the Vite preview proxy sends traffic from the development machine to the API. Do **not** set it to `http://<lan-ip>:3000` unless the API has CORS configured: direct browser calls are otherwise blocked, and the demo API intentionally does not provide CORS.

## Build and serve on the LAN

In PowerShell at the repository root, set the proxy target and build the resident app. For the ordinary demo API, use port 3000:

```powershell
$env:ONCARE_API_PROXY_TARGET = 'http://127.0.0.1:3000'
npm run build -w @oncare/resident
npm run preview -w @oncare/resident -- --host
```

The preview command reports its port (normally 4173). Use that port with the development machine's LAN IP on the iPad. Keep the API running on the same machine. If the API uses another local port, set `ONCARE_API_PROXY_TARGET` to that port before both commands.

## Add the resident app to the Home Screen

1. In iPad Safari, open `http://<lan-ip>:<preview-port>`.
2. Tap **Share**, then **Add to Home Screen**, and add the app.

## Enable Guided Access

1. Go to **Settings > Accessibility > Guided Access**, turn it on, and set a passcode.
2. Open the Home-Screen resident app and triple-click the side button.
3. Start Guided Access. Disabling touch over the bottom-left logo is not required: the app protects its device settings with a PIN.

## Enter the device token once

On a newly installed kiosk, open Settings; it is editable until a token has been saved. Paste `1234` and save it. On a configured kiosk, press and hold the bottom-left logo for three seconds, enter the demo staff PIN `2468`, then paste or replace the token. The app validates a new token before saving it locally.

## Exit Guided Access

Triple-click the side button, enter the Guided Access passcode, and select **End**.

## Known limit for the demo

Safari can pause audio or video when the screen locks. Set **Settings > Display & Brightness > Auto-Lock** to **Never** for the rehearsal, then restore the facility's normal policy afterward.
