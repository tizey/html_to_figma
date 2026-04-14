# Site to Figma

Figma plugin + capture service that takes a website URL, renders it at either `390px` mobile or `1440px` desktop width, and rebuilds the result in Figma as editable rectangles, text layers, and image fills.

This repo is intentionally split into two parts:

1. `plugin/` contains the Figma plugin manifest and bundled plugin assets.
2. `src/service/` contains a Playwright-based capture service that opens the website, extracts a structured snapshot, proxies image assets, and returns JSON for the plugin to rebuild.

That split is what makes the plugin reusable for your team instead of being tied to one laptop: the Figma plugin can stay the same, and your colleagues can all point it to a shared capture service URL.

## What the MVP does

- Paste a URL in the Figma plugin UI.
- Choose `Screenshot` for visual fidelity or `Editable` for experimental layer reconstruction.
- Pick `390px Mobile` or `1440px Desktop`.
- Send the URL to the capture service.
- In `Screenshot` mode, import the whole page as a visually accurate long screenshot. Tall pages are automatically split into stacked image slices so Figma can import them safely.
- In `Editable` mode, reconstruct the visible DOM into:
  - editable text nodes
  - rectangles with fills, borders, and radius
  - image-backed rectangles for `<img>` and simple `background-image: url(...)`

## What the MVP does not fully solve yet

- Perfect HTML-to-Figma parity for complex CSS.
- SVG vector reconstruction.
- Pseudo-elements, video, canvas, Lottie, and advanced shadows/filters.
- Authenticated/private pages without an additional browser extension or login-aware capture flow.

For a product on the level of `html.to.design`, you usually need more than a Figma plugin alone. The hard part is the capture pipeline, not the Figma UI. This repo gives you a solid internal MVP and a codebase you can keep improving.

## Local setup

### 1. Install dependencies

```bash
npm install
```

If PowerShell blocks `npm`, use `npm.cmd` instead.

### 2. Install Chromium for Playwright

```bash
npm run install:browser
```

### 3. Build the plugin bundle

```bash
npm run build:plugin
```

### 4. Start the capture service

```bash
npm run dev:service
```

The service starts on `http://localhost:3210`.

`dev:service` now runs the compiled Node service directly, because `tsx watch` can break `page.evaluate(...)` serialization in Playwright and cause errors such as `__name is not defined`.

If you want TypeScript watch mode while developing the service itself, run this in a second terminal:

```bash
npm run watch:service
```

If Figma shows a manifest validation error for `devAllowedDomains`, use `localhost` rather than `127.0.0.1` for local development.

### 5. Load the plugin into Figma

1. Open Figma Desktop.
2. Go to `Plugins > Development > Import plugin from manifest...`
3. Select [plugin/manifest.json](plugin/manifest.json)

Once loaded, the plugin UI will default to `http://localhost:3210`, but you can change that in the form if you deploy the service elsewhere.

## Deploy the capture service on Railway

If you want coworkers or the public to use this plugin, the easiest first step is to deploy only the capture service and keep the Figma plugin loaded from `manifest.json`.

This repo now includes a production `Dockerfile`, so Railway can build it directly.

### 1. Push this project to GitHub

Create a GitHub repository and upload the whole project.

### 2. Create a Railway project

1. Go to [Railway](https://railway.app/)
2. Sign in
3. Click `New Project`
4. Choose `Deploy from GitHub repo`
5. Select this repository

Railway should detect the `Dockerfile` automatically and build the service.

### 3. Wait for the deploy to finish

When the deploy is green, open the service and generate a public domain in Railway.

After you get the HTTPS URL, open this in your browser:

```text
https://your-railway-domain.up.railway.app/health
```

If everything is working, you should see:

```json
{"ok":true}
```

### 4. Use that URL in the plugin

Open the Figma plugin and paste your Railway URL into `Capture Service` instead of `http://localhost:3210`.

Example:

```text
https://your-railway-domain.up.railway.app
```

Now the plugin will use the hosted capture service instead of your laptop.

### 5. Share the plugin with coworkers

For a simple internal rollout:

1. Send coworkers the plugin files or the repo
2. Tell them to open Figma Desktop
3. Go to `Plugins > Development > Import plugin from manifest...`
4. Select `plugin/manifest.json`
5. Paste your Railway URL into the `Capture Service` field

That is enough for a team rollout without publishing to Community yet.

## Build outputs

- Plugin bundle: `plugin/dist/code.js` and `plugin/dist/ui.html`
- Service bundle: `service/dist/service/index.js`

To build everything:

```bash
npm run build
```

## Team rollout

For colleagues, the cleanest setup is:

1. Deploy the capture service to one shared HTTPS domain.
2. Keep the same Figma plugin for everyone.
3. Set the service URL inside the plugin UI to that shared endpoint.

Because this plugin imports arbitrary websites, the manifest currently uses `networkAccess.allowedDomains = ["*"]`. That is convenient for an internal tool. If you decide to publish this externally, you will probably want to tighten the network policy and move more asset fetching behind your capture service domain.

## Suggested next improvements

1. Add a Chrome extension for authenticated/private pages and richer DOM capture.
2. Add reusable component detection so repeated cards/buttons map to component sets in Figma.
3. Add an update flow that re-imports into an existing selected frame.
4. Capture spacing/layout groups and convert them into Auto Layout instead of only absolute positioning.
5. Add a persistence layer for queued captures, rate limiting, and caching.
