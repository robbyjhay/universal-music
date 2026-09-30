# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0]

A layout and playback release. The widget is now measured and laid out rather
than fixed, the title scrolls when it does not fit, and the playback position
can be moved.

### Added

- `lib/layout.js`: the responsive layout, timeline and marquee arithmetic.
  Pure functions over plain numbers, so the rules are in one readable place and
  testable without a Cinnamon session.
  - Picks one of three shapes from the space the desklet was given: the cover
    above the information, beside it, or a compact layout that drops the artist
    line and the time labels when there is not enough room for both.
  - Sizes the cover as the smaller of what the size preset allows and what
    actually fits, so the cover fills the width it has without ever being
    stretched.
  - Caps how wide the information column may ask to be, and puts a hard ceiling
    on the whole widget.
  - Geometry for the seek bar and the mapping from a pointer position onto it.
  - The scroll cycle for a title that does not fit: hold still, slide out, hold
    at the end, slide back, at a constant speed with a pause at each end.
  - `formatTime()`.
- A seek bar. It shows the position and the duration, fills as the track plays,
  and can be moved: clicking the track seeks to that point, and the handle can
  be dragged for a closer one, with the seek sent when the button is released
  rather than on every motion. A paused player has no further position
  updates, so the real value is asked for once after a seek to confirm where
  playback ended up.
- A scrolling title. A title wider than the desklet scrolls inside the text
  column, and one that fits stays exactly where it is. The motion is an ease on
  the frame clock rather than a repeating timer, so a title that is not
  scrolling costs nothing, and only the pauses at each end use a timer, once
  each. The scroll restarts from the beginning on a track change, and on a
  resize it is measured again.
- A **Wide** size preset, for the side by side layout. It is the one size
  setting that changes the shape rather than only the scale.
- `tests/run-tests.js`: a test runner with no dependencies, covering the layout
  arithmetic and the parts of the MPRIS layer that do not need a bus. It loads
  the project modules the way Cinnamon's `require()` does, so no test
  scaffolding had to be added to the source.

### Changed

- The layout is decided from the real allocation instead of the size preset
  alone, and the desklet responds to being resized. The cover, the scrolling
  title and the timeline all follow from that one decision, so they move
  together.
- The cover is a box rather than a bin, and is centred on its cross axis. It now
  uses the width available to it instead of a fixed square, up to the size
  preset's limit: 140px instead of 64px on the medium preset.
- **The cover fills the space above the information instead of floating in the
  middle of it.** The cover box was stretched to the full width of the desklet
  while the cover inside it was capped at a size the desklet could be wider
  than, so on a medium preset a 140px cover sat in a 180px box with a 20px band
  of desklet background on each side, which read as a black border around the
  artwork. The box is now the size of the artwork that goes into it, the size
  presets are the content width of their own preset so the cover reaches the
  edges, and the cover box has no padding left to show through.
- **The seek bar is a timeline.** The rail is 3px with rounded ends instead of a
  20px slab of translucent white, the progress fill is exactly as thick as the
  rail, and the handle is a 10px white circle centred on it with a soft shadow.
  The circle grows on hover and while it is being dragged, as a scale around its
  own centre so that the seek geometry is not affected. The handle is reactive
  in its own right, because Clutter only picks reactive actors: it is taller
  than the rail it sits on, and a press on the visible circle that missed the
  rail would otherwise have fallen through to the body and toggled playback
  instead of seeking.
- The rail is a plain widget rather than a box, and the fill and the handle are
  placed on it by hand. A box lays its children out inside a space as tall as
  its tallest one, so with a 10px handle in a 3px rail it drew the fill 3px
  below the rail and the handle 7px above it. The two numbers that place them
  come from the same timeline geometry as before; only how they are applied
  changed.
- The handle's radius is half its width as a length rather than as a
  percentage. A percentage radius is not honoured here, and the handle came out
  as a square.
- The vertical composition is tighter. The gap between the time labels and the
  transport controls is 5px and the padding around the controls is gone, which
  together with the thinner seek bar takes about 12px out of the information
  column. The space above the rail is not a gap: it is where the handle sits
  when it is bigger than the line it is centred on.
- The artist is left aligned with the title, which cannot be centred because the
  scrolling title needs a fixed edge to scroll from.
- The placeholder icon is drawn at a fraction of the size the real cover would
  take, so an empty slot does not look like a very large cover.
- The elapsed time and the duration are separate labels on either side of the
  timeline rather than one "0:42 / 3:18" line.
- `MprisPlayer.setPosition()`: `SetPosition` for a player that reports a track
  id, and a relative `Seek` for one that does not. This is the only change to
  `lib/mpris.js`.

### Fixed

- **The artwork did not fill the artwork container.** A cover that is not square
  was drawn into a square box sized from the width the desklet had, so St fitted
  it inside that square and left a strip of desklet background down each side of
  it. The cover box is now sized from the shape of the image, read from the
  cached file with `GdkPixbuf.Pixbuf.get_file_info()` rather than by decoding
  it, so the artwork reaches the inner edges of its box at any aspect ratio. It
  is not cropped and it is not stretched: the box changes shape instead, which
  is the only way to fill a box with an image that must keep its own proportions.
  A cover whose shape cannot be read is still drawn as a square, which is what
  it always was. The artwork loading, caching and fetching are untouched.
- **The desklet could grow until it took the desktop down with it.** This is the
  important one. A widget is sized to its own contents, so the sizes it reports
  are the size it is given, and every one of them can be traced back to a
  measurement of the last one. Two of those loops had a gain above one:
  - The width of the progress fill is derived from the width of the track, and
    the width set on the fill becomes the track's own preferred width, which
    widens the information column, which widens the desklet, which makes the
    track wider. A track that was playing grew the desklet a little on every
    layout pass.
  - The size the desklet had was measured without its 1px border, so the
    measurement was two pixels short of the truth on every pass, and a desklet
    with a long title in it grew by exactly those two pixels each time. Measured
    live, this reached 33,043,416 pixels wide.
  Both are now impossible rather than unlikely: the information column reports
  a preferred width no larger than the width the desklet will not go below,
  which is a number from the stylesheet that no measurement can inflate, and the
  measurement itself is clamped before anything is worked out from it. The
  widest the widget can ask for across every size preset is 362px.
- A long title no longer widens the desklet. St has no maximum width on a
  widget, only on a theme node, and a theme node's is a fixed length that cannot
  follow the width the desklet actually has, so the information column and the
  title's clipping viewport now report a preferred width the layout chooses.
- The scrolling title stopped scrolling. The cycle ran once and then waited, and
  a title that was only a few pixels too wide crept along for as long as it was
  on screen. The cycle now repeats, and a title a few pixels too wide is
  clipped instead.
- The layout pass no longer runs before the desklet is on the desktop, which
  made St complain about theme nodes on widgets that were not in the stage yet.
- The seek bar does not move the desklet. Cinnamon makes the whole desklet
  draggable from any button 1 press anywhere on it, by grabbing the pointer in a
  handler on the desklet container. The seek bar stops the press so the pointer
  never reaches that grab, and the rest of the body and the header still drag
  the desklet.

### Not yet implemented

Unchanged from v0.1.0: volume, repeat modes, queue management, playback mode
selection, animations beyond the title scroll, advanced visual customisation,
an equalizer, the panel applet, track list integration, persistent artwork
caching and translations.

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
- Volume control.
- An Applet build, so the widget can live in the panel and be permanently
  visible. See the note above about desklets not being able to stay on top.
- Persistent artwork caching to disk. The current cache file is rewritten per
  track and the previous one deleted.
- Track list integration through `org.mpris.MediaPlayer2.Tracker`.
- Translations.

[unreleased]: https://github.com/robbyjhay/universal-music/commits/main
[0.2.0]: https://github.com/robbyjhay/universal-music/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/robbyjhay/universal-music/releases/tag/v0.1.0
