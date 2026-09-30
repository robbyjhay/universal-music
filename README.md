# Universal Music

**Universal Music** is an open-source media player widget for **Cinnamon Linux**, powered by [MPRIS](https://specifications.freedesktop.org/mpris-spec/latest/) over D-Bus.

It provides a unified interface for viewing and controlling media playback across compatible players and browser-based media sources, without relying on player-specific integrations.

Universal Music is currently available as a **Cinnamon Desklet**, with a **Cinnamon panel Applet** planned for a future release.

**Current release: v0.2.0**

---

## Features

- Automatic MPRIS player discovery
- Automatic active-player selection
- Song title and artist, with a scrolling title for long titles
- Playback status
- Live playback progress
- A seek bar: click to seek, drag the handle, and the position keeps up
  while playing
- Album artwork, sized to the space the desklet actually has
- A layout that follows the desklet: cover above the information, beside it,
  or a compact version when there is not enough room
- Previous, Play/Pause, and Next controls
- Preferred-player selection
- Configurable widget size and opacity
- Optional artwork and playback controls
- Debug logging
- No npm packages
- No build step
- No additional runtime dependencies

---

## Layout

The widget has no fixed layout. Every allocation it is given is measured, and
the shape is worked out from that: the cover and the information either stack or
sit side by side, and if there is not enough room for both, the artist line and
the time labels are dropped rather than the controls.

| Space available | Layout |
| --- | --- |
| Taller than wide, or square | Cover above the information |
| Clearly wider than tall | Cover to the left of the information |
| Very narrow or very short | Compact: the artist line and the time labels are hidden |

The cover is a square that grows into the width available to it, up to what the
size preset allows, and keeps its aspect ratio while doing so. A title too long
for the desklet scrolls inside the text column instead of widening the desklet.

The **Widget size** setting adds a **Wide** preset for the side by side layout.
It is the one setting that changes the shape rather than only the scale.

---

## Verified Compatibility

Universal Music has been tested with the following media sources:

- **Spotify Desktop**
- **Spotify Web Player**
- **Celluloid**
- **YouTube**
- **Firefox**
- **Google Chrome**
- **Rhythmbox**

These tests covered player detection, metadata, playback state, live progress, artwork where provided, transport controls, and, from v0.2.0, seeking.

Compatibility is based on the standard MPRIS interface rather than dedicated integrations for individual applications. Seeking is `org.mpris.MediaPlayer2.Player.SetPosition`, with a relative `Seek` for the players that report none; a player that reports `CanSeek` as false gets an inert timeline rather than a seek that silently does nothing.

---

## How It Works

Universal Music communicates with media players through **MPRIS**, a standard Linux interface for media-player control over D-Bus.

Because the project uses the common interface exposed by compatible applications, it does not require separate implementations for Spotify, VLC, Firefox, Chrome, or other supported media sources.

```text
                    Universal Music
                           │
                           ▼
                    Player Manager
                           │
                           ▼
                         MPRIS
                           │
                           ▼
                          D-Bus
                           │
            ┌──────────────┼──────────────┐
            │              │              │
         Spotify        Browsers        Players
         Desktop       Firefox/Chrome   Celluloid
         Web Player      YouTube        Rhythmbox