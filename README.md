# Broken Links — a Contentful App

A Page-location Contentful app that scans every currently-published entry in a space and flags **required link fields** (single `Link` or `Array<Link>`) whose target is:

- **deleted** — the linked entry/asset no longer exists,
- **archived** — the target is archived (not reachable via the delivery API), or
- **unpublished** — the target exists but has no published version.

Optional link fields are intentionally ignored — only required-link violations are reported.

Results stream into a table as the scan runs (newest-edited entries first), so you can start fixing things before the scan finishes.

## Install in your own Contentful org

1. **Clone & install:**
   ```bash
   git clone https://github.com/betabong/contentful-broken-links.git
   cd contentful-broken-links
   npm install
   ```

2. **Register the app definition in your Contentful organization:**
   ```bash
   npm run create-app-definition
   ```
   Answer the prompts:
   - **App name:** `Broken Links`
   - **Locations:** select **Page** only
   - **Frontend URL:** leave as `http://localhost:3000` for now (you'll change it after hosting)
   - **CMA endpoint:** `api.contentful.com` (or `api.eu.contentful.com` if your space is in the EU region)
   - **App Parameter schemas:** `N`

3. **Build and host the bundle on Contentful's CDN** (free, no server needed):
   ```bash
   npm run build
   npm run upload
   ```
   When prompted, attach the bundle to the app definition you just created and activate it. The app definition's Frontend URL will switch from `localhost` to the hosted bundle automatically.

4. **Install the app into a space:** in Contentful, go to **Apps → Manage apps → Private apps**, find *Broken Links*, click **Install**, pick the space + environment.

5. Open the space — **Broken Links** appears in the left sidebar under Apps.

### App icon (optional)

A square 256×256 PNG works best. Upload it from **Organization settings → Apps → Broken Links → General → App icon**.

## Local development

```bash
npm install
npm start          # serves on http://localhost:3000
```

In your app definition (Contentful UI), temporarily set **Frontend URL** to `http://localhost:3000`, reload the Page location, and you'll see your local code. Switch back to the hosted bundle when you're done.

## How the scan works

- **Type:** Page-location app (lives in the space sidebar under "Apps").
- **Stack:** Vite + React 18 + TypeScript + [Forma 36](https://f36.contentful.com/).
- **API:** Content Management API via `useCMA()` from `@contentful/react-apps-toolkit`. All requests are auto-scoped to the current space + environment.

The scan is **streaming and newest-first**:

1. Load all content types; index the required link fields per type.
2. Page through currently-published entries (`sys.publishedAt[exists]=true`) ordered by `-sys.updatedAt` (most recently edited first).
3. For each page: collect link refs → resolve only the target IDs not yet in cache (batches of 100, with a second `sys.archivedAt[exists]=true` pass to catch archived targets) → emit broken refs to the UI immediately.
4. Classification: missing → `deleted`, has `sys.archivedVersion` → `archived`, no `sys.publishedVersion` → `unpublished`.

Per-target state cache means each linked entry/asset is fetched at most once across the scan, even when referenced by many entries.

## Notes & limitations

- **Required = the field's `required: true` flag in the content model.** For `Array<Link>` fields this means the array must be non-empty; we still check every link in the array.
- **Localized fields:** every locale present on a field is scanned; the offending locale is reported in the table.
- **Display titles:** uses the content type's `displayField` (first locale found). Falls back to the entry ID.
- **Scale:** scans run client-side and can take several minutes on large spaces. The CMA proxy handles rate-limiting/back-off transparently. Hit **Stop** any time.
- **Permissions:** the app uses the current user's CMA token. Users without read access to certain content types/entries may see a subset of results.

## License

[MIT](./LICENSE)
