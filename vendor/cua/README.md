# Included Cua Driver releases

These are the official, unmodified Cua Driver 0.33.4 release archives from https://github.com/trycua/cua/releases/tag/cua-driver-rs-v0.33.4.

`release.json` pins the version, platform archive names, executable locations and SHA-256 checksums. The plugin verifies the selected archive before unpacking it into a private per-version directory. The macOS archive includes the upstream signed CuaDriver.app. The Windows archives include the executable and all companion files.

Keep all three archives when packaging this plugin. `npm run prepare:cua` downloads any missing archives and verifies their checksums; `npm run check:cua` only verifies existing files. No runtime downloads occur during included-driver setup.

`LICENSE` and `THIRD_PARTY_NOTICES.md` are copied from the official release and are also preserved in the unpacked installation. Cua Driver is distributed under the upstream MIT license; third-party notices apply as listed.
