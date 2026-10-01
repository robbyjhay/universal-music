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

        /* Nothing is playing, so there is no winner and the choice comes down to
         * which idle player is worth showing.
         *
         * The one already being shown wins that, because the desklet staying put
         * while the user pauses is worth a great deal and jumping about is not:
         * every time a track ends or is paused the desklet would otherwise be
         * free to change its mind, and a widget that changes what it is showing
         * every time somebody hits pause is worse than one that is briefly
         * showing the wrong player.
         *
         * But being idle is not on its own a reason to keep showing a player, and
         * the one being shown is only kept if it can still answer the controls the
         * desklet draws. A browser's media player cannot: a web page has no queue
         * to move through, so it reports CanGoNext and CanGoPrevious as false and
         * the Previous and Next controls go dim for a player the user is not
         * listening to, while their own player sits right there on the bus
         * reporting that it can do both.
         *
         * So the choice is made from what the players say about themselves rather
         * than from their names or from habit. */
        return chooseIdlePlayer(this.getPlayers(), this._activePlayer);
    }
});

/**
 * chooseIdlePlayer
 * @players (array): every known player, already sorted by id.
 * @active (object): the player being shown now, or null.
 *
 * The player to show when nothing is playing.
 *
 * This is the whole of the "nothing is playing" policy, kept out of the class so
 * that it is a question about players rather than about the bus: it is decided
 * entirely from what the players report, and the tests can hand it players of
 * every kind without a session bus or a single D-Bus call.
 *
 * A player is worth showing when it has a track, it says it can be controlled,
 * and it says it can move through its queue. A player that reports none of that
 * would leave Previous and Next disabled however the desklet drew them, so
 * showing it can only ever be worse than showing one that can answer them: the
 * desklet is a player, and a paused player with a queue is a player the user is
 * listening to.
 *
 * @active only breaks a tie. It is preferred between players that qualify
 * equally, so the desklet holds still while the user pauses, but it is never
 * preferred to one that can answer the controls when it cannot.
 *
 * With no player to prefer, the first by id is chosen, so the desklet shows
 * something rather than blanking itself, and null when there is no player at all.
 * @active is preferred there too when it is still on the bus, because there is
 * no reason to swap players merely because none of them can do everything.
 */
function chooseIdlePlayer(players, active) {
    const usable = players.filter(player => {
        if (!player.hasTrack())
            return false;

        const capabilities = player.getCapabilities();

        return capabilities.canControl === true &&
            (capabilities.canGoNext === true || capabilities.canGoPrevious === true);
    });

    if (usable.includes(active))
        return active;

    if (usable.length > 0)
        return usable[0];

    /* Nothing on the bus can answer the controls, so the desklet has to show a
     * player that cannot. That is no reason to change which one: the same
     * argument for holding still applies, and a widget that swaps players every
     * time one is paused would be worse than one that shows a player whose
     * Previous and Next are dim. */
    if (active && players.includes(active))
        return active;

    return players.length > 0 ? players[0] : null;
}

var playerManager = {
    PlayerManager,
    RESELECTION_INTERVAL_S,
    chooseIdlePlayer,
};
