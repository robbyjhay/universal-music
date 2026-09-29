// lib/artwork-manager.js
//
// Turns the mpris:artUrl metadata value into something the desklet can draw,
// and provides a fallback when there is nothing to draw.
//
// The MPRIS specification only says that mpris:artUrl is a URL whose
// "mimetype" carries an image format, and that a player may expose artwork as
// a local file, as an http(s) URL, or as a data: URI containing a base64
// encoded image. In practice players use all three, some use a bare filesystem
// path with no scheme at all, and a fair number advertise a URL that no longer
// resolves. This module normalises all of that into a small, explicit set of
// results so that the UI never has to inspect a URL itself.
//
// The manager is deliberately free of any UI code: it decides what should be
// shown, desklet.js decides how to show it.

const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;

/* Supported URI schemes. Anything else (or nothing at all) is treated as
 * unknown and resolved to the fallback artwork. */
const SCHEME_FILE = 'file';
const SCHEME_HTTP = 'http';
const SCHEME_HTTPS = 'https';
const SCHEME_DATA = 'data';

const SUPPORTED_SCHEMES = [SCHEME_FILE, SCHEME_HTTP, SCHEME_HTTPS, SCHEME_DATA];

/* Requested size of the artwork square, in pixels. Players that serve HTTP
 * artwork usually publish a reasonably large image; asking for a smaller one
 * keeps decoding cheap on the compositor thread. */
const ARTWORK_SIZE = 256;

/* How long to wait for a remote artwork download before giving up and showing
 * the fallback. A slow or unreachable cover server must never hold up the UI. */
const ARTWORK_DOWNLOAD_TIMEOUT_S = 10;

/**
 * SourceType
 *
 * What kind of artwork was requested. Returned alongside the URI so the desklet
 * can pick a loading strategy without re-parsing the URL.
 */
const SourceType = Object.freeze({
    NONE: 'none',           // no artwork advertised at all
    FILE: 'file',           // local file, load synchronously
    NETWORK: 'network',     // http(s), download then decode
    DATA: 'data',           // data: URI, decode the base64 payload
    UNKNOWN: 'unknown',     // advertised but not a shape we can handle
});

/**
 * className
 * @type (string): one of SourceType.
 *
 * Chooses a stable style class per source type so the stylesheet can render
 * each case differently (for example a dimmed placeholder for "none").
 */
function classNameForType(type) {
    switch (type) {
        case SourceType.FILE:
        case SourceType.NETWORK:
        case SourceType.DATA:
            return 'umd-artwork-image';
        case SourceType.UNKNOWN:
            return 'umd-artwork-unsupported';
        case SourceType.NONE:
        default:
            return 'umd-artwork-placeholder';
    }
}

/**
 * parse
 * @artworkUrl (string): the mpris:artUrl metadata value, possibly null.
 *
 * Classifies an artwork URL without touching the network or the filesystem.
 * Returns an object:
 *   { type, uri, mimeType }
 * where type is a SourceType, uri is a normalised URI string (or null when
 * there is nothing usable) and mimeType is the declared image type, if any.
 *
 * The classification is intentionally forgiving, because real players send a
 * wide range of slightly malformed values.
 */
function parse(artworkUrl) {
    if (typeof artworkUrl !== 'string')
        return { type: SourceType.NONE, uri: null, mimeType: null };

    const trimmed = artworkUrl.trim();
    if (trimmed === '')
        return { type: SourceType.NONE, uri: null, mimeType: null };

    // A data: URI carries its own mime type, which is worth surfacing.
    if (trimmed.toLowerCase().startsWith(`${SCHEME_DATA}:`)) {
        return { type: SourceType.DATA, uri: trimmed, mimeType: null };
    }

    // A bare path is treated as a local file. Players that ignore the URL
    // requirement are common enough that this is worth handling. Gio does not
    // expand a leading tilde, so that case is resolved here.
    if (trimmed.startsWith('/') || trimmed.startsWith('~')) {
        const home = GLib.get_home_dir();
        if (trimmed.startsWith('~') && !home)
            return { type: SourceType.UNKNOWN, uri: trimmed, mimeType: null };

        const path = trimmed.startsWith('~')
            ? GLib.build_filenamev([home, trimmed.substring(1)])
            : trimmed;

        return { type: SourceType.FILE, uri: Gio.File.new_for_path(path).get_uri(), mimeType: null };
    }

    // Anything with a scheme we do not handle is reported as unknown rather
    // than silently ignored, so the UI can log it during development.
    const scheme = Gio.File.new_for_uri(trimmed).get_uri_scheme();
    if (scheme && !SUPPORTED_SCHEMES.includes(scheme))
        return { type: SourceType.UNKNOWN, uri: trimmed, mimeType: null };

    if (scheme === SCHEME_HTTP || scheme === SCHEME_HTTPS)
        return { type: SourceType.NETWORK, uri: trimmed, mimeType: null };

    if (scheme === SCHEME_FILE)
        return { type: SourceType.FILE, uri: trimmed, mimeType: null };

    return { type: SourceType.UNKNOWN, uri: trimmed, mimeType: null };
}

/**
 * ArtworkManager
 *
 * Owns the currently displayed artwork for the desklet. The desklet calls
 * setArtworkUrl() when the metadata changes and renders whatever
 * getCurrentSource() returns, so that a slow download never blocks the UI
 * from showing the new track title first.
 *
 * Signals:
 *   artwork-changed - the artwork source changed and the UI should redraw
 *   artwork-loaded  - an async load finished successfully
 *   artwork-failed  - an async load failed; the desklet falls back
 */
const ArtworkManager = GObject.registerClass({
    Signals: {
        'artwork-changed': {},
        'artwork-loaded': {},
        'artwork-failed': {},
    },
}, class ArtworkManager extends GObject.Object {
    /**
     * _init
     * @options (object):
     *   logger: object with a debug(message) method, or null.
     *   onError: function(message, error), called for recoverable errors.
     */
    _init(options = {}) {
        super._init();

        this._logger = options.logger || null;
        this._onError = options.onError || null;

        this._cancellable = null;
        this._requestSerial = 0;
        this._destroyed = false;
        this._timeoutId = 0;

        this._source = { type: SourceType.NONE, uri: null, mimeType: null };
        this._loadState = SourceType.NONE;
        this._contents = null;
    }

    get currentSource() {
        return this._source;
    }

    get loadState() {
        return this._loadState;
    }

    /* The raw image bytes of the current artwork, or null when nothing is
     * loaded. The desklet needs the bytes rather than the original URL because
     * http(s) and data: sources have no local path that St can open, and
     * because a data: URI would otherwise have to be decoded twice. */
    get contents() {
        return this._contents;
    }

    _debug(message) {
        if (this._logger)
            this._logger.debug(`artwork: ${message}`);
    }

    _reportError(message, error) {
        this._debug(message);

        if (this._onError) {
            try {
                this._onError(message, error || null);
            } catch (e) {
                /* Never let a logging callback break the desklet. */
            }
        }
    }

    /**
     * setArtworkUrl
     * @artworkUrl (string): the new mpris:artUrl, or null.
     *
     * Replaces the current artwork. Cancels any download still in flight so
     * that a slow cover for the previous track cannot overwrite the new one.
     */
    setArtworkUrl(artworkUrl) {
        const next = parse(artworkUrl);

        // Ignore a repeat of the same artwork, which is common because
        // players re-send the full metadata on every state change.
        if (next.uri === this._source.uri && next.type === this._source.type)
            return;

        this._cancelPendingLoad();
        this._requestSerial++;

        this._source = next;
        this._loadState = next.type;
        this._cancellable = new Gio.Cancellable();

        this._debug(`source ${next.type}${next.uri ? ` ${next.uri}` : ''}`);
        this.emit('artwork-changed');

        switch (next.type) {
            case SourceType.FILE:
                this._loadFile(next.uri);
                break;
            case SourceType.DATA:
                this._loadDataUri(next.uri);
                break;
            case SourceType.NETWORK:
                this._loadNetwork(next.uri);
                break;
            default:
                /* NONE has nothing to do. UNKNOWN is advertised artwork the
                 * desklet cannot fetch, so it resolves to the fallback straight
                 * away rather than leaving the UI waiting for a load that will
                 * never start. */
                if (next.type === SourceType.UNKNOWN)
                    this._fallback('unsupported artwork URL', null);
                break;
        }
    }

    /**
     * getFallbackIconName
     *
     * The symbolic icon drawn when there is no usable artwork. Kept as a plain
     * name so it can be themed and overridden in the stylesheet.
     */
    getFallbackIconName() {
        return 'audio-x-generic-symbolic';
    }

    /* Cancels any in-flight read. The request serial number, not the
     * cancellable alone, is what guarantees a stale result is discarded:
     * Gio's callbacks can still fire for an already-cancelled operation. */
    _cancelPendingLoad() {
        if (this._timeoutId > 0) {
            GLib.source_remove(this._timeoutId);
            this._timeoutId = 0;
        }

        if (this._cancellable) {
            this._cancellable.cancel();
            this._cancellable = null;
        }
    }

    _isCurrent(serial) {
        return !this._destroyed && serial === this._requestSerial;
    }

    /* Records loaded image data and tells the UI it can be drawn. */
    _setContents(bytes) {
        this._contents = bytes;
        this._loadState = 'loaded';
        this._emitLoaded();
    }

    _emitLoaded() {
        this._cancelPendingLoad();
        this.emit('artwork-loaded');
    }

    _loadFile(uri) {
        const file = Gio.File.new_for_uri(uri);
        const serial = this._requestSerial;

        /* Checked up front so a stale or deleted cover falls back immediately
         * instead of after a round trip through the main loop. */
        if (!file.query_exists(null)) {
            this._fallback('local artwork does not exist', null);
            return;
        }

        file.load_contents_async(this._cancellable, (source, result) => {
            if (!this._isCurrent(serial))
                return;

            try {
                const [ok, bytes] = source.load_contents_finish(result);
                if (!ok)
                    throw new Error('file could not be read');
                this._setContents(bytes);
            } catch (e) {
                this._fallback('local artwork could not be read', e);
            }
        });
    }

    /* Percent-decoding a URI string returns a byte array, so non-base64 data
     * URIs are handled here rather than in _loadDataUri(). */
    _decodePayload(payload, isBase64) {
        if (isBase64) {
            const bytes = GLib.base64_decode(payload);
            if (bytes === null || bytes.length === 0)
                throw new Error('payload is not valid base64');
            return bytes;
        }

        return GLib.uri_unescape_string(payload).toArray();
    }

    _loadDataUri(uri) {
        /* data:image/jpeg;base64,/9j/4AAQ... */
        const comma = uri.indexOf(',');
        if (comma < 0) {
            this._fallback('malformed data URI', null);
            return;
        }

        const header = uri.substring(SCHEME_DATA.length + 1, comma);
        const payload = uri.substring(comma + 1);
        const isBase64 = header.trim().toLowerCase().endsWith(';base64');

        try {
            const bytes = this._decodePayload(payload, isBase64);

            const length = bytes.length !== undefined ? bytes.length : bytes.byteLength;
            if (length === 0)
                throw new Error('data URI carries no image data');

            this._debug(`data URI decoded (${length} bytes)`);
            this._setContents(bytes);
        } catch (e) {
            this._fallback('data URI could not be decoded', e);
        }
    }

    _loadNetwork(uri) {
        const file = Gio.File.new_for_uri(uri);
        const serial = this._requestSerial;

        this._debug(`downloading ${uri}`);

        /* A cover server that never answers must not leave the desklet waiting
         * forever, so the read is abandoned after a fixed time. The serial
         * check inside the timeout discards the result even if the transfer
         * eventually succeeds. */
        this._timeoutId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT, ARTWORK_DOWNLOAD_TIMEOUT_S, () => {
                this._timeoutId = 0;
                if (!this._isCurrent(serial))
                    return GLib.SOURCE_REMOVE;

                this._fallback('artwork download timed out', null);
                return GLib.SOURCE_REMOVE;
            });

        file.load_contents_async(this._cancellable, (source, result) => {
            if (!this._isCurrent(serial))
                return;

            try {
                const [ok, bytes] = source.load_contents_finish(result);
                if (!ok)
                    throw new Error('download failed');
                this._setContents(bytes);
            } catch (e) {
                this._fallback('artwork download failed', e);
            }
        });
    }

    _fallback(message, error) {
        this._cancelPendingLoad();
        this._contents = null;
        this._loadState = SourceType.NONE;
        this._reportError(message, error);
        this.emit('artwork-failed');
        this.emit('artwork-changed');
    }

    destroy() {
        this._destroyed = true;
        this._cancelPendingLoad();
        this._source = { type: SourceType.NONE, uri: null, mimeType: null };
        this._contents = null;
    }
});

var artworkManager = {
    ArtworkManager,
    SourceType,
    classNameForType,
    parse,
    ARTWORK_SIZE,
    ARTWORK_DOWNLOAD_TIMEOUT_S,
};
