# Photo Ferret

A local authoring tool (Express + SQLite; TypeSafe's Jev tags each photo) and a static gallery exported from it and hosted on Cloudflare. `README.md` explains how the parts fit together; `jev-image-album-description.md` documents every Jev question and how each tag is computed.

## Rules
- **Never commit** `.env`, `data/` or the exported folders (`site/`, `site-images/`).
- **Jev costs money per request.** Only re-classify or re-score photos when the owner asks.
- **Don't overwrite** the owner's site title or About text (set in the admin).
- Run `npm run typecheck` and `npm run build` before committing.
- After changing questions or thresholds, update `jev-image-album-description.md` and the About text in `web/index.html` if the explanation changes.
- Machine-specific notes (GitHub account, commit conventions) are in `CLAUDE.local.md`, which isn't committed.
