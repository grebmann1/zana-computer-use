# Computer Use for Zana

Lets ZCC agents see and operate native macOS and Windows apps through [Cua Driver](https://cua.ai/docs/cua-driver). The plugin includes Cua Driver **0.33.4** for Apple Silicon / Intel Macs and Windows x64 / ARM64. Users can prepare this copy offline or choose their existing installation. It does not replace or upgrade an existing installation.

## Install

Find **Computer Use** in Zana's community marketplace, or install from the command line:

```bash
zcc marketplace install cua-driver-d68f@zana-community
```

If the community catalog is not registered yet:

```bash
zcc marketplace add git:https://github.com/salesforce/zana-marketplace.git
```

The Git package includes compiled server and UI files plus all three driver archives (about 135 MB). No separate dependency installation or build is needed. Installed plugins run as full-trust code in the Zana server process. Computer Use operates the desktop of the machine running Zana; setup and OS permissions are required there.

## What it adds

| Surface | What it does |
| --- | --- |
| Agent tools `cua_driver`, `cua_driver_describe`, `cua_driver_release` | Run any Cua Driver tool on the agent's behalf. The tool uses the thread as the Cua session, saves screenshots to files and attaches them to the result, and trims huge accessibility trees. |
| Skill `cua-driver` | Teaches the observe → act once → verify loop. Includes the upstream WORKFLOW and MACOS references (MIT). |
| Desktop lease | Lets one thread at a time control the desktop. A second thread gets `desktop_busy`. The lease is released when the holder's turn ends, fails, or is archived, after the idle timeout, or from the UI or CLI. |
| Approvals | Before foreground input, whole-desktop capture or input, clipboard use, local file paths, force-quit, config changes, installs, replays or page scripts, the thread asks **Allow once**, **Allow for this thread** or **Deny**. One prompt lists every reason an action needs. A path grant covers only those exact paths. |
| Plugin **Configuration** section, status chip, thread **Desktop** tab | The plugin's configuration section contains all settings, daemon and permission controls, the desktop lease, telemetry, and recent calls. The status chip offers quick daemon and lease actions, and the thread tab shows its latest screenshot and calls. No sidebar menu entry is added. |
| `zcc cua-driver status \| activity \| release \| start \| stop \| restart [--json]` | The same controls from a terminal. |

## Setup

Open **Plugins → Computer Use → Configuration**. Choose **Included with plugin**, click **Set up included driver**, and follow the macOS or Windows guide there. Alternatively choose **Custom path** and enter your installed CuaDriver.app or cua-driver.exe. Restart the daemon after changing the source.

See the [setup guide](docs/setup.md) for permissions, path examples and troubleshooting. Setup applies to the computer running Zana; opening Zana remotely does not grant access to a different computer's desktop.

## Settings

Open **Plugins → Computer Use → Configuration** for all settings and controls.

| Setting | Default | Notes |
| --- | --- | --- |
| Permission mode | `standard` | `bounded` requires a capability manifest path. The plugin never offers `unrestricted`. If the daemon runs in another mode, the plugin refuses agent calls with `daemon_mode_mismatch` until it is restarted. |
| Ask before sensitive actions | on | Controls the approval prompts above. |
| Lease idle minutes | 10 | |
| Auto-start daemon | on | On macOS, launches the selected CuaDriver.app through LaunchServices. On Windows, launches the selected executable in the current user's session. |
| Show the agent cursor during desktop work | on | Enables the session's Cua overlay, disables idle fade until the desktop lease ends, and places it for window inspection. It does not move the user's mouse. Cua's macOS overlay currently covers the main monitor only. |
| Cua Driver source | Automatic | Preserves existing installations. Automatic honors a supplied path, otherwise detects common installation paths, then uses the included copy if it has been prepared. Included with plugin and Custom path select only that source. |
| Existing Cua Driver path | empty | A CuaDriver.app path on macOS, or cua-driver.exe on Windows. A missing custom path produces an error instead of silently using another installation. |

## Limits

- The lease and approvals apply only to calls made through this plugin's tools. They are cooperative: they can't stop a process from running the `cua-driver` CLI or MCP server directly. For that reason the plugin doesn't register Cua's MCP server, and its instructions tell agents not to use the CLI.
- CLI-agent (PTY) sessions don't receive plugin tools.
- Supports macOS and Windows. Keep the desktop unlocked. macOS lock state is checked before calls; Windows OS refusals are returned by Cua Driver. Windows needs an interactive desktop under the same user account; elevated apps and UAC prompts may refuse input.
- Cua Driver collects its own product telemetry by default. The panel shows its state and can turn it off.

## Development

```bash
npm install
npm test              # vitest: lease, policy, driver parsers, plugin via fake host, UI slots
npm run typecheck
npm run check:cua     # verify all included release archives against pinned SHA-256 hashes
zcc plugin build .    # bundles server.mjs and app.js
zcc plugin dev --once # rebuild and reload in the running ZCC
```

Follow [LIVE_TEST.md](LIVE_TEST.md) to verify in ZCC.

The release archives and upstream license notices live in [vendor/cua](vendor/cua/README.md). Maintainers can run `npm run prepare:cua` to download missing pinned archives. The shipped plugin prepares its driver locally without network access. Keep the archives in the plugin package (about 135 MB total); they are required for included-driver setup.

## License

Plugin source is [MIT licensed](LICENSE). The bundled Cua Driver and copied upstream workflow references retain their own MIT copyright notices. See [Cua Driver notices](vendor/cua/THIRD_PARTY_NOTICES.md), the [upstream skill license](skills/cua-driver/UPSTREAM-LICENSE.md), and the [Zana SDK license](vendor/LICENSE-zcc-plugin-sdk.txt).
