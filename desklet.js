// desklet.js - Universal Music
//
// A Cinnamon desklet that shows and controls the media currently playing on
// the desktop. All media integration goes through MPRIS over D-Bus; there is
// no player specific code anywhere in this project, so any application that
// implements the MPRIS specification works without modification.
//
// Layering:
//   desklet.js                Cinnamon integration, widgets, settings
//   lib/player-manager.js     which MPRIS player is active
//   lib/mpris.js              MPRIS protocol access
//   lib/artwork-manager.js    album artwork resolution
//
// The visual design lives in stylesheet.css; this file only sets style classes.

const Clutter = imports.gi.Clutter;
const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const Pango = imports.gi.Pango;
const St = imports.gi.St;

const Desklet = imports.ui.desklet;
const Settings = imports.ui.settings;

const Mpris = require('./lib/mpris');
const { PlayerManager } = require('./lib/player-manager');
const { ArtworkManager, classNameForType } = require('./lib/artwork-manager');

const DESKLET_TITLE = _('Universal Music');
const PLACEHOLDER_TEXT = _('No media playing');

/* Size presets offered in the settings. The pixel values are mirrored by the
 * .umd-size-* classes in stylesheet.css. */
const SIZE_CLASSES = {
    small: 'umd-size-small',
    medium: 'umd-size-medium',
    large: 'umd-size-large',
};

const DEFAULT_SIZE = 'medium';

/* Artwork is rendered at a fixed size per preset, through an St.Icon.
 *
 * The size has to be given explicitly. The placeholder is an St.Icon, which
 * reports a preferred size, but nothing else here does, so leaving the artwork
 * area to its contents collapsed it to a 5px sliver in the St.BoxLayout: covers
 * downloaded and decoded perfectly but rendered invisibly. */
const ARTWORK_SIZES = {
    small: 48,
    medium: 64,
    large: 88,
};

/* Mirrors the padding on .umd-artwork in stylesheet.css.
 *
 * The container is sized to hold the icon, so it has to be the icon size plus
 * this padding on each side. Without it the padding would eat into the icon's
 * square content box and stretch a square cover to a 48x44 rectangle. */
const ARTWORK_PADDING = 2;

/* Cover art is handed to St as encoded bytes, and this St build has no
 * byte-based image loader that works. St.TextureCache.load_from_raw() is the
 * only one, and it is non-functional here: it accepts a pixbuf, returns a
 * ClutterActor, and that actor stays 1x1, has no paint volume, and ignores
 * set_width()/set_size() no matter how the data, alpha flag, or resource scale
 * are passed. St.TextureCache.load_file_async() and load_gicon_async() never
 * complete either, so neither can be used directly.
 *
 * St.Icon with a Gio.FileIcon is the path that does work, because that is the
 * same machinery Cinnamon itself uses to display icons. St has no API for
 * feeding it raw bytes, so the bytes are written to a file in the user's cache
 * directory and pointed at by that file icon.
 *
 * Each load uses a fresh file name because St caches textures by path: reusing
 * one path for every track would keep showing the first cover. The previous
 * file is removed once it has been replaced, so the directory holds at most
 * two files. */
const ARTWORK_CACHE_SUBDIR = 'universal-music-desklet';

/* Shown whenever there is no usable artwork. */
const PLACEHOLDER_ICON = 'audio-x-generic-symbolic';

/* How often the elapsed time label is refreshed while playing. MPRIS exposes
 * Position as a plain property, and players are not required to emit a change
 * notification for it, so the label is re-read on a timer instead. */
const POSITION_TICK_MS = 1000;

class UniversalMusicDesklet extends Desklet.Desklet {
    constructor(metadata, deskletId) {
        super(metadata, deskletId);

        this.setHeader(DESKLET_TITLE);

        /* Verbose logging is off by default; the bound setting below flips
         * debugLogging on, and _logger checks it on every call. */
        this._logger = {
            debug: message => {
                if (this.debugLogging)
                    global.log(`UniversalMusicDesklet: ${message}`);
            },
        };

        /* Recoverable errors are always reported, not just under verbose
         * logging: a silent failure here is a desklet that looks broken with
         * no clue why. The underlying error is appended so the log line is
         * actionable rather than just the message. */
        this._onError = (message, error) => {
            const prefix = `UniversalMusicDesklet: ${message}`;

            if (error) {
                const detail = error.message || String(error);
                global.logError(`${prefix} (${detail})`);
            } else {
                global.logWarning(prefix);
            }
        };

        this._playerManager = null;
        this._artworkManager = null;
        this._activePlayerSignals = [];
        this._positionTimerId = 0;
        this._positionAnchorUs = 0;
        this._positionAnchorMs = 0;
        this._artworkRequestSerial = 0;

        this._buildUI();
        this._initSettings();
        this._initMedia();
        this._applySettings();

        this.setContent(this._root);
        this._addMenuItems();
    }

    /* ------------------------------------------------------------------ UI */

    _buildUI() {
        this._root = new St.BoxLayout({
            style_class: 'umd-root',
            vertical: true,
            reactive: true,
            track_hover: true,
        });

        this._buildArtwork();
        this._buildInfo();
        this._buildControls();

        /* Clicking the body is a shortcut for play/pause, which is what users
         * expect from a media widget.
         *
         * This must NOT return EVENT_STOP. Cinnamon's Desklet connects its own
         * button-release handler on the desklet container, which is an ancestor
         * of this actor, and needs the event to reach it in order to open the
         * configuration menu on button 3. Stopping propagation here swallowed
         * that, so a right click anywhere on the widget played or paused the
         * music instead of opening the menu. */
        this._root.connect('button-release-event', (_actor, event) => {
            /* Left button only. Button 3 belongs to Cinnamon's own handler,
             * and reacting to it here is what made the menu unreachable. */
            if (event.get_button() === Clutter.BUTTON_PRIMARY &&
                /* The transport buttons run their own 'clicked' handler, so
                 * toggling here as well would send PlayPause twice per click. */
                !this._isControlActor(event.get_source()))
                this._togglePlayPause();

            return Clutter.EVENT_PROPAGATE;
        });
    }

    /* True when the actor is one of the transport buttons, or is inside one.
     * The event source is the deepest actor under the pointer, which is the
     * St.Icon inside a button rather than the button itself, so the whole
     * ancestor chain is checked. */
    _isControlActor(actor) {
        while (actor) {
            if (actor === this._previousButton ||
                actor === this._playPauseButton ||
                actor === this._nextButton)
                return true;

            actor = actor.get_parent();
        }

        return false;
    }

    _buildArtwork() {
        this._artworkBin = new St.Bin({
            style_class: 'umd-artwork',
            x_align: Clutter.ActorAlign.CENTER,
        });

        /* One icon for both states, always driven through set_gicon: the
         * placeholder is a themed icon and real artwork is a file-backed one.
         * St.Icon clears the previous source on every set_gicon call, and
         * passing null is not allowed. */
        this._artworkIcon = new St.Icon({
            style_class: 'umd-artwork-image',
            icon_size: ARTWORK_SIZES[DEFAULT_SIZE],
        });

        this._showArtworkPlaceholder();
        this._artworkBin.set_child(this._artworkIcon);

        this._root.add_child(this._artworkBin);
    }

    _buildInfo() {
        this._infoBin = new St.BoxLayout({
            style_class: 'umd-info',
            vertical: true,
            x_expand: true,
        });

        this._titleLabel = this._createLabel('umd-title', PLACEHOLDER_TEXT);
        this._artistLabel = this._createLabel('umd-artist', '');
        this._positionLabel = this._createLabel('umd-position', '');

        this._infoBin.add_child(this._titleLabel);
        this._infoBin.add_child(this._artistLabel);
        this._infoBin.add_child(this._positionLabel);

        this._root.add_child(this._infoBin);
    }

    _createLabel(styleClass, text) {
        const label = new St.Label({
            style_class: styleClass,
            text,
            x_align: Clutter.ActorAlign.CENTER,
        });

        label.clutter_text.set_single_line_mode(true);
        label.clutter_text.set_ellipsize(Pango.EllipsizeMode.END);

        return label;
    }

    _buildControls() {
        this._controls = new St.BoxLayout({
            style_class: 'umd-controls',
            x_align: Clutter.ActorAlign.CENTER,
        });

        this._previousButton = this._createButton(
            'media-skip-backward-symbolic', _('Previous'), () => this._previous());
        this._playPauseButton = this._createButton(
            'media-playback-start-symbolic', _('Play/Pause'), () => this._togglePlayPause());
        this._nextButton = this._createButton(
            'media-skip-forward-symbolic', _('Next'), () => this._next());

        this._controls.add_child(this._previousButton);
        this._controls.add_child(this._playPauseButton);
        this._controls.add_child(this._nextButton);

        this._root.add_child(this._controls);
    }

    _createButton(iconName, accessibleName, callback) {
        const button = new St.Button({
            style_class: 'umd-button',
            child: new St.Icon({
                style_class: 'umd-button-icon',
                icon_name: iconName,
                icon_size: 22,
            }),
            can_focus: true,
            accessible_name: accessibleName,
        });

        button.connect('clicked', callback);

        /* Deliberately no button-release-event handler here.
         *
         * St.Button emits 'clicked' from the class closure for
         * button-release-event, and GObject runs class closures AFTER the
         * handlers connected with connect(). Returning EVENT_STOP from a
         * release handler therefore prevents the closure from ever running:
         * 'clicked' is never emitted, the button stays stuck in its pressed
         * state holding an input grab, and it swallows every later click.
         * Letting the event propagate instead lets St.Button complete the
         * click normally, and the body handler above skips events that came
         * from a button. */
        return button;
    }

    _addMenuItems() {
        this._menu.addSettingsAction(_('Settings'), 'settings');
    }

    /* ------------------------------------------------------------ Settings */

    _initSettings() {
        this.settings = new Settings.DeskletSettings(this, this.metadata.uuid, this.instance_id);

        this.settings.bind('widget-size', 'widgetSize', () => this._applySettings());
        this.settings.bind('opacity', 'opacity', () => this._applySettings());
        this.settings.bind('show-artwork', 'showArtwork', () => this._applySettings());
        this.settings.bind('show-controls', 'showControls', () => this._applySettings());
        this.settings.bind('preferred-player', 'preferredPlayer',
            () => this._playerManager?.setPreferredPlayer(this.preferredPlayer));
        this.settings.bind('debug-logging', 'debugLogging', () => {
            this._logger.debug('debug logging enabled');
        });
    }

    /* Applies every appearance setting. Called once at startup and again
     * whenever a bound setting changes. */
    _applySettings() {
        this._applySize();
        this._applyOpacity();
        this._applyArtworkVisibility();
        this._applyControlsVisibility();
    }

    _applySize() {
        const key = SIZE_CLASSES[this.widgetSize] ? this.widgetSize : DEFAULT_SIZE;

        for (const className of Object.values(SIZE_CLASSES))
            this._root.remove_style_class_name(className);

        this._root.add_style_class_name(SIZE_CLASSES[key]);

        this._applyArtworkSize();
    }

    _applyArtworkSize() {
        const key = SIZE_CLASSES[this.widgetSize] ? this.widgetSize : DEFAULT_SIZE;
        const size = ARTWORK_SIZES[key];
        const box = size + ARTWORK_PADDING * 2;

        this._artworkBin.set_width(box);
        this._artworkBin.set_height(box);
        this._artworkIcon.icon_size = size;
    }

    _applyOpacity() {
        /* St expects a 0-255 integer; the setting is a percentage. */
        const percent = Math.min(100, Math.max(10, Number(this.opacity) || 100));
        this._root.opacity = Math.round((percent / 100) * 255);
    }

    _applyArtworkVisibility() {
        if (this.showArtwork)
            this._artworkBin.show();
        else
            this._artworkBin.hide();
    }

    _applyControlsVisibility() {
        if (this.showControls)
            this._controls.show();
        else
            this._controls.hide();
    }

    /* -------------------------------------------------------------- Media */

    _initMedia() {
        this._playerManager = new PlayerManager({
            logger: this._logger,
            onError: this._onError,
        });

        this._artworkManager = new ArtworkManager({
            logger: this._logger,
            onError: this._onError,
        });

        this._playerManager.setPreferredPlayer(this.preferredPlayer);
        this._playerManager.connect('player-changed', () => this._onActivePlayerChanged());
        this._playerManager.start();

        this._artworkManager.connect('artwork-changed', () => this._updateArtwork());
        this._artworkManager.connect('artwork-loaded', () => this._updateArtwork());
        this._artworkManager.connect('artwork-failed', () => this._updateArtwork());
    }

    _trackPlayerSignals(player) {
        for (const { object, id } of this._activePlayerSignals) {
            try {
                object.disconnect(id);
            } catch (e) {
                /* The player may already be gone; nothing to undo. */
            }
        }

        this._activePlayerSignals = [];

        if (!player)
            return;

        const connect = (name, callback) => {
            this._activePlayerSignals.push({ object: player, id: player.connect(name, callback) });
        };

        connect('ready', () => this._updateFromPlayer());
        connect('metadata-changed', () => this._updateFromPlayer());
        connect('playback-status-changed', () => this._updateFromPlayer());
        connect('position-changed', () => this._updateFromPlayer());
        connect('capabilities-changed', () => this._updateFromPlayer());
    }

    _onActivePlayerChanged() {
        const player = this._playerManager.activePlayer;
        this._logger.debug(player ? `showing ${player.id}` : 'no active player');

        this._trackPlayerSignals(player);
        this._updateFromPlayer();
    }

    /* Single entry point that pulls the whole UI state from the active player.
     * Safe to call when there is no player at all. */
    _updateFromPlayer() {
        const player = this._playerManager.activePlayer;

        if (!player) {
            this._stopPositionTimer();
            this._setPlaceholder();
            this._artworkManager.setArtworkUrl(null);
            return;
        }

        const metadata = player.getMetadata();
        const status = player.getPlaybackStatus();
        const capabilities = player.getCapabilities();
        const hasTrack = player.hasTrack();

        this._titleLabel.set_text(
            Mpris.firstString(metadata[Mpris.MetadataKey.TITLE]) || player.playerName);
        this._artistLabel.set_text(Mpris.joinStrings(metadata[Mpris.MetadataKey.ARTIST]));

        this._artworkManager.setArtworkUrl(
            Mpris.firstString(metadata[Mpris.MetadataKey.ART_URL]) || null);

        this._setPlayPauseIcon(status);
        this._updateControlSensitivity(capabilities, hasTrack);
        this._updatePosition(player, status, hasTrack);
    }

    _setPlaceholder() {
        this._stopPositionTimer();
        this._positionAnchorUs = 0;

        this._titleLabel.set_text(PLACEHOLDER_TEXT);
        this._artistLabel.set_text('');
        this._positionLabel.set_text('');

        this._setPlayPauseIcon(Mpris.PlaybackStatus.STOPPED);
        this._updateControlSensitivity(null, false);
        this._updateArtwork();
    }

    _setPlayPauseIcon(status) {
        const iconName = status === Mpris.PlaybackStatus.PLAYING
            ? 'media-playback-pause-symbolic'
            : 'media-playback-start-symbolic';

        const child = this._playPauseButton.get_child();
        if (child)
            child.icon_name = iconName;
    }

    _updateControlSensitivity(capabilities, hasTrack) {
        const enabled = value => value === true;
        const canControl = capabilities ? enabled(capabilities.canControl) : false;

        this._playPauseButton.set_reactive(canControl);
        this._previousButton.set_reactive(canControl && enabled(capabilities.canGoPrevious));
        this._nextButton.set_reactive(canControl && enabled(capabilities.canGoNext));

        /* Dim the controls rather than hide them when there is nothing to
         * control, so the widget does not change shape while paused. */
        this._playPauseButton.opacity = hasTrack || canControl ? 255 : 128;
    }

    _updateArtwork() {
        const source = this._artworkManager.currentSource;
        const className = classNameForType(source.type);

        this._artworkBin.set_style_class_name(`umd-artwork ${className}`);

        /* The manager owns loading and only exposes bytes once the source has
         * actually resolved, so this needs no loading state of its own. */
        const contents = this._artworkManager.contents;
        if (contents)
            this._loadArtwork(contents);
        else
            this._showArtworkPlaceholder();
    }

    _showArtworkPlaceholder() {
        this._artworkIcon.icon_type = St.IconType.SYMBOLIC;
        this._artworkIcon.set_gicon(new Gio.ThemedIcon({ names: [PLACEHOLDER_ICON] }));
        this._artworkIcon.add_style_class_name('umd-artwork-placeholder');
    }

    /* Points the artwork icon at the downloaded bytes.
     *
     * St cannot be handed bytes directly on this version, so they are written
     * to a uniquely named file in the cache directory and referenced through a
     * Gio.FileIcon. St.Icon then decodes, scales to icon_size, and caches the
     * texture, and the aspect ratio is preserved by St itself. */
    _loadArtwork(contents) {
        this._artworkRequestSerial++;

        let path;
        try {
            path = this._writeArtworkCacheFile(contents);
        } catch (e) {
            this._onError('artwork could not be written to the cache', e);
            this._showArtworkPlaceholder();
            return;
        }

        this._artworkIcon.icon_type = St.IconType.REGULAR;
        this._artworkIcon.set_gicon(new Gio.FileIcon({
            file: Gio.File.new_for_path(path),
        }));
        this._artworkIcon.remove_style_class_name('umd-artwork-placeholder');

        /* The new cover is now referenced, so the previous file can go. */
        this._removeArtworkCacheFile(this._artworkCachePath);
        this._artworkCachePath = path;
    }

    _writeArtworkCacheFile(contents) {
        const dir = GLib.build_filenamev([
            GLib.get_user_cache_dir(), ARTWORK_CACHE_SUBDIR]);

        GLib.mkdir_with_parents(dir, 0o755);

        /* A fresh name per load, because St caches textures by path and would
         * otherwise keep showing the first cover for every later track. */
        const path = GLib.build_filenamev([
            dir, `cover-${this._artworkRequestSerial}`]);

        Gio.File.new_for_path(path).replace_contents(
            contents, null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null);

        return path;
    }

    _removeArtworkCacheFile(path) {
        if (!path)
            return;

        try {
            Gio.File.new_for_path(path).delete(null);
        } catch (e) {
            /* The cache directory is disposable, so a file that is already
             * gone is not worth reporting. */
        }
    }


    /* MPRIS does not push position updates, so the value is re-read from the
     * bus on a timer while playing. Between reads the display advances on its
     * own from the wall clock, so a player that never sends PropertiesChanged
     * still shows a moving elapsed time between polls. */
    _updatePosition(player, status, hasTrack) {
        const length = player.getLength();

        if (!hasTrack || length <= 0) {
            this._stopPositionTimer();
            return;
        }

        this._showPosition(player, player.getPosition());
        this._startPositionTimer(player);

        if (status !== Mpris.PlaybackStatus.PLAYING)
            this._stopPositionTimer();
    }

    _showPosition(player, position) {
        const length = player.getLength();

        if (length <= 0) {
            this._positionLabel.set_text('');
            return;
        }

        /* Anchor the extrapolation at the position just read. */
        this._positionAnchorUs = position >= 0 ? position : 0;
        this._positionAnchorMs = GLib.get_monotonic_time() / 1000;

        this._renderPosition(length);
    }

    _renderPosition(length) {
        const elapsedMs = GLib.get_monotonic_time() / 1000 - this._positionAnchorMs;
        const elapsedUs = this._positionAnchorUs + elapsedMs * 1000;

        /* Clamped to the track length so a player that reports no position, or
         * a slightly optimistic one, cannot run the counter past the end. */
        const clamped = Math.min(elapsedUs, length);
        this._positionLabel.set_text(`${formatTime(clamped)} / ${formatTime(length)}`);
    }

    _startPositionTimer(player) {
        if (this._positionTimerId > 0)
            return;

        this._positionTimerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, POSITION_TICK_MS, () => {
            if (this._playerManager.activePlayer !== player) {
                this._positionTimerId = 0;
                return GLib.SOURCE_REMOVE;
            }

            /* Re-read the real value, which re-anchors the extrapolation. */
            player.refreshPosition(position => {
                if (this._playerManager.activePlayer === player)
                    this._showPosition(player, position);
            });
            this._renderPosition(player.getLength());

            return GLib.SOURCE_CONTINUE;
        });
    }

    _stopPositionTimer() {
        if (this._positionTimerId > 0) {
            GLib.source_remove(this._positionTimerId);
            this._positionTimerId = 0;
        }
    }

    /* ------------------------------------------------------------ Controls */

    _togglePlayPause() {
        const player = this._playerManager?.activePlayer;

        if (!player) {
            this._logger.debug('play/pause ignored, no active player');
            return;
        }

        player.playPause();
    }

    _previous() {
        const player = this._playerManager?.activePlayer;

        if (!player) {
            this._logger.debug('previous ignored, no active player');
            return;
        }

        player.previous();
    }

    _next() {
        const player = this._playerManager?.activePlayer;

        if (!player) {
            this._logger.debug('next ignored, no active player');
            return;
        }

        player.next();
    }

    /* ------------------------------------------------------------ Lifecycle */

    on_desklet_added_to_desktop() {
        this._applySettings();
    }

    on_desklet_removed() {
        this._stopPositionTimer();
        this._trackPlayerSignals(null);

        this._artworkManager?.destroy();
        this._playerManager?.destroy();

        this._artworkManager = null;
        this._playerManager = null;
    }
}

/* Formats a microsecond count as m:ss, or h:mm:ss for long tracks. */
function formatTime(microseconds) {
    if (typeof microseconds !== 'number' || !Number.isFinite(microseconds) || microseconds < 0)
        return '--:--';

    const totalSeconds = Math.floor(microseconds / 1000000);
    const seconds = totalSeconds % 60;
    const totalMinutes = Math.floor(totalSeconds / 60);
    const minutes = totalMinutes % 60;
    const hours = Math.floor(totalMinutes / 60);

    const pad = value => String(value).padStart(2, '0');

    return hours > 0
        ? `${hours}:${pad(minutes)}:${pad(seconds)}`
        : `${minutes}:${pad(seconds)}`;
}

function main(metadata, deskletId) {
    return new UniversalMusicDesklet(metadata, deskletId);
}
