# IonicFormula upstream

This adapter incorporates chemistry data and selected pure behavior from KoiChem IonicFormula.

- Upstream commit: `b58223da4279f6d14d34973af47a25adf68abf84`
- Source files: `js/core.js`, `data/ions.json`, `data/compounds.json`, `data/difficulty.json`
- License: MIT; see `LICENSE` in this directory.
- Changes: the ten-question generator was rewritten as a server-only TypeScript adapter for 5, 10, or 15 questions. Personal history, weak-item selection, DOM code, local storage, service workers, and administration code were excluded. Internal answer snapshots are separated from public question payloads, and compound `both` answers are scored as two fields.

Verified source SHA-256 values:

- `js/core.js`: `ccffd583e1e69df5c882b0bf449fa18fc9e38de8054b195bb5f6a868698d00c4`
- `data/ions.json`: `e838e49c77b94d1c5cc49daf022e827c1e9210ea2a5b9a043eadb5e67b2730b6`
- `data/compounds.json`: `540da2223e022a003dae11a4c637a5d1937aec3370cab414009e0dae16554024`
- `data/difficulty.json`: `8f4b9ed9d9ab141bb1f6ee2483596c60098738a62bd8cd591676ad2ceec86ec3`
