# CHECKSUM RUSH

[Play on GitHub Pages](https://technoetic.github.io/checksum-rush/)

A Korean90-second arcade about finding changed data with checksums. No login, runtime dependencies, telemetry or external assets. Scores and checkpoints stay in the current browser.

## Controls

| Input | Action |
|---|---|
| A/D or left/right | Select rail |
| Space | Scan nearest unscanned packet |
| J | Block the nearest packet; block only inspected mismatches |
| Shift | Slow traffic for2.5 seconds |
| Escape | Pause, save and quit |
| Mouse | Click rail to scan; right-click to block |
| Touch | Rail selection and scan/block/slow buttons |

SUM4 adds four hexadecimal digits modulo16. It is a teaching abstraction, not TCP checksum, CRC, cryptographic hashing, authentication or error correction. The interactive guide shows a collision; gameplay corruption always changes the checksum for fair decisions.

## Run and test

Node24+, no dependencies to install:

```sh
npm test
npm run build -- --base /checksum-rush/
npm start -- --base /checksum-rush/ --port 8792
```

Open `http://127.0.0.1:8792/checksum-rush/`. For root hosting, omit `--base` for both build and server. Home/play/guide/results use shareable hash URLs. Mission fetches are abortable/time-bounded; failed saves retain progress. An executing document keeps its embedded build ID; changed deployments are applied on the next clean full-document navigation after protecting active rounds and saves.

## Deploy

Push `main` to run the pinned GitHub Pages Actions workflow: tests → project-path build → retain older asset graphs → upload → deploy. `.nojekyll` is included. The `gh-pages` branch archives static assets so CDN-cached older HTML can still boot; deployment uses Actions, not branch-source serving. Do not manually delete archived assets without considering cached HTML and open clients.

GitHub Pages controls response caching. The generated `_headers` file does not override Pages CDN headers. Fresh version requests include a cache-busting query, changed documents navigate with a changed query, and immutable content paths isolate asset versions. Browser-local records from another origin do not automatically move to this origin.

## Verification scope

Tests cover checksum/collisions, action fairness, deterministic checkpoints, storage denial/corruption, async cancellation/history, safe deployment transitions, base paths, HTTP404s and retained asset graphs. Touch layouts can be checked in a390px frame; that does not substitute for physical-device performance testing.
