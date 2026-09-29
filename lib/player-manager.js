// lib/player-manager.js
//
// Discovers MPRIS players on the session bus and decides which one the desklet
// should show.
//
// The manager owns everything that is MPRIS-agnostic bookkeeping: it watches
// the bus for player names appearing and disappearing, keeps one MprisPlayer
// object per player, and applies the selection policy (an explicit preferred
// player, or automatic detection of whichever player is currently active).
//
// Automatic detection is intentionally simple and heuristic: the player that
// reports "Playing" wins, ties are broken by the player that most recently
// started playing. When nothing is playing the last active player is kept, so
// the desklet does not flicker between players while the user pauses.

const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;

/* Cinnamon's require() resolves paths against the extension root, not against
 * the directory of the calling file. The path must therefore be written as it
 * would be from the root, i.e. "lib/mpris" rather than "./mpris". */
const Mpris = require('lib/mpris');

/* How often the automatic selection is re-evaluated. Position only advances
 * while a track plays, and some players do not emit a signal when they start,
 * so a slow timer is a cheap safety net. */
const RESELECTION_INTERVAL_S = 2;

/* D-Bus calls made by the manager are local; this is only a safety valve. */
const MPRIS_CALL_TIMEOUT_MS = 2000;

const PlayerManager = GObject.registerClass({
    Signals: {
        /* The active player object changed (including becoming null). */
        'player-changed': {},
        /* The list of known players changed, in any way. */
        'players-changed': {},
    },
}, class PlayerManager extends GObject.Object {
    /**
     * _init
     * @options (object):
     *   bus: Gio.DBusConnection, defaults to the session bus.
     *   logger: object with a debug(message) method, or null.
     *   onError: function(message, error), called for recoverable errors.
     */
    _init(options = {}) {
        super._init();

        this._connection = options.bus || Gio.DBus.session;
        this._logger = options.logger || null;
        this._onError = options.onError || null;

        this._players = new Map();
        this._activePlayer = null;
        this._preferredId = '';
        this._lastSeenPlaying = new Map();
        this._started = false;

        this._cancellable = new Gio.Cancellable();
        this._reselectId = 0;
        this._nameRuleId = 0;
    }

    /**
     * setPreferredPlayer
     * @playerId (string): an MPRIS bus name suffix such as "vlc", or "" for
     *                     automatic detection.
     *
     * Wired straight to the "preferred player" desklet setting. Changing it
     * re-runs selection immediately so the UI updates without a restart.
     */
    setPreferredPlayer(playerId) {
        const normalized = Mpris.playerIdFromBusName((playerId || '').trim());

        if (normalized === this._preferredId)
            return;

        this._preferredId = normalized;

        if (this._logger)
            this._logger.debug(`preferred player: ${normalized === '' ? '(automatic)' : normalized}`);

        this._selectPlayer();
    }

    get preferredPlayer() {
        return this._preferredId;
    }

    /* The MprisPlayer the desklet should currently display, or null. */
    get activePlayer() {
        return this._activePlayer;
    }

    /* True when a preferred player is configured. */
    get hasPreferredPlayer() {
        return this._preferredId !== '';
    }

    /**
     * getPlayers
     *
     * Every player currently on the bus, sorted by name, for display in the
     * settings or a menu. Returns MprisPlayer objects.
     */
    getPlayers() {
        return [...this._players.values()].sort((a, b) => a.id.localeCompare(b.id));
    }

    /**
     * getPlayerIds
     *
     * The ids of all discovered players, which is exactly the list of valid
     * values for the "preferred player" setting.
     */
    getPlayerIds() {
        return this.getPlayers().map(player => player.id);
    }

    /**
     * start
     *
     * Begins watching the bus. Performs an initial scan immediately, then
     * keeps the player list up to date through D-Bus name notifications so
     * there is no polling.
     */
    start() {
        if (this._started)
            return;

        this._started = true;

        this._watchPlayerNames();
        this._scanForPlayers();

        this._reselectId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT, RESELECTION_INTERVAL_S, () => {
                this._selectPlayer();
                return GLib.SOURCE_CONTINUE;
            });
    }

    stop() {
        this._started = false;

        if (this._reselectId > 0) {
            GLib.source_remove(this._reselectId);
            this._reselectId = 0;
        }

        if (this._nameRuleId > 0) {
            this._connection.signal_unsubscribe(this._nameRuleId);
            this._nameRuleId = 0;
        }

        if (this._cancellable)
            this._cancellable.cancel();

        for (const player of this._players.values())
            player.destroy();
        this._players.clear();

        this._activePlayer = null;
    }

    /* Releases the bus watch, the timer, and every player. Safe to call twice,
     * which matters because the desklet calls it both on removal and on
     * reload. GObject.Object has no destroy() of its own, so there is no
     * super call here. */
    destroy() {
        this.stop();
    }

    _watchPlayerNames() {
        /* Watching the daemon's name signals is how a player that starts after
         * the desklet was added gets noticed. A NameOwnerChanged filter cannot
         * be expressed as an argument match on the session bus, so the match
         * rule stays broad and MPRIS names are filtered in the handler. */
        if (this._nameRuleId > 0)
            return;

        this._nameRuleId = this._connection.signal_subscribe(
            null,                       // sender: the bus daemon itself
            'org.freedesktop.DBus',
            'NameOwnerChanged',
            '/org/freedesktop/DBus',
            null,                       // arg0: match any bus name
            Gio.DBusSignalFlags.NONE,
            this._onNameOwnerChanged.bind(this));
    }

    _onNameOwnerChanged(_connection, _sender, _path, _iface, _signal, parameters) {
        const unpacked = Mpris.unpackVariant(parameters);
        const name = Array.isArray(unpacked) ? unpacked[0] : null;
        const newOwner = Array.isArray(unpacked) ? unpacked[2] : null;

        if (typeof name !== 'string')
            return;

        if (!Mpris.isPlayerBusName(name))
            return;

        if (newOwner === null || newOwner === '') {
            this._forgetPlayer(name);
        } else {
            this._ensurePlayer(name);
        }
    }

    _scanForPlayers() {
        this._connection.call(
            'org.freedesktop.DBus',
            '/org/freedesktop/DBus',
            'org.freedesktop.DBus',
            'ListNames',
            null,
            new GLib.VariantType('(as)'),
            Gio.DBusCallFlags.NONE,
            MPRIS_CALL_TIMEOUT_MS,
            this._cancellable,
            (connection, result) => {
                let names;

                try {
                    names = connection.call_finish(result);
                } catch (e) {
                    this._reportError('could not list D-Bus names', e);
                    return;
                }

                /* call_finish returns a GLib.Variant; deepUnpack() gives
                 * [[name, ...]] so the list is the first element. */
                const unpacked = Mpris.unpackVariant(names);
                const list = Array.isArray(unpacked) && Array.isArray(unpacked[0]) ? unpacked[0] : [];

                let found = 0;
                for (const name of list) {
                    if (typeof name === 'string' && Mpris.isPlayerBusName(name)) {
                        this._ensurePlayer(name);
                        found++;
                    }
                }

                if (this._logger)
                    this._logger.debug(`discovery: ${found} MPRIS player(s) on the bus`);
            });
    }

    _ensurePlayer(busName) {
        if (this._players.has(busName))
            return this._players.get(busName);

        if (this._logger)
            this._logger.debug(`player appeared: ${Mpris.playerIdFromBusName(busName)}`);

        const player = new Mpris.MprisPlayer(busName, {
            bus: this._connection,
            logger: this._logger,
            onError: this._onError,
        });

        this._players.set(busName, player);

        player.connect('owner-changed', () => {
            /* A player that lost its bus name is gone for good; drop it so a
             * restarted application is picked up as a fresh entry. */
            if (!player.available)
                this._forgetPlayer(busName);
        });

        player.connect('playback-status-changed', () => this._selectPlayer());
        player.connect('metadata-changed', () => this._selectPlayer());

        /* A freshly created player has no cached properties until both proxies
         * finish loading, so the initial selection sees an empty status and
         * metadata. Re-selecting on 'ready' is what makes a player that is
         * already playing show up correctly on startup. */
        player.connect('ready', () => {
            this.emit('players-changed');
            this._selectPlayer();
        });

        this.emit('players-changed');
        this._selectPlayer();

        return player;
    }

    _forgetPlayer(busName) {
        const player = this._players.get(busName);
        if (!player)
            return;

        this._players.delete(busName);
        this._lastSeenPlaying.delete(busName);

        if (this._logger)
            this._logger.debug(`player disappeared: ${player.id}`);

        player.destroy();

        this.emit('players-changed');
        this._selectPlayer();
    }

    _reportError(message, error) {
        if (this._logger)
            this._logger.debug(message);

        if (this._onError) {
            try {
                this._onError(message, error || null);
            } catch (e) {
                /* Never let a logging callback break the desklet. */
            }
        }
    }

    /**
     * _selectPlayer
     *
     * Decides which player should be shown and emits player-changed if the
     * answer differs from the current one. Called whenever a player appears,
     * disappears or reports a state change, and periodically as a safety net.
     */
    _selectPlayer() {
        const previous = this._activePlayer;
        const next = this._choosePlayer();

        if (next === previous)
            return;

        this._activePlayer = next;

        if (this._logger)
            this._logger.debug(`active player: ${next ? next.id : '(none)'}`);

        this.emit('player-changed');
    }

    _choosePlayer() {
        if (this._preferredId !== '') {
            /* An explicit preference always wins, even if the player is
             * currently stopped, so the desklet does not jump between
             * players. If it is not on the bus there is nothing sensible to
             * fall back to, so report no player rather than a different one. */
            for (const player of this._players.values()) {
                if (player.id === this._preferredId)
                    return player;
            }
            return null;
        }

        const now = Date.now();
        let best = null;
        let bestTimestamp = -1;

        for (const player of this._players.values()) {
            if (player.isPlaying()) {
                const lastSeen = this._lastSeenPlaying.get(player.busName) || 0;
                /* First sighting counts as "now" so a freshly created player
                 * object does not lose to an older one on ties. */
                if (!this._lastSeenPlaying.has(player.busName))
                    this._lastSeenPlaying.set(player.busName, now);

                const timestamp = this._lastSeenPlaying.get(player.busName);
                if (best === null || timestamp > bestTimestamp) {
                    best = player;
                    bestTimestamp = timestamp;
                }
            }
        }

        if (best !== null)
            return best;

        /* Nothing is playing. Keep showing whoever was active last so the
         * desklet stays stable instead of blanking on every pause. */
        if (this._activePlayer && this._players.has(this._activePlayer.busName))
            return this._activePlayer;

        return this.getPlayers()[0] || null;
    }
});

var playerManager = {
    PlayerManager,
    RESELECTION_INTERVAL_S,
};
