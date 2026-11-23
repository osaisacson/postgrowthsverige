# Post-growth Sverige

The website at postgrowthsverige.se. It is an Obsidian-style site with a section menu on the left, the page in the middle, and a green link graph on the right. It has a built-in editor at `/admin`.

It runs entirely on Cloudflare's free plan:

- **Cloudflare Pages** serves the site (`public/`) and the small API (`functions/`).
- **Cloudflare D1** (SQLite) stores sections, pages, settings and uploaded files. Files are split into 1 MB chunks, so R2 isn't needed. R2 would need a card on file.

## Writing content

- Go to `/admin` and log in. In the left menu, **Ny sektion** adds a section. The **+** next to a section adds a page, and **⋯** renames, moves or deletes it (both show on hover). Pages are edited in place with live preview; the page's top-right **⋯** menu has TOC, rename, move and delete.
- On a page, **Redigera** opens the Markdown editor with a live preview. It saves automatically.
- `[[Page name]]` links to a page, and `[[Page name|text]]` shows different link text. Typing `[[` suggests page names.
- Drag in or paste an image to upload it, which inserts `![[image.png]]`. `![[image.png|300]]` sets the width.
- The table of contents appears by itself when a page has headings. To turn it off for one page, use **⋯** at the top right of the page. The same menu has rename, move, show backlinks, make home page and delete.
- A link to a page that doesn't exist yet shows faded. As admin, click it to create the page.

## Development

```sh
npm install
npx wrangler d1 execute postgrowthsverige --local --file schema.sql
# .dev.vars (not committed):
#   ADMIN_EMAIL="you@example.com"
#   ADMIN_PASSWORD_HASH="$(node scripts/hash-password.mjs 'password')"
#   SESSION_SECRET="<random string>"
npx wrangler pages dev --port 8788
```

## Deploying (first time)

```sh
export CLOUDFLARE_API_TOKEN=...   # Pages:Edit, D1:Edit, (DNS:Edit for the custom domain)
export CLOUDFLARE_ACCOUNT_ID=...
npx wrangler d1 create postgrowthsverige            # put the database_id in wrangler.toml
npx wrangler d1 execute postgrowthsverige --remote --file schema.sql
npx wrangler pages project create postgrowthsverige --production-branch main
npx wrangler pages secret put ADMIN_EMAIL --project-name postgrowthsverige
npx wrangler pages secret put ADMIN_PASSWORD_HASH --project-name postgrowthsverige   # from scripts/hash-password.mjs
npx wrangler pages secret put SESSION_SECRET --project-name postgrowthsverige
npx wrangler pages deploy
```

Later deploys only need `npx wrangler pages deploy`.

**Passwords and admins:** these are managed in the site itself (/admin → Administratörer, Byt lösenord, Glömt lösenordet?). `ADMIN_EMAIL` and `ADMIN_PASSWORD_HASH` only seed the first admin when the admins table is empty. If every admin is locked out, hash a new password with `node scripts/hash-password.mjs 'new password'` and run `UPDATE admins SET password_hash = '<hash>' WHERE email = '<email>'` in the D1 console.

**Importing the Obsidian vault:** `scripts/prepare_import.py` builds `import/` from the vault files. Then run `PGS_EMAIL=... PGS_PASSWORD=... node scripts/import.mjs https://<site>`. The import refuses to run if the site already has pages.
