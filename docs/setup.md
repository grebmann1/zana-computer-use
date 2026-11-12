# Set up Computer Use

Open **Plugins → Computer Use → Configuration** in Zana. All settings, the setup guide and desktop controls are inside the plugin. Configure the computer running Zana, even if you access it remotely.

## Choose a driver

| Source | How to use it |
| --- | --- |
| **Included with plugin** | Select this source, then click **Set up included driver**. The plugin checks and unpacks Cua Driver 0.33.4 from its own package. No download is needed. |
| **Custom path** | Select this source, then enter the full path under **Existing Cua Driver path**. On macOS select CuaDriver.app; on Windows select cua-driver.exe. |
| **Automatic** | Honors the path field if supplied. Otherwise checks common installation locations, then falls back to the included copy once it has been prepared. This is the default so existing installations keep working. |

A missing custom path never falls back to a different copy. Clear the path field if you want Automatic to detect an installation.

The included releases support Intel and Apple Silicon Macs, and Windows x64 and ARM64. They unpack into `~/.cua-driver/computer-use-plugin/0.33.4/<platform>-<architecture>` (under your user profile on Windows). The plugin keeps the application bundle and Windows sidecars together and does not change PATH or overwrite your own installation.

After changing the source or path, click **Restart** in the Daemon section. The displayed version is the selected executable's version; an already-running daemon may still be from the previous installation until restarted.

## macOS

1. Prepare the included driver, or choose your installed app, for example `/Applications/CuaDriver.app`. A path to a symlinked executable also works if it resolves inside CuaDriver.app. A standalone binary cannot be used to start the macOS daemon from this plugin.
2. Click **Start**, or **Restart** if a daemon is already running. The plugin launches the exact selected app through macOS LaunchServices so permissions belong to CuaDriver.app.
3. In **System Settings → Privacy & Security**, enable that app in **Accessibility** and **Screen & System Audio Recording** (called **Screen Recording** on older macOS versions). Accept the system prompts yourself. If the app is absent, use the + button and select the app path shown in the plugin. For a private included app, use Finder's **Go to Folder** to reach its path.
4. Restart the daemon after granting permissions. Click **Refresh** and check the permission indicators and Ready state.
5. Open an ordinary application and ask an agent to inspect its window. A successful screenshot confirms capture works; try a simple action to verify Accessibility access.

Keep the Mac unlocked. Some apps and background operations may refuse input; the agent will report those refusals.

## Windows

1. Prepare the included driver, or select your existing `cua-driver.exe`. A typical installer location is `%LOCALAPPDATA%\Programs\Cua\cua-driver\bin\cua-driver.exe`. Keep the installation's companion files beside the executable.
2. Sign in and unlock Windows. Run Zana and Cua Driver in the **same account and interactive desktop session**. A service or SSH session does not provide the normal user desktop.
3. Click **Start**, or **Restart** after changing the source or path, then **Refresh**. Windows does not have macOS Accessibility or Screen Recording switches.
4. Open an ordinary application and ask an agent to inspect its window and perform a simple action. Applications running as administrator and UAC prompts may refuse input. Start with an application running under your normal user account.

Included Windows setup uses Windows' `tar.exe` to unpack the release. If extraction reports that it is missing, use an existing installation or install the driver through Cua's official installer.

## Troubleshooting

**Show the agent cursor during desktop work** is enabled by default in the plugin's configuration. The plugin places Cua's separate cursor on the window the agent inspects, then follows its actions without moving your own mouse pointer. It disables the idle fade while the thread holds the desktop and removes the session when the thread releases it. You can turn this setting off if you prefer.

On macOS, Cua Driver 0.33.3 and the included 0.33.4 draw their overlay on the main monitor only. A target on another monitor can have a valid cursor position without displaying the overlay. The plugin setting cannot extend Cua's native overlay to other monitors. This limitation is visible in the [upstream macOS overlay implementation](https://github.com/trycua/cua/blob/cua-driver-rs-v0.33.4/libs/cua-driver/rust/crates/platform-macos/src/cursor/overlay.rs).

| What you see | What to do |
| --- | --- |
| Selected driver not available | Prepare the included driver or correct your custom path. On macOS select the app bundle; on Windows select the executable. |
| Included archive checksum failed | Reinstall the plugin package. The plugin refuses to unpack a modified archive. |
| Permissions needed on macOS | Grant both permissions to the selected app, then restart and refresh. If switching between copies, check which app System Settings lists. |
| Version changed but behavior did not | Restart the daemon. Switching the selected executable does not switch an already-running daemon. |
| Daemon mode mismatch | Restart from the plugin to apply its standard or bounded mode. Bounded mode also needs a reviewed capability manifest. |
| Windows cannot access the desktop | Check the account and interactive session, unlock Windows, and try a normal, non-elevated app. |
| Desktop busy | Another thread holds the desktop lease. Finish that task or release its lease from the plugin. |

The plugin's agent tools share one desktop lease and apply Zana's approval prompts. Leave macOS permission dialogs and other OS security decisions to the user.

For manual installation, expand **Install Cua Driver yourself** in the plugin guide. Refer to Cua's [quickstart](https://cua.ai/docs/cua-driver/quickstart), [permissions guide](https://cua.ai/docs/cua-driver/guides/permissions) and [platform support](https://cua.ai/docs/cua-driver/concepts/platform-support). The included version is pinned to the official [0.33.4 release](https://github.com/trycua/cua/releases/tag/cua-driver-rs-v0.33.4); it does not update itself automatically.
