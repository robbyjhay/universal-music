# Universal Music

An open-source Cinnamon widget for Linux that shows and controls the media
currently playing on your desktop.

Universal Music is **powered by MPRIS** and therefore **player-agnostic**. It
detects any compatible player that is running, follows whichever one is
currently playing, and reads and controls it through the standard interface. It
is currently provided as a **Cinnamon Desklet**, and support for a panel
**Applet** is intended for the future.

**Status: v0.1.0, verified against real Spotify.** Player detection, title,
artist, live elapsed time, album art, and the Previous / Play-Pause / Next
controls have all been confirmed working against the Spotify desktop client.
Other MPRIS-capable players are covered by the test suite but have not been
hand-verified yet. See [Current functionality](#current-functionality) and
[Planned functionality](#planned-functionality) for the exact split.

## What this is

Every media application on Linux can be controlled the same way if it
implements [MPRIS](https://specifications.freedesktop.org/mpris-spec/latest/),
the freedesktop standard for media players over D-Bus. VLC, Spotify, Firefox,
Chromium, mpv, Rhythmbox, Strawberry and any local file played through an
MPRIS-capable player all expose the same interface.

Universal Music talks only to that standard. There is no Spotify code, no VLC
code and no Firefox code anywhere in the project, which is what makes
"universal" true in practice rather than a list of special cases: a new player
works without any changes here.

## Architecture

```
desklet.js                Cinnamon integration, widgets, settings binding
  └── lib/player-manager.js   discovery and active-player selection
        └── lib/mpris.js       MPRIS protocol access (D-Bus)
  └── lib/artwork-manager.js  album artwork resolution
```

The dependency direction is one-way: `desklet.js` knows about the managers, and
the managers know about `mpris.js`. Nothing below `desklet.js` imports anything
from it, so the MPRIS layer can be tested on its own.

### lib/mpris.js

The only module that talks D-Bus. It exposes `MprisPlayer`, which wraps the two
standard MPRIS interfaces:

| Interface | Used for |
| --- | --- |
| `org.mpris.MediaPlayer2` | Player identity (`Identity`, `DesktopEntry`) |
| `org.mpris.MediaPlayer2.Player` | Metadata, playback status, position, control |

Reading uses the GDBus property cache, so property reads are synchronous and
current, and the desklet reacts to `g-properties-changed` rather than polling.
Control methods (`Play`, `Pause`, `PlayPause`, `Next`, `Previous`, `Stop`) are
asynchronous D-Bus calls whose errors are logged rather than thrown, so a
misbehaving player cannot break the desklet.

Details worth knowing if you read the code:

- `Gio.DBusProxy` instances are created with `DO_NOT_AUTO_START`. Discovering
  players must never cause an application to be launched.
- Metadata arrives as an `a{sv}` dictionary. GJS's `Variant.unpack()` silently
  turns string arrays into arrays of empty objects, which destroys
  `xesam:artist`. `deepUnpack()` recurses correctly, so every read goes through
  a single `unpackVariant()` helper.
- Proxies are built asynchronously, so nothing is readable at construction
  time. `MprisPlayer` emits `ready` once both exist; the manager and the desklet
  both wait for it, which is what makes a player that is already playing show up
  correctly on startup.
- `Position` is special. The spec does not require players to send
  `PropertiesChanged` for it, so the cache is often frozen at the track start:
  measured against a live player, the cache read `228000000` while the bus held
  `230000000`. `refreshPosition()` re-reads it over D-Bus, and the desklet
  extrapolates from the wall clock between reads so the display still moves
  smoothly.

### lib/player-manager.js

Watches the session bus for MPRIS names appearing and disappearing, using
`NameOwnerChanged` on the bus daemon plus an initial `ListNames` scan. Because a
player can start at any time, discovery is event-driven rather than a timer.

Selection is either an explicit `preferred-player`, or automatic: the player
reporting `Playing` wins, and when nothing is playing the last active player is
kept so the desklet does not flicker on every pause.

### lib/artwork-manager.js

Classifies the `mpris:artUrl` metadata value, which in practice can be a local
file, an `http(s)` URL, a `data:` URI, or occasionally a bare path. Anything
unusable resolves to a symbolic placeholder. Each request carries a serial
number, so a slow download for a track you already skipped cannot overwrite the
current artwork.

The manager resolves a source to raw image bytes and leaves rendering to
`desklet.js`. That split matters because St has no byte-based texture loader in
Cinnamon 6.6: `St.TextureCache` offers `load_file_async`, `load_uri_async` and
`load_from_raw`, but no `load_bytes_async`, and on this build neither async
loader ever completes its callback.

`load_from_raw` does return an actor, and it accepts the right arguments, but
the actor it returns is useless: it comes back the size of the resource scale
rather than the size of the image, it has no paint volume so it draws nothing,
and `set_width()`/`set_size()` have no effect on it. Adding an alpha channel
does not change any of that. The call is well formed and completely silent, so
checks that only verified the call signature passed while the cover stayed
invisible.

The desklet therefore writes the downloaded bytes to a uniquely named file in
`~/.cache/universal-music-desklet/` and points an `St.Icon` at it through a
`Gio.FileIcon`. That is the same icon machinery Cinnamon uses for its own
icons, it is the only route measured to produce an actor with a real paint
volume, and it leaves decoding, scaling and aspect ratio to St. The placeholder
is a `Gio.ThemedIcon` on the same `St.Icon`, because `St.Icon` clears its
previous source on every `set_gicon` call and rejects a null gicon.

Each load uses a fresh file name, since St caches textures by path and reusing
one path would keep showing the first cover. The previous file is deleted once
it has been replaced, so the directory holds at most two files.

Spotify serves cover art as JPEG from `https://i.scdn.co/image/...` with no
file extension, which the `https` classification already handled correctly.

## Current functionality

Implemented and tested:

- Loads in Cinnamon, can be added, moved and removed like any desklet.
- Configurable widget size, opacity, artwork visibility, controls visibility and
  preferred player, through Cinnamon's standard settings dialog.
- Full MPRIS plumbing: player discovery, active-player selection, metadata,
  playback status, position, duration, capabilities, and change notifications.
- Artwork loading for local files, `http(s)` URLs and `data:` URIs, with a
  placeholder fallback and a download timeout.
- Working Previous / Play-Pause / Next controls dispatched as the MPRIS
  `Previous`, `PlayPause` and `Next` methods.
- Verbose debug logging behind a setting, for MPRIS troubleshooting.
- "No media playing" placeholder when nothing is playing.

Verified against a real Spotify track playing on this machine: title, artist,
duration, live position, cover art, and all three transport controls.

Note that Spotify's `Previous` is player-side behaviour, not a desklet bug: the
call reaches the bus and returns OK, but Spotify restarts the current track when
the position is past a few seconds instead of stepping back, which is the
documented MPRIS convention.

## Visibility and layering

A Cinnamon desklet **cannot** be made always-on-top, and this is a deliberate
limitation of the container rather than a gap in this extension.

A desklet lives inside `Meta_WindowGroup`, the same group that holds normal
application windows, whereas the panel is a stage-level sibling
(`panel-top` / `panel-bottom`) drawn above every window. So a desklet is a peer
of windows in the stacking order: any focused or maximized window covers it.
`org.Cinnamon` exposes no keep-above method, and `Meta.Window.make_above()`
only applies to `MetaWindow` instances, which a desklet is not.

Deliberately not done, because each is a hack rather than a supported approach:

- Moving the widget into the window group above the app windows, which fights
  the compositor and breaks on Cinnamon updates.
- Polling window focus to re-raise the desklet, which flickers and costs
  wakeups for no benefit.
- `Meta.Window.make_above()` on a synthesised window to host the widget, which
  turns a desklet into a fake unmanaged window with its own focus, animation
  and taskbar behaviour.

The supported way to keep a compact music widget permanently visible is to place
it in the **panel** as an applet rather than on the desktop as a desklet. The
panel is the only Cinnamon surface guaranteed to stay above normal windows. If
always-visible is a hard requirement, this extension should be packaged as a
panel applet; that is a structural change and is left as future work rather than
being half-done here.

## Planned functionality

Not implemented yet, roughly in intended order:

1. Verify end to end against VLC, Firefox, mpv and Rhythmbox, then fix whatever
   they do differently. Spotify is already verified.
2. Package the same widget as a **panel applet**, so it can live in the panel
   and stay above normal windows. See
   [Visibility and layering](#visibility-and-layering).
3. A seek bar: elapsed position is already displayed, but there is no dragging
   and no click-to-seek.
4. Volume control.
5. Persistent album art caching to disk. Covers are currently written to a
   cache file per track and re-downloaded on each change.
6. Track list through `org.mpris.MediaPlayer2.Tracker`.
7. Translations.

## Requirements

- Cinnamon 6.0 or newer on Linux.
- A media player that implements MPRIS. On most desktop distributions the
  session bus and a suitable player are already present.

There are no runtime dependencies, no build step and no npm packages.

## Installing locally

Install into your user directory, which needs no root and touches no system
files:

```sh
git clone https://github.com/robbyjhay/universal-music.git
cp -r universal-music \
  ~/.local/share/cinnamon/desklets/universal-music-desklet@robbyjhay
```

Or, from an existing clone:

```sh
cp -r /path/to/universal-music \
  ~/.local/share/cinnamon/desklets/universal-music-desklet@robbyjhay
```

The target directory name **must** be exactly
`universal-music-desklet@robbyjhay`. Cinnamon matches the directory name against
the `uuid` in `metadata.json` and refuses to load the desklet if they differ.
The repository name and the desklet UUID are deliberately different.

Then restart Cinnamon in place, which does not end your session:

```sh
cinnamon -d --replace
```

## Enabling it in Cinnamon

1. Right-click the desktop and choose **Add Desklets**.
2. Find **Universal Music** in the list and double-click it.
3. Right-click the desklet to move it, or to open its settings.

If the desklet does not appear in the list, Cinnamon did not load it. Check the
log (below); a load failure is reported with the reason.

## Debugging and logging

Cinnamon prints desklet errors and warnings to the journal. To watch them:

```sh
journalctl -f -o cat /usr/bin/cinnamon
```

Turn on **Verbose debug logging** in the desklet settings for detailed MPRIS
tracing: player discovery and disappearance, the chosen active player, property
changes, artwork sources, and ignored control calls. Messages are prefixed
`UniversalMusicDesklet:`.

Useful checks:

```sh
# Is any MPRIS player on the bus at all?
dbus-send --session --dest=org.freedesktop.DBus --type=method_call \
  --print-reply /org/freedesktop/DBus org.freedesktop.DBus.ListNames | grep MPRIS

# Read a player's metadata directly.
dbus-send --session --print-reply --dest=org.mpris.MediaPlayer2.vlc \
  /org/mpris/MediaPlayer2 org.freedesktop.DBus.Properties.Get \
  string:org.mpris.MediaPlayer2.Player string:Metadata
```

If `ListNames` shows no MPRIS names, the problem is the player, not the desklet:
the application is either not running or not MPRIS-capable.

## Development

```
desklet.js               Cinnamon entry point, required `main()` function
metadata.json            UUID, name, description, supported Cinnamon versions
settings-schema.json     Setting definitions for the settings dialog
stylesheet.css           All visual styling, loaded automatically by Cinnamon
lib/mpris.js             MPRIS protocol layer
lib/player-manager.js    Discovery and active-player selection
lib/artwork-manager.js   Artwork resolution and fallback
icons/                   Symbolic icon, added to the icon theme search path
```

The `lib/` modules depend only on GJS and GIO, never on Cinnamon, so they can be
tested headlessly with `cjs` against a synthetic MPRIS player. Each is a
CommonJS-style module, loaded the same way Cinnamon loads `desklet.js`.

### Gotchas that cost real debugging time

Each of these caused a failure that unit tests alone did not catch, and each is
now covered by a test:

- **Cinnamon's `require()` resolves against the extension root, not the calling
  file.** From `lib/player-manager.js`, `require('./mpris')` looks for
  `<root>/mpris.js` and the whole desklet fails to load. It must be
  `require('lib/mpris')`.
- **`Gio.File.load_contents_async` takes `(cancellable, callback)`, not
  `(priority, cancellable, callback)`.** The three-argument form logs a critical
  and then throws.
- **St has no usable byte-based image loader in Cinnamon 6.6.**
  `load_file_async` and `load_gicon_async` never call back, and
  `load_from_raw` returns a blank, unsizable actor with no paint volume. Bytes
  have to go to a cache file that an `St.Icon` is pointed at with a
  `Gio.FileIcon`.
- **MPRIS does not require `PropertiesChanged` for `Position`.** A cached read
  stays frozen; it has to be re-read from the bus.
- **Proxies are asynchronous.** Reading properties in the constructor sees
  nothing. `MprisPlayer` emits `ready` when both proxies exist.
- **`_()` is a Cinnamon global.** It only exists inside the Cinnamon process, so
  headless tests must define it.
- **Returning `EVENT_STOP` from a `button-release-event` handler silently breaks
  `St.Button`.** `St.Button` emits `clicked` from its class closure for
  `button-release-event`, and GObject runs class closures *after* handlers added
  with `connect()`. A stop therefore prevents `clicked` from ever firing and
  leaves the button stuck pressed, holding an input grab that swallows every
  later click. The same applies to Cinnamon's `Desklet`, which needs the event
  to propagate to open the configuration menu.

### Verifying a change

Restart Cinnamon in place and watch the log:

```sh
cinnamon --replace 2>&1 | tee /tmp/cinnamon.log
grep -i "universal-music-desklet" /tmp/cinnamon.log
```

A successful load prints `Loaded desklet universal-music-desklet@robbyjhay in
... ms`. Then check the live widget tree, which is the only way to confirm the
UI actually shows what you think it does:

```sh
dbus-send --session --dest=org.Cinnamon --print-reply /org/Cinnamon \
  org.Cinnamon.Eval string:"imports.ui.deskletManager.getDefinitions()"
```

Inspecting a live desklet through `org.Cinnamon.Eval` is much more useful than
reading the source when debugging what is on screen.

## License

MIT. Copyright (c) 2026 Robby Jhay. See [LICENSE](LICENSE).

## Cinnamon Spices

This project is intended for eventual submission to
[Cinnamon Spices](https://cinnamon-spices.linuxmint.com/). The UUID
`universal-music-desklet@robbyjhay` is not yet registered there. Before
submission the project needs a working icon, a description and screenshots on
the Spices listing, translations, and a version tagged for review. Until then,
this is a local installation only.
