# Live verification: Computer Use

Use the running ZCC instance. Keep `ZCC_SERVER_URL` and `ZCC_DATA_DIR`
pointed at the same instance (normally port 8780; dev uses 8781 and ~/.zcc-dev).
Do not change session credentials or edit installed-plugin records.

1. Run `zcc status --json`, then `zcc plugin install .` from this directory.
2. After edits run `zcc plugin dev --once`. It rebuilds the UI and reloads;
   a build or unhealthy reload must return a nonzero exit. Use
   `zcc plugin logs cua-driver-d68f -n 50` to diagnose backend failures.
3. Open **Plugins → Computer Use → Configuration** using the available computer-use tool. Verify all settings and desktop controls render within the plugin's configuration page, and that there is no **Computer Use** entry in ZCC's sidebar menu.
4. Exercise the primary action and verify the result. Check any loading, empty, and failure states the feature exposes.
5. Make a visible source edit, run `zcc plugin dev --once`, and observe the already-open panel update without restarting ZCC. Verify saved data survives the reload.

Use only test data you create. Keep a user's requested plugin installed; remove
an explicitly disposable probe with `zcc plugin remove cua-driver-d68f` when finished.
If UI control or the app is unavailable, report that limit instead of claiming
the panel passed. Record the command results and visible behavior in your handoff.
