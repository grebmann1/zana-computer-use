# Computer Use setup verification

Verified on 5 October 2026 against the running Zana desktop on macOS ARM64.

- `npm test`: 74 tests passed. Tests use fake drivers and fake release extraction; no real Cua binary is used by the test suite.
- `npm run typecheck`: passed.
- `npm run check:cua`: all three included 0.33.4 archives matched their pinned SHA-256 hashes.
- `npm pack --dry-run --json`: all platform archives, the manifest and license notices are included in the package (approximately 136 MB packed).
- `zcc plugin install .` and `zcc plugin dev --once`: succeeded, with healthy backend reloads.
- Zana's **Computer Use → Configuration** rendered the source setting, path setting, macOS/Windows guide tabs, included-driver preparation control and desktop controls. There is no plugin sidebar navigation slot.
- Clicking **Set up included Cua Driver 0.33.4** unpacked the macOS app into the private per-version directory. The UI confirmed it was ready; `codesign --verify --deep --strict` passed for the extracted app.
- Switching to the Windows guide showed its interactive-session instructions. Clicking Refresh updated the status without an error.
- With the panel open, changed the guide heading to **Set up Computer Use on this computer**, rebuilt with `zcc plugin dev --once`, and observed the new text without restarting Zana. The prepared-copy state and existing Automatic source persisted.

Limits: no Windows machine was available for a live launch or capture test. Windows extraction, launch arguments, readiness and guide behavior are covered by hermetic tests. Cua's background accessibility route exposed only the selected option of Zana's native source dropdown, so changing that dropdown was not verified live. Source selection and custom-path failure behavior are covered by tests. The existing 0.33.3 daemon and Automatic selection were preserved; preparation does not switch or restart the user's daemon. No OS privacy settings were changed.

## Guide appearance

Polished the guide with numbered steps, clearer spacing, shorter instructions, a visibly selected platform tab, a green prepared-driver badge, separate path display and a quieter documentation footer. Styles use Zana's theme variables and remain scoped to the guide. All 74 tests and the typecheck passed. Inspected the rendered guide in the running Zana window, switched between Windows and macOS, and confirmed the correct instructions and active tab. Changed the subtitle while the panel was open, ran `zcc plugin dev --once`, and observed the updated text without restarting Zana. Driver preparation and saved configuration remained intact.

## Agent cursor defaults

The plugin now enables the thread's agent cursor by default and sets `idle_hide_ms: 0` while it holds the desktop. A first inspection of each window seeds the overlay from that exact window's observed screen frame, including negative coordinates. Repeated verification of the same window preserves the last action's position. Releasing the lease ends the session and removes its cursor. Cursor failures add a warning without failing a successful inspection.

- `npm test`: all 81 hermetic tests passed, including opt-out, preference changes, release, session revival, invalid geometry, unavailable overlays, denied/busy actions and release during cursor configuration.
- `npm run typecheck`: passed.
- `zcc plugin dev --once`: healthy rebuild and reload after implementation and after the visible setting-description edit.
- The running Zana configuration displayed **Show the agent cursor during desktop work**, initially on. Toggled it off and verified the next inspection reported `enabled: false`; toggled it on and verified `enabled: true`, `idle_hide_ms: 0`, and a position at the inspected window's screen center `(4320.5, 675)`.
- After releasing the desktop, the state getter reported `position: null` and default motion. A new session automatically reapplied the defaults. No direct cursor-control tools were used in this verification.
- Changed the description while the configuration was open and verified the updated main-monitor explanation in the rendered panel after reload. The saved toggle remained on, and Automatic source and the existing daemon were preserved.

Limit: actual native cursor pixels were not visually verified. Both the installed macOS 0.33.3 and included 0.33.4 source create an overlay covering the main monitor only. Cursor's window was on the left secondary monitor at `x = -2560`; Zana was on a right secondary monitor at `x = 3615`. Their cursor state can therefore be enabled and positioned without a visible native overlay. The setting and documentation explicitly describe this upstream limitation; the plugin does not claim to fix multi-monitor rendering. No Windows machine was available for a live overlay check.

## Marketplace package verification — 12 November 2026

- The existing 81 hermetic tests, TypeScript check, plugin build and installed-host SDK declaration check passed.
- All three bundled Cua Driver 0.33.4 archives passed the pinned SHA-256 checks.
- Ran the 23 server integration tests against the compiled `server.mjs` with the fake driver; all passed. The compiled factory also imports with Node without installed runtime dependencies.
- Added compiled server/UI files and artifact metadata, MIT licensing, upstream notices, public repository metadata and a GitHub verification workflow. Package dependency URLs use the public npm registry.
- Updated development dependencies within their declared ranges; the public-registry audit reports no known vulnerabilities.

Publication does not change desktop behavior or settings. The currently installed plugin is disabled and was left disabled. This packaging pass did not repeat the prior live macOS setup/UI checks above; no Windows live test was performed. Agent-cursor pixel visibility retains the limitation documented above.
