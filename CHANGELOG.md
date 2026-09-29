# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0]

First release. Universal Music is provided as a Cinnamon desklet and has been
verified against real Spotify: player detection, title, artist, live elapsed
time, album art, and the Previous / Play-Pause / Next controls.

### Added

- Initial project structure for the Cinnamon desklet.
- `lib/mpris.js`: MPRIS D-Bus layer.
  - Discovery helpers for MPRIS bus names.
  - `MprisPlayer`, wrapping the `org.mpris.MediaPlayer2` and
    `org.mpris.MediaPlayer2.Player` interfaces.
  - Reads metadata, playback status, position, duration and the `Can*`
    capabilities from the GDBus property cache.
  - `Play`, `Pause`, `PlayPause`, `Next`, `Previous` and `Stop` control methods.
  - Change notifications for metadata, playback status, position, capabilities
    and bus name ownership.
  - A `ready` signal, emitted once both D-Bus proxies exist, so consumers never
    read properties before proxy construction has finished.
  - `refreshPosition()`, which re-reads `Position` over D-Bus. MPRIS does not
    require players to emit `PropertiesChanged` for it, so a cached read stays
    frozen at the track start; measured against a live player, the cache read
    228000000 while the bus held 230000000.
  - Safe unpacking of the `a{sv}` metadata dictionary. GJS's `Variant.unpack()`
    corrupts string arrays, so `deepUnpack()` is used throughout.
- `lib/player-manager.js`: player discovery and selection.
  - Watches the session bus for MPRIS names appearing and disappearing, plus an
    initial scan, so there is no polling for discovery.
  - Automatic selection of the currently playing player, with an explicit
    preferred-player override.
  - Re-selects on each player's `ready` signal, so a player that is already
    playing is shown correctly on startup.
  - Proxies are created with `DO_NOT_AUTO_START`, so discovery can never launch
    a media application.
- `lib/artwork-manager.js`: artwork handling.
  - Classifies `mpris:artUrl` values as local file, network, data URI, unknown
    or absent, and normalises bare filesystem paths, including `~` expansion.
  - Resolves a source to raw image bytes, leaving rendering to the UI layer.
  - Request serial numbers ensure a slow load for a skipped track cannot
    overwrite the current artwork.
  - A download timeout, so an unreachable cover server cannot stall the UI.
  - Falls back to a symbolic placeholder icon.
- `desklet.js`: Cinnamon integration.
  - Artwork, title, artist, elapsed time and previous/play-pause/next controls.
  - Elapsed time is extrapolated from the wall clock between bus reads, so it
    advances smoothly even with players that never send `PropertiesChanged`.
  - Artwork bytes are written to a cache file and drawn by an `St.Icon`
    through a `Gio.FileIcon`, since Cinnamon 6.6's St has no working
    byte-based texture loader.
  - "No media playing" placeholder state.
  - Playback controls dim and become non-reactive when the player reports that
    it cannot be controlled.
  - Configurable widget size, opacity, artwork visibility, controls visibility,
    preferred player and verbose debug logging through Cinnamon's standard
    desklet settings.
- `metadata.json`, `settings-schema.json`, `stylesheet.css`, `README.md`,
  `LICENSE` (MIT), `CHANGELOG.md` and a symbolic icon.

### Fixed

- **Left-clicking Previous / Play-Pause / Next did nothing.** Each transport
  button connected a `button-release-event` handler that returned
  `Clutter.EVENT_STOP`. GObject runs a class closure after the handlers
  connected with `connect()`, and `St.Button` emits `clicked` from the class
  closure for `button-release-event`, so the stop prevented the closure from
  ever running. `clicked` was never emitted, the button stayed in its pressed
  state holding an input grab, and that grab then swallowed every later click on
  the desklet. The handler is removed and the event is allowed to propagate.
- **Right-clicking anywhere played or paused instead of opening the menu.** The
  body's own release handler returned `EVENT_STOP` and called `_togglePlayPause()`
  for any button. Cinnamon's `Desklet` connects its own release handler on an
  ancestor of the body and needs the event to open the configuration menu on
  button 3, so the menu could not be reached. The body handler now only acts on
  the primary button, skips events that came from a transport button (so a click
  is not sent as `PlayPause` twice), and propagates.
- **Album art never rendered.** Fixing the call to
  `St.TextureCache.load_from_raw` was not enough, because on Cinnamon 6.6 that
  function returns an actor that is the size of the resource scale rather than
  the image, has no paint volume, and ignores `set_width()`. It draws nothing
  and reports no error. Artwork is now written to a uniquely named file in
  `~/.cache/universal-music-desklet/` and displayed through an `St.Icon` backed
  by a `Gio.FileIcon`, the same machinery Cinnamon uses for its own icons. The
  previous file is deleted once replaced. Spotify's cover URLs
  (`https://i.scdn.co/image/<hex>`, JPEG, no file extension) had always been
  classified correctly; the render step was the only fault. The existing
  fallback for other players is unchanged.
- **The artwork area collapsed to a 5px sliver.** The box had no explicit size
  and nothing inside it reported a useful one, so the cover downloaded and
  decoded correctly and then rendered into a strip too small to see. The area is
  now sized from the widget size preset, and the padding is accounted for so a
  square cover is not stretched.
- Verified that `Previous` reaches the bus. Spotify restarts the current track
  when playback is past a few seconds rather than stepping back, which is the
  documented MPRIS convention, so no change was needed.

### Changed

- Renamed the extension UUID from `universal-music-desklet@urfavtechbro` to
  `universal-music-desklet@robbyjhay`, and updated the author, LICENSE copyright
  and repository URLs to match. The directory name must match the new UUID.
- Documented that a Cinnamon desklet cannot be always-on-top: a desklet is a
  peer of application windows inside `Meta_WindowGroup`, whereas the panel is a
  stage-level sibling drawn above every window. Packaging the same widget as a
  panel applet is the supported route to a permanently visible music widget.

Several further issues that broke the desklet outright, each found by
testing and now covered by a regression test:

- Module paths in `lib/player-manager.js`. Cinnamon's `require()` resolves
  against the extension root rather than the calling file, so `require('./mpris')`
  looked for the wrong path and the desklet failed to load entirely.
- `Gio.File.load_contents_async` was called with a priority argument, which that
  signature does not accept.
- Unknown artwork schemes and missing local covers now fall back immediately
  instead of waiting for a load that would never resolve.
- Non-base64 `data:` URIs are now decoded instead of silently discarded.

### Not yet implemented

- Verification against real players other than Spotify (VLC, Firefox, mpv,
  Rhythmbox). Spotify is verified; the others are exercised only through the
  test suite.
- Seeking: a draggable progress bar and click-to-seek.
- Volume control.
- An Applet build, so the widget can live in the panel and be permanently
  visible. See the note above about desklets not being able to stay on top.
- Persistent artwork caching to disk. The current cache file is rewritten per
  track and the previous one deleted.
- Track list integration through `org.mpris.MediaPlayer2.Tracker`.
- Translations.

[unreleased]: https://github.com/robbyjhay/universal-music/commits/main
