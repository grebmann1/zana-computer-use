# Cua Driver plugin

This is a Zana Command Center plugin. The manifest lives in `package.json` → `zcc`.
Id: `cua-driver-d68f`.

## Loop

```bash
zcc plugin install .
```

After install the plugin is live. Then, only as needed:

- Backend edits: `zcc plugin reload cua-driver-d68f` (`zcc plugin dev` optional).
- UI (`zcc.app`) edits: `zcc plugin dev` (watch) or `zcc plugin build` then `reload`.
- Compile check: `zcc plugin build` (no running app).

`zcc plugin dev` is an optional watch loop **after** a path install. It is not required to create or run a plugin. Path installs load `server.ts` from source. A failed rebuild keeps the last good generation. Plugins are full-trust in-process on the server after install. Do not request host-daemon tokens.
Fill the host panel slot (`height: 100%`). Skills live in `skills/<name>/SKILL.md`.
MCP servers belong in `zcc.mcpServers`. Author against `@zana-ai/zcc-plugin-sdk` (`definePluginApp`, `ZccPluginApi`).

The panel is a `definePluginApp` setup that registers `app.slots.navPanel`.
The server factory default-exports `(zcc) => { … }` and registers `zcc.rpc` methods the panel can call after a reload.

## Verify in running ZCC

Follow `LIVE_TEST.md` before claiming completion. Use `zcc plugin dev --once`
for an agent-controlled rebuild and reload without a background watcher.
A successful command checks backend health; it does not prove the UI rendered.
Open the plugin in ZCC with the available computer-use tool, exercise its controls, then change the source and verify the open panel updates.
Report what you observed and any blocked checks. Do not claim live verification from unit tests alone.

## This plugin's rules

- Leave Cua's MCP server out of `zcc.mcpServers` on purpose. Agents reach Cua only through the `cua_driver` tools, which apply the desktop lease and the user's approvals.
- Never start the daemon in `unrestricted` mode. Start it with `open -a CuaDriver --args serve`, so that macOS attributes TCC permissions to CuaDriver.app.
- Author against `types/zcc-plugin-sdk.d.ts`. `zcc plugin types` stamps it from the installed host, and it can lag the zana-command-center source: this host uses `rpc.method` and bare-function `background.service`. Read thread-event and `requestInput` results through `src/host.ts`, which accepts both shapes.
- `app.tsx` is bundled for the browser. Import only browser-safe modules from it (`src/constants.ts`, `src/view.ts`, and type-only imports elsewhere).
- Realtime channels are `cua.status` and `cua.activity`.
- `npm test` must stay hermetic: it uses `test/fake-driver.ts` and never the real binary.
