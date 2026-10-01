// lib/mpris.js
//
// Low level MPRIS (D-Bus) access for Universal Music.
//
// This module is deliberately player agnostic. It knows about the MPRIS
// specification and nothing else: there is no Spotify code, no VLC code and no
// Firefox code anywhere in this project. Everything the desklet shows or
// controls is read through the two standard MPRIS interfaces:
//
//   org.mpris.MediaPlayer2           - identity of the player
//   org.mpris.MediaPlayer2.Player    - playback control and metadata
//
// The desklet never talks to D-Bus directly; it uses MprisPlayer and
// PlayerManager (lib/player-manager.js).
//
// References:
//   https://specifications.freedesktop.org/mpris-spec/latest/

const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;

/* Bus name and object path shared by every MPRIS player. The only part that
 * differs between players is the bus name suffix, e.g. "vlc" or "spotify". */
const BUS_NAME_PREFIX = 'org.mpris.MediaPlayer2.';
const OBJECT_PATH = '/org/mpris/MediaPlayer2';

const ROOT_INTERFACE = 'org.mpris.MediaPlayer2';
const PLAYER_INTERFACE = 'org.mpris.MediaPlayer2.Player';
const TRACKER_INTERFACE = 'org.mpris.MediaPlayer2.Tracker';

/* The standard properties interface, used to re-read Position on demand. */
const PROPERTIES_INTERFACE = 'org.freedesktop.DBus.Properties';

/* org.mpris.MediaPlayer2.Player.PlaybackStatus */
const PlaybackStatus = Object.freeze({
    PLAYING: 'Playing',
    PAUSED: 'Paused',
    STOPPED: 'Stopped',
});

/* Well known keys of the Metadata a{sv} dictionary. Players are free to omit
 * any of them, so every read has to tolerate a missing key. */
const MetadataKey = Object.freeze({
    TRACK_ID: 'mpris:trackid',
    LENGTH: 'mpris:length',
    ART_URL: 'mpris:artUrl',
    ALBUM: 'xesam:album',
    ARTIST: 'xesam:artist',
    COMPOSER: 'xesam:composer',
    TITLE: 'xesam:title',
    TRACK_NUMBER: 'xesam:trackNumber',
    DISC_NUMBER: 'xesam:discNumber',
    GENRE: 'xesam:genre',
    COMMENT: 'xesam:comment',
    URL: 'xesam:url',
});

/* Properties of org.mpris.MediaPlayer2.Player, split into the ones that change
 * often and therefore need change notifications, and the "Can*" capabilities
 * that are cheap to read on demand. */
const PlayerProperty = Object.freeze({
    PLAYBACK_STATUS: 'PlaybackStatus',
    METADATA: 'Metadata',
    POSITION: 'Position',
    CAN_CONTROL: 'CanControl',
    CAN_GO_NEXT: 'CanGoNext',
    CAN_GO_PREVIOUS: 'CanGoPrevious',
    CAN_PLAY: 'CanPlay',
    CAN_PAUSE: 'CanPause',
    CAN_SEEK: 'CanSeek',
});

/* Properties of org.mpris.MediaPlayer2. */
const RootProperty = Object.freeze({
    CAN_QUIT: 'CanQuit',
    CAN_RAISE: 'CanRaise',
    IDENTITY: 'Identity',
    DESKTOP_ENTRY: 'DesktopEntry',
});

/* The subset of org.mpris.MediaPlayer2.Player we consume. Declaring the
 * interface by hand keeps the desklet independent of a particular GJS release:
 * Gio.DBusProxy.makeProxyWrapper() only binds the first <interface> element of
 * an XML document and its generated helpers have changed shape between GJS
 * versions, so we build explicit Gio.DBusProxy objects from this node info
 * instead and use Gio.DBusConnection.call() for methods. */
const PLAYER_INTROSPECTION_XML = `<node>
  <interface name="org.mpris.MediaPlayer2.Player">
    <method name="Next"/>
    <method name="Previous"/>
    <method name="Pause"/>
    <method name="PlayPause"/>
    <method name="Stop"/>
    <method name="Play"/>
    <method name="Seek">
      <arg name="Offset" type="x" direction="in"/>
    </method>
    <method name="SetPosition">
      <arg name="TrackId" type="o" direction="in"/>
      <arg name="Position" type="x" direction="in"/>
    </method>
    <method name="OpenUri">
      <arg name="Uri" type="s" direction="in"/>
    </method>
    <signal name="Seeked">
      <arg name="Position" type="x"/>
    </signal>
    <property name="PlaybackStatus" type="s" access="read"/>
    <property name="LoopStatus" type="s" access="read"/>
    <property name="Rate" type="d" access="read"/>
    <property name="Shuffle" type="b" access="read"/>
    <property name="Metadata" type="a{sv}" access="read"/>
    <property name="Volume" type="d" access="read"/>
    <property name="Position" type="x" access="read"/>
    <property name="MinimumRate" type="d" access="read"/>
    <property name="MaximumRate" type="d" access="read"/>
    <property name="CanGoNext" type="b" access="read"/>
    <property name="CanGoPrevious" type="b" access="read"/>
    <property name="CanPlay" type="b" access="read"/>
    <property name="CanPause" type="b" access="read"/>
    <property name="CanSeek" type="b" access="read"/>
    <property name="CanControl" type="b" access="read"/>
  </interface>
</node>`;

const ROOT_INTROSPECTION_XML = `<node>
  <interface name="org.mpris.MediaPlayer2">
    <method name="Raise"/>
    <method name="Quit"/>
    <property name="CanQuit" type="b" access="read"/>
    <property name="CanRaise" type="b" access="read"/>
    <property name="HasTrackList" type="b" access="read"/>
    <property name="Identity" type="s" access="read"/>
    <property name="DesktopEntry" type="s" access="read"/>
    <property name="SupportedUriSchemes" type="as" access="read"/>
    <property name="SupportedMimeTypes" type="as" access="read"/>
  </interface>
</node>`;

/* D-Bus method calls to a media player are local and answer immediately.
 * The timeout only exists so that a wedged player cannot block the desklet. */
const MPRIS_CALL_TIMEOUT_MS = 2000;

let _playerInterfaceInfo = null;
let _rootInterfaceInfo = null;

function getPlayerInterfaceInfo() {
    if (_playerInterfaceInfo === null) {
        const node = Gio.DBusNodeInfo.new_for_xml(PLAYER_INTROSPECTION_XML);
        _playerInterfaceInfo = node.lookup_interface(PLAYER_INTERFACE);
    }
    return _playerInterfaceInfo;
}

function getRootInterfaceInfo() {
    if (_rootInterfaceInfo === null) {
        const node = Gio.DBusNodeInfo.new_for_xml(ROOT_INTROSPECTION_XML);
        _rootInterfaceInfo = node.lookup_interface(ROOT_INTERFACE);
    }
    return _rootInterfaceInfo;
}

/**
 * isPlayerBusName
 * @busName (string): a D-Bus well known name.
 *
 * True if the name looks like an MPRIS player bus name. This is a name shape
 * check only, it does not imply that the name is currently owned.
 */
function isPlayerBusName(busName) {
    return typeof busName === 'string' &&
        busName.startsWith(BUS_NAME_PREFIX) &&
        busName.length > BUS_NAME_PREFIX.length;
}

/**
 * playerIdFromBusName
 * @busName (string): e.g. "org.mpris.MediaPlayer2.vlc".
 *
 * The human readable part of the bus name, e.g. "vlc". This is the value the
 * "preferred player" setting is matched against.
 */
function playerIdFromBusName(busName) {
    return isPlayerBusName(busName) ? busName.slice(BUS_NAME_PREFIX.length) : busName;
}

/**
 * busNameFromPlayerId
 * @playerId (string): e.g. "vlc".
 *
 * Inverse of playerIdFromBusName(). Also accepts a fully qualified bus name so
 * that users can paste either form into the "preferred player" setting.
 */
function busNameFromPlayerId(playerId) {
    const id = (playerId || '').trim();
    if (id === '')
        return null;
    return id.startsWith(BUS_NAME_PREFIX) ? id : BUS_NAME_PREFIX + id;
}

/**
 * unpackVariant
 * @variant (GLib.Variant): a variant, or null.
 *
 * Recursively unpacks a variant into plain JavaScript values.
 *
 * GJS exposes two unpacking APIs and only one of them is usable here:
 * Variant.unpack() returns "boxed" values and turns a string array into an
 * array of empty objects, which silently destroys xesam:artist. Only
 * deepUnpack() recurses properly, so every read goes through this helper.
 */
function unpackVariant(variant) {
    if (variant === null || variant === undefined)
        return null;

    if (typeof variant.deepUnpack !== 'function')
        return null;

    try {
        return variant.deepUnpack();
    } catch (e) {
        return null;
    }
}

/**
 * unpackMetadata
 * @variant (GLib.Variant): the Metadata property, an a{sv} dictionary.
 *
 * Converts MPRIS metadata into a flat plain object whose values are plain
 * JavaScript (string, number, boolean or array). Keys that are not present
 * are simply missing from the result, which is normal: players only publish
 * the fields they actually know.
 */
function unpackMetadata(variant) {
    const metadata = {};

    const dictionary = unpackVariant(variant);
    if (dictionary === null || typeof dictionary !== 'object')
        return metadata;

    for (const key in dictionary) {
        if (!Object.prototype.hasOwnProperty.call(dictionary, key))
            continue;
        const value = unpackVariant(dictionary[key]);
        if (value !== null && value !== undefined)
            metadata[key] = value;
    }

    return metadata;
}

/**
 * mergeTrackMetadata
 * @previous (object): the metadata currently on display, as unpackMetadata()
 *                     returned it. May be null or empty.
 * @next (object): a newly unpacked snapshot of the same player's metadata.
 *
 * Keeps a field the player has stopped reporting while the track it belongs to
 * is still the one being shown.
 *
 * Some players publish a track in more than one step, and the steps are not
 * equally complete. Spotify, for one, announces the track that is coming next
 * with the artists folded into the title and with xesam:artist carrying nothing
 * but an empty string, and only publishes the real values a moment later. That
 * is a partial record of the same track, not a track without an artist, and
 * taking it at face value blanks the artist line and shows a title that has the
 * artist names spliced into it for as long as the gap lasts.
 *
 * So a snapshot is only allowed to remove a field while it is still talking
 * about the track that field was read from. The track id is what identifies
 * that: a snapshot for a different track, or for none at all, is a new record
 * and is taken exactly as it arrives, so a track that really has no artist
 * still shows no artist rather than inheriting the previous one's.
 *
 * Nothing is invented here. A carried field is one this same player reported
 * for this same track moments ago, so every value in the result is still the
 * player's own; what this does is refuse to let an incomplete snapshot destroy
 * the complete one that preceded it.
 *
 * A snapshot that reports nothing at all is left alone as well. It is what a
 * player publishes while it has no track loaded, and treating it as an empty
 * record for the current track would clear a display that is still correct.
 */
function mergeTrackMetadata(previous, next) {
    if (!previous || typeof previous !== 'object')
        return next || {};

    if (!next || typeof next !== 'object')
        return next || {};

    /* A snapshot with nothing in it is not a record of anything, which is what
     * a player publishes while it has no track loaded. It is not taken as an
     * empty record for the track on screen, because that would clear a display
     * that is still correct. */
    if (Object.keys(next).length === 0)
        return previous;

    const sameTrack = trackIdentity(previous) === trackIdentity(next);

    if (!sameTrack)
        return next;

    const merged = Object.assign({}, next);

    for (const key in previous) {
        if (!Object.prototype.hasOwnProperty.call(previous, key))
            continue;

        /* Only a field this snapshot has nothing to say about is carried over.
         * A field it reports, however briefly, is what it means. */
        if (!isUnreported(next, key))
            continue;

        const value = previous[key];

        if (value === null || value === undefined)
            continue;

        merged[key] = value;
    }

    return merged;
}

/* The fields whose value is text, and for which text that is not there is the
 * same as nothing having been said. Anything else (a length, a track number, a
 * bit rate) carries its meaning in the number itself, and zero is an answer. */
const TEXT_METADATA_KEYS = new Set([
    MetadataKey.ALBUM,
    MetadataKey.ARTIST,
    MetadataKey.COMPOSER,
    MetadataKey.TITLE,
    MetadataKey.GENRE,
    MetadataKey.COMMENT,
    MetadataKey.URL,
]);

/**
 * isUnreported
 * @metadata (object): a snapshot.
 * @key (string): a metadata key.
 *
 * True when the snapshot says nothing usable about this key, so it should not be
 * allowed to remove what is already on display.
 *
 * A key that is not there at all is the easy case. The one that matters in
 * practice is a text key that is there and empty: Spotify publishes the artists
 * of a track it is still preparing as xesam:artist carrying a single empty
 * string rather than leaving the key out, which reads as an artist who is named
 * as the empty string and blanks the artist line when it is displayed.
 *
 * Artwork is not one of these keys. A cover can legitimately change while the
 * same track plays, so an art url that is absent is an omission to be carried
 * over but its emptiness is not something to second guess.
 */
function isUnreported(metadata, key) {
    if (!Object.prototype.hasOwnProperty.call(metadata, key))
        return true;

    if (!TEXT_METADATA_KEYS.has(key))
        return false;

    const value = metadata[key];

    return firstString(value) === '' && joinStrings(value) === '';
}

/* What a snapshot is a record of: its track id, or an empty string when it has
 * none. Compared rather than used to display anything, so it is only as precise
 * as MPRIS makes it.
 *
 * Two snapshots with no track id are the same record as far as this is
 * concerned, which is deliberate: a player that reports no track id at all is
 * reporting one track, and a change of track will come with a track id. */
function trackIdentity(metadata) {
    return firstString(metadata[MetadataKey.TRACK_ID]);
}

/**
 * firstString
 * @value: a string, an array of strings, or anything else.
 *
 * MPRIS declares most text fields as string arrays but players are
 * inconsistent and frequently send a bare string instead. Collapse both shapes
 * to a single string, and drop empty results so callers can test for truthiness.
 */
function firstString(value) {
    if (typeof value === 'string')
        return value.trim();

    if (Array.isArray(value)) {
        for (const entry of value) {
            if (typeof entry === 'string' && entry.trim() !== '')
                return entry.trim();
        }
    }

    return '';
}

/**
 * joinStrings
 * @value: a string, an array of strings, or anything else.
 *
 * Like firstString() but keeps every entry, for fields where the full list is
 * meaningful (multiple artists, multiple genres).
 */
function joinStrings(value) {
    if (typeof value === 'string')
        return value.trim();

    if (Array.isArray(value)) {
        return value
            .filter(entry => typeof entry === 'string')
            .map(entry => entry.trim())
            .filter(entry => entry !== '')
            .join(', ');
    }

    return '';
}

/**
 * MprisPlayer
 *
 * A single MPRIS player on the session bus. Owns one Gio.DBusProxy for the
 * Player interface (which keeps every property of that interface cached and
 * watched for change) and a second one for the root interface, used only for
 * the player's display name.
 *
 * Reads are synchronous because GDBus keeps the property cache up to date;
 * there is no need to poll. Control methods are asynchronous and report
 * failures through the logger and the optional error callback.
 *
 * Signals:
 *   ready                     - both proxies are built, properties are readable
 *   metadata-changed          - the Metadata property changed
 *   playback-status-changed   - the PlaybackStatus property changed
 *   position-changed          - a Seeked signal arrived from the player
 *   capabilities-changed      - one of the Can* properties changed
 *   owner-changed             - the bus name appeared or disappeared
 */
const MprisPlayer = GObject.registerClass({
    Signals: {
        'ready': {},
        'metadata-changed': {},
        'playback-status-changed': {},
        'position-changed': {},
        'capabilities-changed': {},
        'owner-changed': {},
    },
}, class MprisPlayer extends GObject.Object {
    /**
     * _init
     * @busName (string): the MPRIS bus name, e.g. "org.mpris.MediaPlayer2.vlc".
     * @options (object):
     *   bus: Gio.DBusConnection to use, defaults to the session bus.
     *   logger: object with a debug(message) method, or null.
     *   onError: function(message, error), called for every recoverable error.
     */
    _init(busName, options = {}) {
        super._init();

        this._busName = busName;
        this._id = playerIdFromBusName(busName);
        this._connection = options.bus || Gio.DBus.session;
        this._logger = options.logger || null;
        this._onError = options.onError || null;

        this._cancellable = new Gio.Cancellable();
        this._playerProxy = null;
        this._rootProxy = null;
        /* Signal ids are global, not per-instance, and the two proxies get
         * separate ones, so each id is remembered next to the proxy it belongs
         * to. Disconnecting an id against the wrong object emits a critical. */
        this._handlers = [];
        this._nameOwner = null;
        this._ready = false;
        this._destroyed = false;
        /* The metadata currently on display, so that a snapshot which is only
         * part of a track can be told apart from one that replaces it. */
        this._metadata = {};

        this._buildPlayerProxy();
        this._buildRootProxy();
    }

    get busName() {
        return this._busName;
    }

    /* The bus name suffix, e.g. "vlc". Matches the "preferred player" setting. */
    get id() {
        return this._id;
    }

    get objectPath() {
        return OBJECT_PATH;
    }

    /* True while the player actually owns its bus name. */
    get available() {
        return this._nameOwner !== null;
    }

    get playerName() {
        return firstString(this._readProperty(this._rootProxy, RootProperty.IDENTITY)) ||
            this._id;
    }

    _reportError(message, error) {
        if (this._logger)
            this._logger.debug(`${this._id}: ${message}`);

        if (this._onError) {
            try {
                this._onError(`${this._id}: ${message}`, error || null);
            } catch (e) {
                /* Never let a logging callback break the desklet. */
            }
        }
    }

    _createProxy(interfaceInfo, watchOwner) {
        /* DO_NOT_AUTO_START is important: discovering players must never cause
         * an MPRIS application to be launched. We only ever talk to players the
         * user has already started. */
        const flags = Gio.DBusProxyFlags.DO_NOT_AUTO_START;

        Gio.DBusProxy.new(
            this._connection,
            flags,
            interfaceInfo,
            this._busName,
            OBJECT_PATH,
            interfaceInfo.name,
            this._cancellable,
            (source, result) => {
                if (this._destroyed)
                    return;

                let proxy;
                try {
                    proxy = Gio.DBusProxy.new_finish(result);
                } catch (e) {
                    this._reportError('could not create D-Bus proxy', e);
                    return;
                }

                this._onProxyReady(proxy, interfaceInfo, watchOwner);
            });
    }

    _buildPlayerProxy() {
        this._createProxy(getPlayerInterfaceInfo(), false);
    }

    _buildRootProxy() {
        this._createProxy(getRootInterfaceInfo(), true);
    }

    /* Remember a signal connection together with the object it belongs to. */
    _connect(proxy, signal, callback) {
        this._handlers.push({ proxy, id: proxy.connect(signal, callback) });
    }

    _onProxyReady(proxy, interfaceInfo, watchOwner) {
        if (watchOwner) {
            this._rootProxy = proxy;
            this._connect(proxy, 'notify::g-name-owner', () => this._refreshNameOwner());
        } else {
            this._playerProxy = proxy;
            this._connect(proxy, 'g-properties-changed',
                (_proxy, changed, invalidated) => this._onPropertiesChanged(changed, invalidated));
            this._connect(proxy, 'g-signal',
                (_proxy, _sender, signal, parameters) => this._onSignal(signal, parameters));
            this._connect(proxy, 'notify::g-name-owner', () => this._refreshNameOwner());
        }

        this._refreshNameOwner();
        this._maybeEmitReady();
    }

    /* Both proxies are built asynchronously and independently, so the player
     * only becomes readable once the second one arrives. Consumers wait for
     * 'ready' rather than reading properties at construction time. */
    _maybeEmitReady() {
        if (this._ready || !this._rootProxy || !this._playerProxy)
            return;

        this._ready = true;
        this.emit('ready');
    }

    _refreshNameOwner() {
        const proxy = this._rootProxy;
        if (!proxy)
            return;

        let owner = null;
        try {
            owner = proxy.get_name_owner();
        } catch (e) {
            owner = null;
        }

        if (owner === this._nameOwner)
            return;

        const appeared = this._nameOwner === null && owner !== null;
        const vanished = this._nameOwner !== null && owner === null;

        this._nameOwner = owner;

        if (this._logger) {
            this._logger.debug(`${this._id}: bus name ${vanished ? 'disappeared' : (appeared ? 'appeared' : 'owner changed')}`);
        }

        this.emit('owner-changed');
    }

    /* The g-properties-changed signal carries the names of changed properties
     * in the first argument, as an a{sv} dictionary of their new values, and
     * the names of properties whose value is no longer available in the second
     * argument. Reading only the second argument is a common mistake: it is
     * almost always empty, which would make the desklet appear frozen. */
    _onPropertiesChanged(changed, invalidated) {
        const changedNames = Object.keys(unpackVariant(changed) || {});
        const invalidatedNames = Array.isArray(invalidated) ? invalidated : [];
        const names = new Set([...changedNames, ...invalidatedNames]);

        if (this._logger) {
            this._logger.debug(
                `${this._id}: properties changed (${[...names].join(', ') || 'none'})`);
        }

        if (names.has(PlayerProperty.METADATA))
            this.emit('metadata-changed');

        if (names.has(PlayerProperty.PLAYBACK_STATUS))
            this.emit('playback-status-changed');

        for (const name of names) {
            if (name.startsWith('Can'))
                this.emit('capabilities-changed');
        }
    }

    _onSignal(signal, parameters) {
        if (signal !== 'Seeked')
            return;

        const unpacked = unpackVariant(parameters);
        if (this._logger)
            this._logger.debug(`${this._id}: Seeked ${unpacked === null ? '?' : unpacked}`);

        this.emit('position-changed');
    }

    _readProperty(proxy, name) {
        if (!proxy)
            return null;

        try {
            return unpackVariant(proxy.get_cached_property(name));
        } catch (e) {
            return null;
        }
    }

    /* Reading accessors. All of them are safe to call at any time, including
     * before the proxy finished loading and while the player is gone. */

    getPlaybackStatus() {
        const status = this._readProperty(this._playerProxy, PlayerProperty.PLAYBACK_STATUS);
        return Object.values(PlaybackStatus).includes(status) ? status : PlaybackStatus.STOPPED;
    }

    isPlaying() {
        return this.getPlaybackStatus() === PlaybackStatus.PLAYING;
    }

    getMetadata() {
        const snapshot = unpackMetadata(this._cachedVariant(PlayerProperty.METADATA));

        /* Merged onto what is already on display rather than replacing it, so a
         * snapshot that is only part of a track cannot clear the parts it leaves
         * out. A different track is a different record and replaces everything. */
        const merged = mergeTrackMetadata(this._metadata, snapshot);

        /* Kept so the next snapshot can be compared against it, and not kept
         * when it is unchanged so a player that re-sends identical metadata
         * does not churn this. */
        if (merged !== this._metadata)
            this._metadata = merged;

        return merged;
    }

    getCapabilities() {
        const read = name => this._readProperty(this._playerProxy, name) === true;
        return Object.freeze({
            canControl: read(PlayerProperty.CAN_CONTROL),
            canPlay: read(PlayerProperty.CAN_PLAY),
            canPause: read(PlayerProperty.CAN_PAUSE),
            canGoNext: read(PlayerProperty.CAN_GO_NEXT),
            canGoPrevious: read(PlayerProperty.CAN_GO_PREVIOUS),
            canSeek: read(PlayerProperty.CAN_SEEK),
        });
    }

    getIdentity() {
        return this.playerName;
    }

    getDesktopEntry() {
        return this._readProperty(this._rootProxy, RootProperty.DESKTOP_ENTRY) || '';
    }

    _cachedVariant(name) {
        if (!this._playerProxy)
            return null;

        try {
            return this._playerProxy.get_cached_property(name);
        } catch (e) {
            return null;
        }
    }

    /**
     * getPosition
     *
     * The playback position in microseconds, or -1 when the player does not
     * report one. Note that MPRIS exposes Position as a property that is not
     * guaranteed to be updated while playing; callers that need a smooth
     * progress bar should extrapolate between two reads of this value.
     */
    getPosition() {
        const position = this._readProperty(this._playerProxy, PlayerProperty.POSITION);
        return typeof position === 'number' ? position : -1;
    }

    /**
     * refreshPosition
     * @callback (function(Position): void) or null
     *
     * Re-reads Position from the bus, because the spec explicitly says players
     * are not required to emit a PropertiesChanged signal for it. Most players
     * therefore leave the cached value frozen at the track start, and a
     * progress display that trusts the cache never moves.
     *
     * Returns immediately; the callback receives the position in microseconds,
     * or -1 if the player does not report one. Failures are reported through
     * the logger rather than passed to the caller, so a dying player cannot
     * break a display that is polling on a timer.
     */
    refreshPosition(callback) {
        if (this._destroyed || !this.available || !this._playerProxy)
            return;

        try {
            this._connection.call(
                this._busName,
                OBJECT_PATH,
                PROPERTIES_INTERFACE,
                'Get',
                new GLib.Variant('(ss)', [PLAYER_INTERFACE, PlayerProperty.POSITION]),
                new GLib.VariantType('(v)'),
                Gio.DBusCallFlags.NONE,
                MPRIS_CALL_TIMEOUT_MS,
                this._cancellable,
                (connection, result) => {
                    if (this._destroyed)
                        return;

                    let position = -1;
                    try {
                        const reply = connection.call_finish(result);
                        position = unpackVariant(reply.deepUnpack()[0]);
                        if (typeof position !== 'number')
                            position = -1;
                    } catch (e) {
                        this._reportError('Position could not be read', e);
                    }

                    if (callback)
                        callback(position);
                });
        } catch (e) {
            this._reportError('Position could not be requested', e);
        }
    }

    /**
     * getLength
     *
     * The duration of the current track in microseconds, taken from
     * mpris:length. Returns 0 when the player does not know the duration.
     */
    getLength() {
        const metadata = this.getMetadata();
        const length = metadata[MetadataKey.LENGTH];
        return typeof length === 'number' && length > 0 ? length : 0;
    }

    /**
     * getArtworkUrl
     *
     * The first non empty mpris:artUrl of the current track, or null.
     * Resolution to a loadable image is the job of lib/artwork-manager.js.
     */
    getArtworkUrl() {
        return firstString(this.getMetadata()[MetadataKey.ART_URL]) || null;
    }

    /**
     * hasTrack
     *
     * True when the player reports a track id. MPRIS uses a track id of
     * "/org/mpris/MediaPlayer2/TrackList/NoTrack" to mean "nothing loaded".
     */
    hasTrack() {
        const trackId = firstString(this.getMetadata()[MetadataKey.TRACK_ID]);
        return trackId !== '' && !/NoTrack\/?$/i.test(trackId);
    }

    /* Playback control. Every call is fire and forget: the resulting D-Bus
     * error, if any, is reported through the logger and the error callback
     * rather than thrown, so a misbehaving player can never break the desklet. */

    playPause() {
        this._call('PlayPause');
    }

    play() {
        this._call('Play');
    }

    pause() {
        this._call('Pause');
    }

    stop() {
        this._call('Stop');
    }

    next() {
        this._call('Next');
    }

    previous() {
        this._call('Previous');
    }

    /**
     * setPosition
     * @positionUs (number): the absolute playback position in microseconds.
     *
     * Seeks to an absolute position using the standard SetPosition method.
     * Players that advertise no track id cannot be asked for an absolute
     * position, so for those the same target is reached with a relative Seek
     * from the current position, which every player implements.
     */
    setPosition(positionUs) {
        const target = Math.max(0, Math.round(Number(positionUs) || 0));
        const trackId = firstString(this.getMetadata()[MetadataKey.TRACK_ID]);

        if (trackId !== '') {
            this._call('SetPosition', new GLib.Variant('(ox)', [trackId, target]));
            return;
        }

        const current = this.getPosition();

        if (current < 0) {
            this._reportError('SetPosition ignored, the player reports no current position', null);
            return;
        }

        this._call('Seek', new GLib.Variant('(x)', [target - current]));
    }

    _call(method, parameters = null) {
        if (this._destroyed)
            return;

        if (!this.available) {
            this._reportError(`${method} ignored, player is not on the bus`, null);
            return;
        }

        try {
            this._connection.call(
                this._busName,
                OBJECT_PATH,
                PLAYER_INTERFACE,
                method,
                parameters,
                null,
                Gio.DBusCallFlags.NONE,
                MPRIS_CALL_TIMEOUT_MS,
                this._cancellable,
                (connection, result) => {
                    if (this._destroyed)
                        return;

                    try {
                        connection.call_finish(result);
                    } catch (e) {
                        this._reportError(`${method} failed`, e);
                    }
                });
        } catch (e) {
            this._reportError(`${method} could not be sent`, e);
        }
    }

    destroy() {
        if (this._destroyed)
            return;

        this._destroyed = true;

        if (this._cancellable)
            this._cancellable.cancel();

        for (const { proxy, id } of this._handlers) {
            try {
                proxy.disconnect(id);
            } catch (e) {
                /* The proxy may already be finalized; nothing to undo. */
            }
        }
        this._handlers = [];

        this._playerProxy = null;
        this._rootProxy = null;
        this._nameOwner = null;
    }
});

var mpris = {
    BUS_NAME_PREFIX,
    OBJECT_PATH,
    ROOT_INTERFACE,
    PLAYER_INTERFACE,
    TRACKER_INTERFACE,
    PlaybackStatus,
    MetadataKey,
    PlayerProperty,
    RootProperty,
    MprisPlayer,
    isPlayerBusName,
    playerIdFromBusName,
    busNameFromPlayerId,
    unpackVariant,
    unpackMetadata,
    mergeTrackMetadata,
    firstString,
    joinStrings,
};
