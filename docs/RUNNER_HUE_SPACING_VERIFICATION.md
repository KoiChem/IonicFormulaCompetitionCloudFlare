# Runner hue spacing — 2026-10-03

Approved design: 42 evenly spaced hue slots, advancing 17 slots per persistent join order. Each random room UUID determines the initial hue and direction. Colors stay attached to join order through ranking, removal and reload.

- Changed only the frontend color allocator; no database/API/Realtime changes.
- Consecutive join orders differ by about146 degrees; gaps of2/3 differ by about69/77 degrees. RGB rounding is covered by numeric hue-distance tests.
- Removed participants keep their slots. More than42 lifetime joins continue the hue sequence with distinct dark RGB extrema per cycle. The allocator has51,450 distinct lifetime slots before repeating; colors are not reused after just42 joins.
- First colors vary across rooms.500 synthetic room IDs cover all42 initial hues; repeated calls reproduce each room's color.
- RED: old allocator failed adjacent-hue separation and pale-background visibility checks. GREEN: new allocator passes those regressions, stability and10,000-color uniqueness checks.
- Full suite:87 files /464 tests passed with load and bundle checks. Typecheck, production build and git diff check passed. Existing build warning: frontend chunk exceeds500kB; resulting JS581.53kB, smaller than the previous581.72kB.
- Independent code review found no issues. Reviewer independently enumerated the full51,450-color cycle: all unique, minimum contrast against#f4faf7 about3.20:1.
- Local Playwright, authorized localhost-only teacher fixture:42/42 computed RGB colors distinct; minimum adjacent hue difference145.405 degrees; score reorder, removal and reload retained colors.1180/1366/1024/390px widths had no horizontal overflow; console had no errors. Screenshot checked for stroke/head color visibility.
- GitHub Pages build/test/deploy succeeded for a72960c (Actions37026834078). Playwright confirmed the served asset index-DtJVH-qU.js matches the local build; public console and page-error checks found no errors.
- Live public class a36332ee-5a4a-4c34-99eb-8fe2049c015d: four separate Playwright participant sessions joined through the normal UI. Authenticated Safari showed A red-purple, B cyan, C brown-orange, D blue-purple, matching the allocator's #841554 / #158484 / #845415 / #251584. Reload preserved all four colors. D answered sulfide correctly, moved to first place and kept blue-purple; the other colors also stayed attached to their participants.
- Real iPad touch and a physical classroom session are outside these checks.
