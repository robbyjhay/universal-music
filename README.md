# Universal Music

**Universal Music** is an open-source media player widget for **Cinnamon Linux**, powered by [MPRIS](https://specifications.freedesktop.org/mpris-spec/latest/) over D-Bus.

It provides a unified interface for viewing and controlling media playback across compatible players and browser-based media sources, without relying on player-specific integrations.

Universal Music is currently available as a **Cinnamon Desklet**, with a **Cinnamon panel Applet** planned for a future release.

**Current release: v0.1.0**

---

## Features

- Automatic MPRIS player discovery
- Automatic active-player selection
- Song title and artist
- Playback status
- Live playback progress
- Album artwork
- Previous, Play/Pause, and Next controls
- Preferred-player selection
- Configurable widget size and opacity
- Optional artwork and playback controls
- Debug logging
- No npm packages
- No build step
- No additional runtime dependencies

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

These tests covered player detection, metadata, playback state, live progress, artwork where provided, and transport controls.

Compatibility is based on the standard MPRIS interface rather than dedicated integrations for individual applications.

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