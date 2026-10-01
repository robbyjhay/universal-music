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
//   lib/layout.js             responsive layout, timeline and marquee arithmetic
//
// The visual design lives in stylesheet.css; this file only sets style classes.
//
// The widget has no hard coded layout. Every allocation it is given is
// measured and handed to lib/layout.js, which answers with the shape to draw:
// the cover above the information, beside it, or a reduced compact layout.
// The cover, the title marquee and the seek bar all follow from that one
// decision, so resizing the desklet moves all three together.

const GObject = imports.gi.GObject;
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
const Layout = require('lib/layout');

const DESKLET_TITLE = _('Universal Music');
const PLACEHOLDER_TEXT = _('No media playing');

/* Size presets offered in the settings. The pixel values are mirrored by the
 * .umd-size-* classes in stylesheet.css. */
const SIZE_CLASSES = {
    small: 'umd-size-small',
    medium: 'umd-size-medium',
    large: 'umd-size-large',
    wide: 'umd-size-wide',
};

/* The preset used when the setting holds something that is not a preset. The
 * dimensions of every preset live in lib/layout.js, next to the clamp that
 * bounds them, so there is only one place where a size can come from. */
const DEFAULT_PRESET = Layout.DEFAULT_PRESET;
const DEFAULT_SIZE = Layout.DEFAULT_SIZE;

/* The classes for the three shapes lib/layout.js can pick. Exactly one is on
 * the root at a time. */
const LAYOUT_CLASSES = {
    vertical: 'umd-layout-vertical',
    horizontal: 'umd-layout-horizontal',
    compact: 'umd-layout-compact',
};

/* Largest cover each size preset allows, in pixels. The desklet never exceeds
 * these: on a smaller desklet the cover shrinks, on a larger one the extra
 * room goes to the text instead of to a cover the size of a poster.
 *
 * Each of these is the content width of its own preset, because in the stacked
 * layout the cover is sized from the width it has. The cover then fills the
 * space above the information instead of floating in the middle of it. In the
 * side by side layout the cover is bounded by the height of the information
 * column rather than by the width, so the same number is only ever a limit
 * there.
 *
 * A custom width is not in here, and does not need to be: the cover is always
 * also bounded by the width the desklet actually has, so a wider custom size
 * simply gives the cover more room up to the limit below while the extra width
 * itself goes to the text. That limit is the same one the whole widget is
 * clamped to, so this cannot raise it.
 *
 * The cover is drawn through an St.Icon, which scales an image down into a
 * square of icon_size while preserving its aspect ratio, so these are squares
 * and the artwork is never stretched. */
const ARTWORK_SIZES = {
    small: 150,
    medium: 180,
    large: 220,
    wide: 200,
};

/* The cover on a custom size, where the preset no longer says how big it may
 * be. Kept at the ceiling the whole widget is clamped to, so the cover can
 * grow with a custom width and never past what is already the hard limit. */
const CUSTOM_ARTWORK_MAX = Layout.MAX_WIDGET_WIDTH;

/* Fallback spacing between the cover and the information column, in pixels.
 * The real value is measured from the running layout on every pass; this only
 * covers the very first one, before anything has been allocated. */
const DEFAULT_SPACING = 8;

/* How many times one layout pass will ask the layout what it needs at a
 * progressively shorter frame before settling on the answer.
 *
 * The frame is sized to the height its contents occupy, so the height it is
 * given and the height the layout answers for that frame are the same number on
 * the second pass and every one after it: the answer is a sum of measured rows
 * and the cover's own height, none of which is derived from the frame. One step
 * is therefore the normal case, and this is a backstop rather than a mechanism:
 * it exists so that a measurement that has not settled cannot keep this pass
 * going, and it cannot change the answer, because a frame sized to the last
 * height tried is a frame the layout has already had its say about.
 *
 * It is a bound and not a while loop because the loop this stands in for runs
 * downwards only: the height it is asked about is never above the one before it,
 * so it cannot go for ever. */
const FRAME_SETTLE_PASSES = 4;

/* The title alignment setting, as the actor alignment each value means.
 *
 * Left is the default and is what the artist underneath the title has always
 * used, so a track name that fits lines up with it. */
const TITLE_ALIGNMENTS = Object.freeze({
    left: Clutter.ActorAlign.START,
    center: Clutter.ActorAlign.CENTER,
    right: Clutter.ActorAlign.END,
});

const DEFAULT_TITLE_ALIGNMENT = 'left';

/* Edge length of the seek handle, in pixels. Set here rather than in the
 * stylesheet because the seek geometry is calculated from it, and a handle
 * that is not the size the arithmetic assumes would put the progress and the
 * handle out of step. */
const SEEK_HANDLE_SIZE = 10;

/* Thickness of the seek rail, in pixels. Mirrored by .umd-seek-track in
 * stylesheet.css, and needed here to centre the handle on the rail by hand. */
const SEEK_TRACK_HEIGHT = 3;

/* How often the title's scroll window is moved, in milliseconds.
 *
 * The window is stepped on a timer rather than eased on the label, because the
 * glyphs are moved: see _updateTitleStrip. 16ms is a frame at 60Hz, so the
 * title moves at the rate it would have with an ease, and the timer is removed
 * while the title rests. */
const MARQUEE_STEP_MS = 16;

/* Most labels the title strip will ever hold at once.
 *
 * The strip is a pool of one-character labels, so the pool has to be as big as
 * the widest window needs. It is sized from the title's own narrowest character
 * rather than fixed, so a title of ordinary letters needs a few dozen and an
 * unusually wide window needs no more than that; this is the ceiling for the
 * case of a window wide enough and a title narrow enough to want more. */
const TITLE_GLYPH_POOL_MAX = 160;

/* Cover art is handed to St as encoded bytes, and this St build has no
 * byte-based image loader that works, so the bytes are written to a file here
 * and pointed at by a Gio.FileIcon. See _writeArtworkCacheFile(). */
const ARTWORK_CACHE_SUBDIR = 'universal-music-desklet';

/* Shown whenever there is no usable artwork. */
const PLACEHOLDER_ICON = 'audio-x-generic-symbolic';

/* The placeholder is drawn at a fraction of the size the real cover would use.
 * A themed icon scaled up to the full cover size looks like a mistake rather
 * than like an empty slot. */
const PLACEHOLDER_ICON_SCALE = 0.55;

/* How often the elapsed time label is refreshed while playing. MPRIS exposes
 * Position as a plain property, and players are not required to emit a change
 * notification for it, so the label is re-read on a timer instead. */
const POSITION_TICK_MS = 1000;

/* A vertical box that reports a preferred width no larger than it has been told
 * to allow.
 *
 * This is the one thing St cannot do on its own, and the widget needs it for two
 * separate reasons.
 *
 * A long title: a widget is sized to its own contents, and a track title is a
 * label that reports its full length, so with nothing to stop it a long title
 * widens the desklet instead of scrolling inside it, and the scrolling never
 * comes into play because the title then always fits.
 *
 * The seek bar: the width of the progress fill is derived from the width of the
 * track, and the width set on the fill becomes the track's own preferred width,
 * which widens the information column, which widens the desklet, which makes
 * the track wider, which makes the fill wider. A loop like that does not settle
 * anywhere sensible, so the column as a whole is held to a width the desklet
 * cannot exceed.
 *
 * The theme language has a max-width, but only as a fixed length, which cannot
 * follow the width the desklet actually has. Overriding the preferred width puts
 * the limit where it is needed, on a value the layout chose. Both halves of the
 * answer are capped, the minimum and the natural width, because either one of
 * them can widen a parent.
 *
 * Only the preferred width is capped. The children keep their full sizes, so the
 * title stays as long as it is and the clipping viewport above it decides how
 * much of that is on screen. */
/* A widget that reports no width of its own, so nothing downstream can be sized
 * by what it happens to be right now.
 *
 * A plain St.Widget answers a preferred-width query with the width it currently
 * has, and one with a child answers with that child's. That is a closed loop:
 * the widget is allocated the width of the column, its preferred width then
 * becomes that width, the column's minimum becomes that width too, and a column
 * asked for less than it is handed collapses to the child instead of the child
 * being given less.
 *
 * The seek rail needs this: the fill is a fraction of the rail's width, so a
 * rail that reports a width feeds the fill's own width back in as a
 * requirement. Measured on a running desklet the column sat at 160px and then
 * dropped to 130px and back, and the played part of the bar jumped with it.
 *
 * It stays a plain widget rather than a box, because the rail's two parts are
 * placed by hand from the timeline arithmetic and a box would lay them out
 * instead. It needs no clipping of its own for the same reason: both parts are
 * placed inside its box by construction. */
const ZeroWidthWidget = GObject.registerClass({
    GTypeName: 'UMDZeroWidthWidget',
}, class ZeroWidthWidget extends St.Widget {
    vfunc_get_preferred_width(forHeight) {
        const size = super.vfunc_get_preferred_width(forHeight);

        /* Zero for the minimum and the natural, so nothing downstream can be
         * sized by what this happens to be right now. */
        return [0, size[1] !== undefined ? size[1] : 0, 0, size[3] !== undefined ? size[3] : 0];
    }
});

/* The title's window: as wide and as tall as the desklet allows, and nothing
 * painted outside it.
 *
 * A box, and that is the whole point of it. Clipping is what keeps the title
 * inside the black rectangle, and on this St build only a box does it: with a
 * plain St.Widget as the window, a title scrolled to the left was painted out
 * over the desktop, because a plain widget's `clip` does not cut its child.
 *
 * It reports no width of its own, for the same reason the seek rail does: a
 * title is a label that reports the full length of the track name, and anything
 * that lets that length become a preferred width makes the column ask for it.
 * The column is then laid out wider than the frame, and the title, the artist
 * and the transport controls are drawn out past the side of the black
 * rectangle. The window is exactly as wide as the column allows and no wider. */
const TitleViewport = GObject.registerClass({
    GTypeName: 'UMDTitleViewport',
}, class TitleViewport extends St.BoxLayout {
    _init(props) {
        super._init(props);

        this.clip = true;
    }

    vfunc_get_preferred_width(forHeight) {
        const size = super.vfunc_get_preferred_width(forHeight);

        return [0, size[1] !== undefined ? size[1] : 0, 0, size[3] !== undefined ? size[3] : 0];
    }
});

/* The title's holder: the one actor between the window and the title that has
 * no layout of its own.
 *
 * It is here because of a conflict between the two things the window has to do.
 * The window has to be a box, because only a box clips. A box hands its child
 * a position on every relayout, and a relayout happens on every frame of the
 * scroll, so the title would be put back at the left edge each frame and the
 * scroll would not move. Moving the title with a translation is not the answer:
 * a translation is painted through a transform that the clip does not follow,
 * which is how the title ended up outside the rectangle in the first place.
 *
 * So the box lays out this holder, the holder lays out nothing, and the title
 * is moved inside the holder by its own position. Nothing resets it, and the
 * box above clips the result. */
const TitleHolder = GObject.registerClass({
    GTypeName: 'UMDTitleHolder',
}, class TitleHolder extends St.Widget {});

const CappedBox = GObject.registerClass({
    GTypeName: 'UMDCappedBox',
}, class CappedBox extends St.BoxLayout {
    _init(props) {
        super._init(props);

        this._maxWidth = 0;
        this._maxHeight = 0;
        this._clampWidth = 0;
        this._clampHeight = 0;
    }

    /* Set from the layout on every pass. */
    setMaxWidth(value) {
        const width = Math.max(0, Math.round(value) || 0);

        if (width === this._maxWidth)
            return;

        this._maxWidth = width;
        this.queue_relayout();
    }

    /* The height counterpart, which the layout needs for the root: a height
     * that came only from the theme could not be told apart from a number the
     * children asked for, and the children must not be able to ask for more
     * than the user configured. */
    setMaxHeight(value) {
        const height = Math.max(0, Math.round(value) || 0);

        if (height === this._maxHeight)
            return;

        this._maxHeight = height;
        this.queue_relayout();
    }

    /* Applied as an explicit size as well as as a preferred cap.
     *
     * The cap alone is not enough for the root, because a size request that is
     * below the cap is answered by the children instead: shrink them enough and
     * the widget would quietly go back to being the size they want. Forcing the
     * size is what makes the configured width and height the size the desklet
     * actually gets, in both directions. */
    applyFixedSize(width, height) {
        this.setMaxWidth(width);
        this.setMaxHeight(height);
        this.set_size(width, height);
    }

    /* Holds the box to at most the given width and height, in both directions.
     *
     * A preferred cap on its own only says "this is as big as I would like to
     * be". It is a minimum on the size the box asks for, not a maximum on the
     * size it is given, so a box whose children want more room than the cap
     * allows is simply laid out at the size its children asked for and the cap
     * has no effect at all. That is how the information column came to be
     * taller than the space inside the frame, with the transport controls drawn
     * past the bottom of the black rectangle onto whatever was behind it.
     *
     * So the height is clamped on the box itself as well as on its preference:
     * the box is told the size it is allowed to be, and its children are laid
     * out inside that and clip at the edge rather than past it.
     *
     * A width of 0 or a height of 0 means "not constrained on this axis", so
     * that a caller can constrain one without the other. */
    clampTo(width, height) {
        const w = Math.max(0, Math.round(width) || 0);
        const h = Math.max(0, Math.round(height) || 0);

        if (w === this._clampWidth && h === this._clampHeight)
            return;

        this._clampWidth = w;
        this._clampHeight = h;

        if (w > 0)
            this.setMaxWidth(w);

        if (h > 0) {
            this.setMaxHeight(h);
            /* The explicit height is what actually holds the box inside the
             * frame; the cap above only bounds what it asks for. */
            this.set_height(h);
        }

        this.queue_relayout();
    }

    vfunc_get_preferred_width(forHeight) {
        const size = super.vfunc_get_preferred_width(forHeight);

        if (!(this._maxWidth > 0))
            return size;

        /* This vfunc answers with the minimum and the natural width and nothing
         * else. */
        return size.map(value => Math.min(value, this._maxWidth));
    }

    vfunc_get_preferred_height(forWidth) {
        const size = super.vfunc_get_preferred_height(forWidth);

        if (!(this._maxHeight > 0))
            return size;

        return size.map(value => Math.min(value, this._maxHeight));
    }
});

/* The shape of a cover that has just been written to the cache, as width
 * divided by height, read from the file rather than from the bytes so that
 * nothing has to be decoded.
 *
 * GdkPixbuf is bound on first use and a failure is not an error: a cover whose
 * shape cannot be read is simply drawn as the square the layout asked for,
 * which is what it always did. Returns 0 when the shape is not known. */
let _pixbuf = undefined;

function artworkAspect(path) {
    if (_pixbuf === undefined) {
        try {
            _pixbuf = imports.gi.GdkPixbuf.Pixbuf;
        } catch (e) {
            _pixbuf = null;
        }
    }

    if (!_pixbuf)
        return 0;

    try {
        /* [format, width, height], read from the header. */
        const info = _pixbuf.get_file_info(path);

        if (info && info[1] > 0 && info[2] > 0)
            return info[1] / info[2];
    } catch (e) {
        /* Nothing to report: an unreadable shape is drawn as a square. */
    }

    return 0;
}

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

        /* Left until the setting says otherwise, so the title matches the
         * artist from the first frame rather than after the settings are read. */
        this._titleAlignment =
            TITLE_ALIGNMENTS[DEFAULT_TITLE_ALIGNMENT] || Clutter.ActorAlign.START;

        this._layout = {
            mode: Layout.LayoutMode.VERTICAL,
            vertical: true,
            artworkSize: ARTWORK_SIZES[DEFAULT_PRESET],
            artworkBoxWidth: ARTWORK_SIZES[DEFAULT_PRESET],
            showArtwork: true,
            infoMaxWidth: 0,
            columnMaxHeight: 0,
            showArtist: true,
            showTimes: true,
        };
        this._artworkIsPlaceholder = true;
        /* The size the user configured, already clamped by lib/layout.js. Only
         * ever written by _applySize(), and only read as a limit. */
        this._widgetSize = { ...DEFAULT_SIZE, preset: DEFAULT_PRESET, custom: false };
        /* True only while a preset is writing its dimensions into the width and
         * the height settings, so those writes are not mistaken for the user
         * editing a custom size. */
        this._presetIsAuthoritative = false;
        /* Width divided by height of the cover, as read from the file. One for
         * a placeholder, which is a themed icon and is always square. */
        this._artworkAspect = 1;
        this._layoutSize = { width: -1, height: -1 };
        /* The column height the last pass fitted against, so a pass whose column
         * has changed is not skipped as a repeat of one that has not. */
        this._layoutColumnHeight = -1;
        /* The cover shape the last pass was worked out for, for the same reason:
         * a track whose artwork is a different shape is a different layout even
         * when the frame and the column have not moved an inch. */
        this._layoutAspect = -1;
        /* The height the frame is being held to, which is the configured height
         * until a layout pass finds the contents are shorter than it. */
        this._frameHeight = 0;
        this._layoutUpdateId = 0;
        this._timelineUpdateId = 0;
        this._marqueeUpdateId = 0;
        this._marqueeOverflow = 0;
        this._marqueeDirty = false;
        /* The whole title, and how far through it the window is showing. The
         * label only ever holds the part of the title that fits, so the two are
         * kept here rather than read back off the label. */
        this._titleFullText = '';
        this._marqueeOffset = 0;
        /* The scroll is a single number that only ever moves forwards, worked
         * out from how long it has been playing rather than from how long the
         * desklet has been up. That is what lets it hold still while paused and
         * carry on from the same place afterwards, the same way the seeker
         * does. */
        this._titleMarqueeElapsedMs = 0;
        this._titleMarqueeAnchorUs = 0;
        this._titleMarqueeFrameId = 0;
        /* The strip's pool and the title measured onto it. */
        this._titleGlyphs = [];
        this._titleGlyphChars = [];
        this._titleCharX = [];
        this._titleCharW = [];
        this._titleWidth = 0;
        this._titleTextHeight = 0;

        this._lengthUs = 0;
        this._canSeek = false;
        this._seeking = false;
        this._dragFraction = 0;
        /* The width the seek rail is meant to settle at, recorded by the layout
         * so the fill never has to be measured from a rail that is mid-resize. */
        this._railWidth = 0;
        /* The information column's height with nothing holding it in, kept so the
         * layout has something to fit against even on a pass that cannot measure
         * it. */
        this._columnNatural = 0;
        /* What the transport row costs that column, gap included, measured the
         * same way. Zero until it has been measured, and zero is the
         * conservative direction: an unmeasured row reclaims nothing rather than
         * the layout reclaiming a guess. */
        this._controlsHeight = 0;
        /* Whether the track is advancing. The displayed position is
         * extrapolated from the wall clock only while this is true, so a paused
         * player holds the bar exactly where it stopped instead of letting it
         * walk on by itself. */
        this._playing = false;
        /* Where the position was when playback was last stopped, so that
         * resuming starts from the paused position rather than from a stale
         * read of a property the player never promised to refresh. */
        this._pausedPositionUs = 0;
        /* Counts the position reads that have been asked for. A read is a round
         * trip over D-Bus, so replies can arrive in a different order to the
         * requests; this is what lets a reply that something newer has overtaken
         * be recognised and dropped. */
        this._positionRequestSerial = 0;
        /* The position a seek asked for, or -1 when there is no seek in flight.
         *
         * A seek is not finished when it is requested: the player is asked over
         * D-Bus and answers later, and until it does, the position it reports
         * is still the old one. Nothing it says may move the display while this
         * is set, which is what stopped a seek from appearing to jump to the old
         * position first and settle on the new one a moment later. */
        this._pendingSeekUs = -1;
        /* The track a pending seek was made in, so a track change can be told
         * apart from the player slowly getting round to answering. */
        this._pendingSeekTrackId = '';
        /* True once the player has confirmed a pending seek. */
        this._seekConfirmed = false;

        this._buildUI();
        this._initSettings();
        this._initMedia();
        this._applySettings();

        this.setContent(this._root);
        this._addMenuItems();
    }

    /* ------------------------------------------------------------------ UI */

    _buildUI() {
        /* A CappedBox rather than a plain box, so the configured width and
         * height are the largest the widget can ask to be. Everything below it
         * is sized to fit, and this is the last place that answer is enforced:
         * by the time a measurement reaches here it has already been through
         * the clamp in lib/layout.js, and nothing below can raise these two
         * numbers. */
        this._root = new CappedBox({
            style_class: 'umd-root',
            vertical: true,
            reactive: true,
            track_hover: true,
        });

        this._buildArtwork();

        /* The information column. In the stacked layout it sits under the
         * cover and is as wide as the desklet; in the side by side layout it
         * takes whatever the cover leaves. Either way it is the same column,
         * which is what keeps the three features moving together. */
        this._sideBox = new CappedBox({
            style_class: 'umd-side',
            vertical: true,
            y_align: Clutter.ActorAlign.CENTER,
        });

        /* The information column is the black rectangle's own content, and the
         * box is held to the height that is actually left inside the frame. On a
         * frame too short for the whole column, the parts that do not fit are
         * clipped at the edge of the box rather than drawn past it.
         *
         * This is not a substitute for the sizing: the layout works out how much
         * of the column fits, drops the rows that do not, and holds the box to
         * what is left, so the clip only ever has a few pixels of the last row
         * to deal with. It is here because a box lays its children out at the
         * positions their sizes call for, which for a stack that is taller than
         * the box means the bottom of the stack is outside it, and without this
         * the transport controls are drawn on top of the desktop.
         *
         * The root clips as well, for the same reason and one level up. */
        this._sideBox.clip = true;

        this._buildInfo();
        this._buildTimeline();
        this._buildControls();

        this._sideBox.add_child(this._infoBox);
        this._sideBox.add_child(this._timeline);
        this._sideBox.add_child(this._controls);

        this._root.add_child(this._artworkBox);
        this._root.add_child(this._sideBox);

        /* The desklet is sized to its own content, so the interesting
         * allocation changes come from the size preset, from a theme change
         * or from anything that constrains the actor. Both axes are watched
         * because either one can cross a break point. */
        this._root.connect('notify::width', () => this._scheduleLayoutUpdate());
        this._root.connect('notify::height', () => this._scheduleLayoutUpdate());

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
                /* The transport buttons run their own 'clicked' handler, and
                 * the seek bar seeks on its own, so clicking either of them
                 * here as well would double up. */
                !this._isInteractiveActor(event.get_source()))
                this._togglePlayPause();

            return Clutter.EVENT_PROPAGATE;
        });
    }

    /* True when the actor is one of the transport buttons, one of the seek bar
     * parts, or is inside one of them.
     *
     * The event source is the deepest reactive actor under the pointer, which
     * for a button is the St.Icon inside it rather than the button itself, so
     * the whole ancestor chain is checked. */
    _isInteractiveActor(actor) {
        while (actor) {
            if (actor === this._previousButton ||
                actor === this._playPauseButton ||
                actor === this._nextButton ||
                actor === this._seekTrack)
                return true;

            actor = actor.get_parent();
        }

        return false;
    }

    _buildArtwork() {
        /* A box rather than a bin: the cover is a square that has to be
         * centred in whatever width the layout gives it, and a box aligns its
         * children on its cross axis, which is exactly that. */
        this._artworkBox = new St.BoxLayout({
            style_class: 'umd-artwork',
            vertical: true,
            y_align: Clutter.ActorAlign.CENTER,
        });

        /* One icon for both states, always driven through set_gicon: the
         * placeholder is a themed icon and real artwork is a file-backed one.
         * St.Icon clears the previous source on every set_gicon call, and
         * passing null is not allowed. */
        this._artworkIcon = new St.Icon({
            style_class: 'umd-artwork-image',
            icon_size: ARTWORK_SIZES[DEFAULT_PRESET],
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });

        this._showArtworkPlaceholder();
        this._artworkBox.add_child(this._artworkIcon);
    }

    _buildInfo() {
        this._infoBox = new St.BoxLayout({
            style_class: 'umd-info',
            vertical: true,
        });

        /* The viewport is the clip that turns a title too long for the desklet
         * into a scroll instead of a stretched desklet. See TitleViewport for
         * why it is a box and not a plain widget.
         *
         * It is not reactive, so clicks pass straight through to the body
         * shortcut above and a click on the title is still play/pause. */
        this._titleViewport = new TitleViewport({
            style_class: 'umd-title-viewport',
            x_expand: true,
        });

        /* Deliberately not ellipsized. The label reports its full natural
         * width either way, but an ellipsized one would be drawn truncated
         * before the marquee had a chance to move it. */
        this._titleLabel = new St.Label({
            style_class: 'umd-title',
            text: PLACEHOLDER_TEXT,
            x_align: Clutter.ActorAlign.START,
            y_align: Clutter.ActorAlign.START,
        });
        this._titleLabel.clutter_text.set_single_line_mode(true);
        this._titleLabel.clutter_text.set_ellipsize(Pango.EllipsizeMode.NONE);

        /* The label is not what scrolls any more: it is here for its theme, so
         * the strip below is drawn with the font and colour the desklet was
         * given rather than a font and colour of our own. It holds no text, so
         * it paints nothing. See _titleGlyph. */
        this._titleLayout = this._titleLabel.clutter_text.get_layout().copy();
        this._titleLabel.text = '';

        /* The holder, between the window and the title, so that the box which
         * clips has something to lay out and the title itself is positioned by
         * the marquee. See TitleHolder. */
        this._titleHolder = new TitleHolder();

        /* The strip: one label per character of the title, each placed at its
         * own sub-pixel position. See _titleGlyph. */
        this._titleStrip = new St.Widget({});
        this._titleStrip.set_size(0, 0);
        this._titleStrip.set_position(0, 0);
        this._titleHolder.add_child(this._titleStrip);

        this._titleHolder.add_child(this._titleLabel);
        this._titleViewport.add_child(this._titleHolder);

        this._artistLabel = this._createLabel('umd-artist', '');

        /* Left aligned, like the title. The title cannot be centred because
         * the marquee needs a fixed left edge to scroll from, and a centred
         * artist under a left aligned title reads as a mistake. */
        this._artistLabel.x_align = Clutter.ActorAlign.START;

        this._infoBox.add_child(this._titleViewport);
        this._infoBox.add_child(this._artistLabel);

        /* Re-measuring on a resize is what stops the marquee from scrolling by
         * a stale amount. */
        this._titleViewport.connect('notify::width', () => this._scheduleMarqueeUpdate());
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

    _buildTimeline() {
        this._timeline = new St.BoxLayout({
            style_class: 'umd-timeline',
            vertical: true,
        });

        /* A plain widget, not a box: the rail is thinner than the handle that
         * sits on it, and a box would lay the handle out inside a space as tall
         * as itself, which put the fill 3px below the rail and the handle 7px
         * above it. Nothing here needs laying out, so the two parts are placed
         * by hand in _renderTimeline instead, where the numbers are known.
         *
         * The rail is reactive, and so is the handle on it. The fill is not,
         * so a click on the played part lands on the rail rather than on a
         * child that measures its own width.
         *
         * x_expand because a plain widget has no width of its own: the rail is
         * as wide as the information column, which is the timeline's cross axis. */
        this._seekTrack = new ZeroWidthWidget({
            style_class: 'umd-seek-track',
            reactive: true,
            track_hover: true,
            x_expand: true,
        });

        this._seekFill = new St.Widget({
            style_class: 'umd-seek-fill',
        });

        /* The handle is a circle taller than the rail it sits on, and that
         * circle is what a pointer grabs. It is reactive in its own right
         * because Clutter only picks reactive actors: a press on the visible
         * circle that missed the rail underneath it would otherwise fall
         * through to the desklet body and toggle playback instead of seeking.
         *
         * The press is stopped in _onSeekPress, so it is handled once and does
         * not reach the rail behind it. */
        this._seekHandle = new St.Widget({
            style_class: 'umd-seek-handle',
            reactive: true,
            track_hover: true,
        });
        this._seekHandle.set_size(SEEK_HANDLE_SIZE, SEEK_HANDLE_SIZE);

        this._seekTrack.add_child(this._seekFill);
        this._seekTrack.add_child(this._seekHandle);

        /* The same handlers on both, so the rail and the circle on it are one
         * control to the user. */
        for (const part of [this._seekTrack, this._seekHandle]) {
            part.connect('button-press-event',
                (_actor, event) => this._onSeekPress(event));
            part.connect('motion-event',
                (_actor, event) => this._onSeekMotion(event));
            part.connect('button-release-event',
                (_actor, event) => this._onSeekRelease(event));
        }

        /* Clutter gives the actor that received the press an implicit grab, so
         * the motion events that follow a press anywhere in the track keep
         * arriving here even when the pointer leaves it. No explicit grab is
         * needed, and none is taken: see _onSeekPress. */
        this._seekTrack.connect('notify::width', () => this._scheduleTimelineRender());

        this._elapsedLabel = this._createLabel('umd-time umd-time-elapsed', '');
        this._durationLabel = this._createLabel('umd-time umd-time-duration', '');

        /* The elapsed label expands along the track, which is what pushes the
         * duration to the far end of the row. */
        this._elapsedLabel.x_expand = true;
        this._elapsedLabel.x_align = Clutter.ActorAlign.START;
        this._durationLabel.x_align = Clutter.ActorAlign.END;

        this._timeRow = new St.BoxLayout({
            style_class: 'umd-times',
        });
        this._timeRow.add_child(this._elapsedLabel);
        this._timeRow.add_child(this._durationLabel);

        this._timeline.add_child(this._seekTrack);
        this._timeline.add_child(this._timeRow);
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

    /* ------------------------------------------------------------- Settings */

    _initSettings() {
        this.settings = new Settings.DeskletSettings(this, this.metadata.uuid, this.instance_id);

        this.settings.bind('widget-size', 'widgetSize', () => this._onPresetChanged());
        this.settings.bind('widget-width', 'widgetWidth', () => this._onDimensionsChanged());
        this.settings.bind('widget-height', 'widgetHeight', () => this._onDimensionsChanged());
        this.settings.bind('opacity', 'opacity', () => this._applySettings());
        this.settings.bind('title-alignment', 'titleAlignment',
            () => this._applyTitleAlignment());
        this.settings.bind('show-artwork', 'showArtwork', () => this._applySettings());
        this.settings.bind('show-controls', 'showControls', () => this._applySettings());
        this.settings.bind('preferred-player', 'preferredPlayer',
            () => this._playerManager?.setPreferredPlayer(this.preferredPlayer));
        this.settings.bind('debug-logging', 'debugLogging', () => {
            this._logger.debug('debug logging enabled');
        });
    }

    /* Puts the title where the setting says, for both of the ways a title is
     * drawn.
     *
     * It applies to the title's own position inside the window rather than to
     * the window's position inside the column, and that is deliberate. The
     * viewport reports no width of its own so that nothing can size a column
     * from the title, and a box that is told to align a child gives it that
     * child's width rather than the space available: setting the alignment on
     * the viewport itself made it zero pixels wide and the title area collapsed.
     * The window has to keep filling the column, so the alignment is applied
     * where the title is drawn in it.
     *
     * The consequence is that a title too long to fit looks the same whichever
     * way it is set. That is not the setting being ignored: the window is as
     * wide as the column allows and the text is wider than the window, so there
     * is no edge of the text inside the window to line up with, and moving the
     * text to make one would push a character outside the window and put it
     * back over the desktop. A title that fits has an edge, and that is what the
     * setting moves. */
    _applyTitleAlignment() {
        const align = TITLE_ALIGNMENTS[this.titleAlignment];

        /* An installation whose saved settings predate this one has no value
         * for the key, and anything unrecognised falls back to the default
         * rather than leaving the title wherever it last was. */
        this._titleAlignment = align !== undefined ? align : Clutter.ActorAlign.START;

        /* A title that is not scrolling is the one that shows this, and it is
         * redrawn from the width the viewport already has. The marquee is
         * deliberately not restarted: the alignment changes where a title is
         * drawn, not how far along it is, so its position is left alone. */
        if (this._marqueeOverflow <= 0 && this._titleViewport) {
            this._showStaticTitle(this._titleViewport.get_width(),
                this._titleViewport.get_height());
        }
    }

    /* Applies every appearance setting. Called once at startup and again
     * whenever a bound setting changes.
     *
     * The size is applied by the three settings that carry it, not from here:
     * they resolve the size between them and none of them can be applied
     * without knowing which one changed. At startup this is called on its own
     * so the initial size is on the widget before the first layout pass. */
    _applySettings() {
        this._onPresetChanged();
        this._applyOpacity();
        this._applyTitleAlignment();
        this._applyArtworkVisibility();
        this._applyControlsVisibility();

        /* A setting can change the layout without changing the allocation, for
         * instance a size preset that is still settling, so the measurement
         * guard below is dropped and the layout is worked out again. */
        this._layoutSize = { width: -1, height: -1 };
        this._layoutColumnHeight = -1;
        /* The column's natural height is a property of the rows and their text,
         * and a new size is the padding and spacing changing under them, so it
         * has to be measured again rather than reused. */
        this._columnNatural = 0;
        this._applyLayout();
    }

    /* The three size settings, as one resolved size.
     *
     * They are handled separately rather than through one callback because
     * which of them changed decides where the size comes from, and that cannot
     * be told apart from the value alone: after a preset has been chosen, the
     * width and the height hold exactly what that preset resolved to, so a
     * width of 180 means "medium" in one case and "the user asked for 180" in
     * the other. The setting that changed is the only thing that says which. */

    /* The preset changed: it is the authority, so the dimensions follow it. */
    _onPresetChanged() {
        /* The width and the height are passed as well as the preset because a
         * preset of 'custom' resolves to exactly those two numbers, and they
         * are the whole answer in that case. Without them a custom size would
         * fall back to the default preset, which is the opposite of what
         * choosing custom means. */
        const size = Layout.resolveWidgetSize({
            preset: this.widgetSize,
            width: this.widgetWidth,
            height: this.widgetHeight,
        });

        /* Only a named preset has dimensions to write. 'custom' keeps whatever
         * the width and the height already are, which is the whole meaning of
         * that option. */
        if (SIZE_CLASSES[this.widgetSize]) {
            /* Set while the writes below are in flight, so the dimension
             * bindings that fire in response recognise these as the preset's
             * own values and do not treat them as the user editing a custom
             * size. Without it, filling the dimensions in would immediately
             * switch the preset back to custom. */
            this._presetIsAuthoritative = true;

            this._syncDimensionSetting('widget-width', size.width);
            this._syncDimensionSetting('widget-height', size.height);

            this._presetIsAuthoritative = false;
        }

        this._applySize(size);
    }

    /* The width or the height changed: those two are the authority from here
     * on, and the preset becomes a starting point that has been moved past. */
    _onDimensionsChanged() {
        if (!this._presetIsAuthoritative && this.widgetSize !== Layout.CUSTOM_PRESET)
            this.settings.setValue('widget-size', Layout.CUSTOM_PRESET);

        this._applySize(Layout.resolveWidgetSize({
            preset: this.widgetSize,
            width: this.widgetWidth,
            height: this.widgetHeight,
        }));
    }

    /* Writes a dimension setting only when it is not already the value wanted,
     * so a write cannot trigger the write it came from. */
    _syncDimensionSetting(key, value) {
        if (this.settings.getValue(key) !== value)
            this.settings.setValue(key, value);
    }

    /* Puts a resolved size on the widget.
     *
     * Everything a user can type comes out of Layout.resolveWidgetSize(), which
     * clamps both axes, so by the time a number is used here it is a whole
     * number of pixels inside the hard limits. This method never adds a bound
     * of its own and never widens one: it passes the clamped pair straight
     * through to the root as its fixed size.
     *
     * The size class is still applied, because it carries the padding and the
     * spacing for each preset and those are what the cover and the timeline are
     * laid out from. Its min-width is overridden by the configured size below,
     * so a preset that is wider than what was asked for cannot widen the
     * widget. */
    _applySize(size) {
        this._widgetSize = size;

        for (const className of Object.values(SIZE_CLASSES))
            this._root.remove_style_class_name(className);

        /* Custom has no class of its own: it keeps the padding and the spacing
         * of the preset it came from, which is the default when there is no
         * remembered one. */
        this._root.add_style_class_name(SIZE_CLASSES[size.preset] || SIZE_CLASSES[DEFAULT_PRESET]);

        /* The configured size as an inline style, which outranks the class, so
         * the widget is the size that was asked for whichever preset is
         * selected. Written as a min-width and a min-height rather than as a
         * size because that is the form St measures: it raises the smallest the
         * widget can be, and the fixed size below caps the largest. */
        this._root.set_style(`min-width: ${size.width}px; min-height: ${size.height}px;`);

        this._root.applyFixedSize(size.width, size.height);

        this._logger.debug(`size ${size.width}x${size.height} from ${size.preset}`);

        /* A size change moves the break points, so the layout is worked out
         * again rather than waiting for the allocation to come back around.
         * The pass above is done from the configured size and so is already
         * correct; the scheduled one picks up the real allocation, which is what
         * settles the children into the frame once St has laid them out. */
        this._layoutSize = { width: -1, height: -1 };
        this._layoutColumnHeight = -1;
        this._layoutAspect = -1;
        /* Forced, so the first layout pass after a size change writes the new
         * frame height even when it is the one the frame is already at. */
        this._frameHeight = 0;
        this._applyLayout();
        this._scheduleLayoutUpdate();
    }

    _applyOpacity() {
        /* St expects a 0-255 integer; the setting is a percentage. */
        const percent = Math.min(100, Math.max(10, Number(this.opacity) || 100));
        this._root.opacity = Math.round((percent / 100) * 255);
    }

    _applyArtworkVisibility() {
        /* The setting, and the layout, both have a say: the setting decides
         * whether the cover is wanted at all and the layout decides whether
         * the frame is big enough to hold it. */
        this._artworkBox.visible = this.showArtwork && this._layout.showArtwork;
    }

    _applyControlsVisibility() {
        if (this.showControls)
            this._controls.show();
        else
            this._controls.hide();
    }

    /* ---------------------------------------------------------------- Layout */

    /* Both a resize and a settings change end up here, several times per
     * gesture, so the work is coalesced into a single idle callback. */
    _scheduleLayoutUpdate() {
        if (this._layoutUpdateId > 0)
            return;

        this._layoutUpdateId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._layoutUpdateId = 0;
            this._applyLayout();
            return GLib.SOURCE_REMOVE;
        });
    }

    _applyLayout() {
        /* Everything below reads the live style: padding from the theme nodes,
         * sizes from the preferred size of a box. None of that exists until the
         * desklet is actually in the stage, and asking for it earlier makes St
         * complain loudly. The allocation notifications wired up in _buildUI()
         * bring us back here once it is, so nothing is lost by waiting.
         *
         * The guard is dropped as well, so the next real pass is not skipped as
         * a repeat of the one that did not run. */
        if (!this._root.get_stage()) {
            this._layoutSize = { width: -1, height: -1 };
            this._layoutColumnHeight = -1;
            return;
        }

        const [allocatedWidth, allocatedHeight] = this._root.get_size();
        const themeNode = this._root.get_theme_node();

        /* The break points are about the space the cover and the text
         * actually get, which is the allocation minus the desklet's own
         * padding. The padding is read from the live style rather than mirrored
         * here, so editing stylesheet.css cannot desynchronise the layout.
         *
         * The border is left out: it is a pixel wide, and the one decision
         * that would be sensitive to getting it exactly right, how wide the
         * information column may ask to be, is taken from the width the desklet
         * will not go below rather than from this measurement.
         *
         * The box is bounded by the configured size rather than being whatever
         * the allocation happens to say, and that is the whole of how a size
         * change takes effect at once. _applySize() forces the allocation to
         * the configured size, so the two normally agree, but St applies a size
         * on the next relayout: a pass that ran in between read the size the
         * desklet used to have and laid the children out for it, which is how
         * the controls and the seek bar were left standing where the previous
         * preset had them. Taking the configured size means a change is
         * complete the moment it is applied rather than a frame later.
         *
         * A larger allocation is still respected downwards, so a theme that
         * insists on more room than was configured narrows the content box
         * rather than letting the children be laid out for room the frame does
         * not have.
         *
         * Both numbers are clamped before anything is worked out from them. The
         * desklet is sized to its own contents, so a layout that got itself
         * into a runaway hands the next pass a larger number than it really
         * had, and the sizes worked out from that would be what keeps it going.
         * Clamping here means the worst a runaway can produce is a widget that
         * looks wrong, never a widget that is thousands of pixels across. */
        const configured = this._widgetSize;
        const width = Layout.clampMeasurement(
            Math.min(allocatedWidth > 0 ? allocatedWidth : configured.width, configured.width) -
            themeNode.get_horizontal_padding());

        /* The height the frame was given, as opposed to the height this desklet
         * last gave it.
         *
         * _applyFrameHeight() sizes the frame to what its contents need, and that
         * size comes back round as the next allocation. Reading it as the frame's
         * allocation is what pins the desklet at the height its last contents
         * wanted: the column grows when a section is switched back on, the layout
         * asks for more room than the frame has been given, and the frame can
         * never grow into it because the room it was measured against was its own
         * previous answer. So an allocation that is exactly the take-in is not
         * believed, and the configured height is measured instead.
         *
         * Only exactly that height is discounted. An allocation that is neither
         * the configured height nor the take-in came from the theme or from
         * whatever constrains the actor, and those are real: a desklet handed
         * less room than it asked for is laid out for the room it has. */
        const takenIn = this._frameHeight > 0 &&
            this._frameHeight < configured.height &&
            allocatedHeight === this._frameHeight;
        const frameHeight = takenIn
            ? configured.height
            : (allocatedHeight > 0 ? allocatedHeight : configured.height);
        const available = Layout.clampMeasurement(
            Math.min(frameHeight, configured.height) -
            themeNode.get_vertical_padding());

        /* The information column is a vertical stack, and lib/layout.js needs to
         * know how tall each of its parts is so it can drop the optional ones
         * when the stack will not fit inside the frame. The two optional parts
         * are measured on their own, before the layout has decided whether to
         * show them, so the numbers are the natural heights either way. */
        const columnHeight = this._columnNaturalHeight();

        /* The shape of the cover is part of the input, not something worked out
         * after the fact: a cover that is 16:9 needs 90 of the height a square one
         * needs 160 of, and a layout that reserved for the square would hold 70px
         * back from the column on the cover's behalf and carry it as an empty
         * band underneath the controls.
         *
         * A placeholder is not square but is not artwork either, and it is drawn
         * as the square the cover slot is, so it is described as one. */
        const artworkAspect = this._artworkIsPlaceholder ? 1 : this._artworkAspect;

        /* One set of options, so the two passes below are worked out from exactly
         * the same numbers and cannot disagree about anything but the height. */
        const options = {
            width,
            /* The width the widget will not go below, taken as the larger of
             * the theme's minimum and the configured width, so the information
             * column is capped by the configured size even if the theme asks
             * for less. Both are numbers no measurement can inflate. */
            minWidth: Math.max(themeNode.get_min_width(), this._widgetSize.width),
            infoHeight: columnHeight,
            artistHeight: this._forcedNaturalHeight(this._artistLabel),
            timesHeight: this._forcedNaturalHeight(this._timeRow),
            /* The height the transport row takes in the column, measured as the
             * difference it makes to the column rather than as its own height, so
             * the gap above it is reclaimed with it. And whether it is wanted.
             * Both are inputs for the same reason the cover's shape is: a column
             * the layout is told about has to be the column it will draw, or the
             * height the frame is held to comes from a stack that is not the one
             * on screen.
             *
             * The row is measured in and taken out again by the layout rather
             * than being left out of the measurement, because the layout is what
             * decides whether it is wanted. See _columnNaturalHeight(). */
            controlsHeight: this._controlsHeight,
            controlsShown: this.showControls,
            artworkMax: this._currentArtworkMax(),
            artworkPadding: Math.max(0, this._artworkBox.get_theme_node().get_horizontal_padding()) / 2,
            spacing: this._measureSpacing(),
            artworkAspect,
            /* The setting is part of the input for the same reason the shape is:
             * a desklet with the cover switched off holds the column and nothing
             * else, and a layout that still reserved a square for a cover that
             * was never going to be drawn would cap the column against it and
             * drop rows to fit. */
            artworkShown: this.showArtwork,
        };

        /* How much of the frame the contents occupy, which is usually less than
         * all of it.
         *
         * The frame is held to the height the size preset asked for, and the
         * contents are laid out from what they need, so the room left over by a
         * layout that does not fill it is not shared out between the children:
         * it stays where it was put, which in the stacked layout is a band of
         * desklet background underneath the transport controls. For a 16:9 cover
         * that band is 99px tall, so the controls sat a long way above the bottom
         * of the desklet with nothing under them but background.
         *
         * The frame is therefore taken in to what the contents need, which leaves
         * the controls ending shortly below themselves. Two things bound it, and
         * both are needed:
         *
         * The configured height still wins, so the desklet can only ever be
         * shorter than the preset asked for and never taller than it, and a frame
         * that is already too small is left alone rather than being tightened to
         * fit whatever the layout had to drop.
         *
         * And the side by side layout is left alone as well, because there the
         * cover and the column share the height instead of being stacked, so the
         * contents do fill the frame and there is nothing to take in.
         *
         * The number comes out of the layout rather than out of a child, so it
         * cannot feed back into itself: the layout is a sum of the cover's own
         * height, the gap and the column's measured rows, and a frame sized to
         * that sum works the same sum out again. Nothing below reads a preferred
         * size back out of a child and shortens the frame by it, which is the
         * shape of thing that makes a desklet shrink a little on every pass
         * until it is as small as the layout will let it be.
         *
         * The frame is measured at the height it is going to have rather than at
         * the height it was given, and the two are not the same number once
         * anything has been taken in: the layout at a shorter frame is a different
         * answer, and sizing the frame from the answer for a taller one is what
         * leaves the empty band behind in the first place. So it is worked out
         * again at each height it is taken in to, until the height and the answer
         * agree, which for every layout here is one step: requiredHeight is a sum
         * of measured rows, so a frame sized to it sums to the same number again.
         *
         * A section the settings have switched off is part of that sum rather than
         * an exception to it, which is the whole of why the desklet resizes when
         * the album artwork or the playback controls are turned off and back on
         * again: there is no separate rule for those two, the column simply stops
         * containing the row, and the height the contents need is less because
         * there is less of them in it. */
        let height = available;
        let layout = Layout.resolveLayout({ ...options, height });

        for (let pass = 0; pass < FRAME_SETTLE_PASSES; pass++) {
            /* A frame that is already too small is not tightened any further. The
             * layout has had to drop a row or leave the cover out, so the height
             * it is reporting is only the height of what it managed to keep, and
             * shrinking to that would shrink a frame that was short already.
             *
             * A section that was switched off is not one of those drops: the
             * layout was asked for a desklet without it and is not reporting a
             * shortfall, so a cover that is off is compared against the setting
             * rather than treated as a cover that did not fit. */
            const intact = layout.showArtist && layout.showTimes &&
                layout.showArtwork === (this.showArtwork === true);

            if (!intact)
                break;

            const wanted = Math.min(available, layout.requiredHeight);

            if (wanted >= height)
                break;

            height = wanted;
            layout = Layout.resolveLayout({ ...options, height });
        }

        height = Layout.clampMeasurement(height);

        /* The pass is skipped only when nothing it depends on has changed.
         *
         * The height of the column is one of those things, and leaving it out
         * produces a stable wrong layout rather than a visible glitch: the
         * column is measured, the rows are dropped, the column is clamped to
         * what is left, and the next pass measures the clamped height, concludes
         * everything fits and drops nothing. The controls then stay laid out
         * below the bottom of the frame for as long as the size is not changed,
         * which is exactly the failure this is here to prevent. */
        if (width === this._layoutSize.width && height === this._layoutSize.height &&
            columnHeight === this._layoutColumnHeight && artworkAspect === this._layoutAspect)
            return;

        this._layoutSize = { width, height };
        this._layoutColumnHeight = columnHeight;
        this._layoutAspect = artworkAspect;

        this._logger.debug(
            `layout ${layout.mode} ${width}x${height} ` +
            `cover ${layout.artworkSize}px column<=${layout.infoMaxWidth}px ` +
            `needs ${layout.requiredHeight}px ` +
            `title ${this._naturalWidth(this._titleLabel)}px in ${this._titleViewport.get_width()}px`);

        this._layout = layout;
        this._applyLayoutShape(layout);
        this._applyFrameHeight(height, themeNode.get_vertical_padding());
        /* Deferred, because this pass has just changed the sizes the rail is
         * measured against and the rail has not been given its new width yet. */
        this._scheduleTimelineRender();
        this._scheduleMarqueeUpdate();
    }

    /* The frame itself, whose height is what the contents need rather than the
     * height the size preset asked for.
     *
     * _applySize() put the configured height on the box, as an inline
     * min-height so St would measure it and as a fixed size so St could not lay
     * the children out at whatever they preferred instead. Both of those are kept
     * for the width, which does not move. For the height the floor is lowered to
     * what the contents occupy, which is what the empty band underneath the
     * controls was: a frame held at its configured height around contents that
     * stopped 99px short of the bottom of it.
     *
     * The ceiling is untouched. The configured height is still the largest this
     * can be, so a layout that somehow wanted more room than the preset allowed
     * cannot get it, and the width is not involved at all: the frame only ever
     * gets shorter. */
    _applyFrameHeight(contentHeight, padding) {
        const width = this._widgetSize.width;
        /* @padding is what the theme takes off the frame all told, top and bottom
         * together, which is how _applyLayout() reads it too. It is added once for
         * that reason: added twice it is the difference between a frame that ends
         * where the contents end and one with the whole of the frame's own padding
         * left over underneath them, which is the band this method exists to take
         * in. */
        const frame = Math.min(this._widgetSize.height,
            Layout.clampMeasurement(contentHeight) + Math.max(0, padding));

        if (frame === this._frameHeight)
            return;

        this._frameHeight = frame;
        this._root.set_style(`min-width: ${width}px; min-height: ${frame}px;`);
        this._root.setMaxWidth(width);
        this._root.setMaxHeight(this._widgetSize.height);
        this._root.set_size(width, frame);
    }

    /* The largest cover the current size allows.
     *
     * A named preset has its own limit. A custom size has none of its own, so
     * the cover is only bounded by the widget's own hard width limit, which it
     * can therefore never reach: lib/layout.js also bounds the cover by the
     * width the widget actually has, so on a narrow custom size the cover
     * shrinks to fit and on a wide one it stops well short of this.
     *
     * The value is a maximum, not a target, so it can only ever make the cover
     * smaller than it would otherwise be. It is not a source of the widget's
     * size and cannot grow it. */
    _currentArtworkMax() {
        const size = this._widgetSize;

        return size.custom ? CUSTOM_ARTWORK_MAX : ARTWORK_SIZES[size.preset];
    }

    /* The gap between the two root children, measured from the running layout.
     * A St.BoxLayout uses one spacing value for both axes, so whichever axis
     * is currently stacked is the one to read. */
    _measureSpacing() {
        const vertical = this._layout.vertical;
        const position = vertical
            ? this._sideBox.get_y() - (this._artworkBox.get_y() + this._artworkBox.get_height())
            : this._sideBox.get_x() - (this._artworkBox.get_x() + this._artworkBox.get_width());

        return position > 0 ? Math.round(position) : DEFAULT_SPACING;
    }

    _applyLayoutShape(layout) {
        /* The root is the black rectangle every child has to stay inside, so it
         * clips. This is not a substitute for sizing the children correctly: the
         * caps below are what make them fit, and this is only the last line of
         * defence against a child that has not been laid out yet, which is
         * exactly what happens for the frame or two after a resize. */
        this._root.clip = true;

        /* Orientation first: the box relayouts itself and the measurement
         * above stays valid because both boxes are the same objects. */
        if (this._root.vertical !== layout.vertical)
            this._root.vertical = layout.vertical;

        for (const className of Object.values(LAYOUT_CLASSES))
            this._root.remove_style_class_name(className);
        this._root.add_style_class_name(LAYOUT_CLASSES[layout.mode]);

        /* Stacked: the cover is centred in the width available to it and the
         * information takes all of it. Side by side: the cover sits at the
         * start and the information absorbs the remaining width.
         *
         * The cover is never stretched to fill: _applyArtworkSize sizes its box
         * to the artwork itself, so anything wider than that is desklet
         * background and would read as a border around the cover. */
        this._artworkBox.x_align = layout.vertical
            ? Clutter.ActorAlign.CENTER
            : Clutter.ActorAlign.START;
        this._artworkBox.x_expand = false;
        this._sideBox.x_align = Clutter.ActorAlign.FILL;
        this._sideBox.x_expand = !layout.vertical;

        /* The cover is only drawn when the frame has room for it. A desklet
         * too short to hold a cover and the information column shows the
         * information, because that is what the desklet is for; the setting is
         * still respected, it just cannot win against the frame being too
         * small. */
        this._artworkBox.visible = this.showArtwork && layout.showArtwork;

        this._applyArtworkSize();

        /* Capping the information column is what keeps the desklet the size it
         * was always going to be, however wide the text in it is. The cap is a
         * maximum and not a target, so a short title and a track at 0:00 still
         * lay out exactly as wide as they need to be, and the title itself is
         * untouched: it is the viewport that clips and scrolls it. */
        this._sideBox.setMaxWidth(layout.infoMaxWidth);

        /* The width the seek rail is meant to end up at, recorded while the
         * layout still knows the answer.
         *
         * The rail spans the information column, less the horizontal padding of
         * the box it sits in. It is recorded here rather than measured from the
         * rail itself because the rail is allocated in stages during a resize
         * and can be read at a width it is about to grow out of, and the fill
         * is a fraction of that width. */
        this._railWidth = Math.max(0, layout.infoMaxWidth -
            Math.max(0, this._timeline.get_theme_node().get_horizontal_padding()));

        /* And the column is held to the height that is left inside the frame.
         *
         * Capping what it asks for is not enough, because a box whose children
         * want more is laid out at the size its children asked for: the cap is a
         * minimum on the request, not a maximum on the result. The column is
         * therefore clamped to the height outright, so its children are laid out
         * inside the frame and the transport controls cannot be drawn below it.
         * On a frame too short even for the essential column this is the only
         * thing standing between the controls and the desktop behind them.
         *
         * A height of 0 means unconstrained, so the column is not held at
         * nothing when there is no room to hold it in. */
        this._sideBox.clampTo(0, Math.max(0, layout.columnMaxHeight));

        /* The title viewport takes its width from the column, so there is no
         * width to set here: it expands to whatever the column has become and
         * clips whatever does not fit. Sizing it from the layout's cap instead
         * is what used to leave it at the previous width after a resize. */
        this._artistLabel.visible = layout.showArtist;
        this._timeRow.visible = layout.showTimes;
    }

    /* The placeholder icon does not have to fill the cover slot, so it is
     * scaled down. The cover slot itself keeps its size either way, which is
     * what stops the desklet from resizing when a track arrives without
     * artwork. */
    _artworkIconSize(layout) {
        if (!this._artworkIsPlaceholder)
            return layout.artworkSize;

        return Math.max(Layout.MIN_ARTWORK_SIZE, Math.round(layout.artworkSize * PLACEHOLDER_ICON_SCALE));
    }

    /* Sizes the cover: the icon inside the cover box, and the box around it.
     *
     * The box is the size of the artwork that goes into it rather than the size
     * of the space available for it, so the two are the same and the cover
     * reaches the inner edges of the box. Sized any larger, the extra is drawn
     * as desklet background and reads as a black border around the cover.
     *
     * The icon is given the artwork's own shape as well, which is what makes the
     * two agree. St.Icon is told how big to draw by icon_size, which is a square,
     * and it fills whatever allocation it ends up with: an icon that is only told
     * icon_size is a square whatever the artwork is, so in a box that was made
     * shorter or narrower for a cover that is not square it does not fit, and
     * being neither it nor its box able to clip, it paints over whatever is
     * underneath. Sizing the icon to the inside of the box keeps the artwork
     * undistorted and inside the space the layout reserved for it.
     *
     * Called on every layout pass and whenever the cover changes, because both
     * of the sizes it works from come from one of the two. */
    _applyArtworkSize() {
        const layout = this._layout;
        const size = this._artworkIconSize(layout);

        this._artworkIcon.icon_size = size;

        /* Whatever the stylesheet puts around the cover, if anything. */
        const padding = Math.max(0, layout.artworkBoxWidth - layout.artworkSize) / 2;
        const aspect = this._artworkIsPlaceholder ? 0 : this._artworkAspect;

        /* The shape of the box, and the layout's own answer for it rather than a
         * second copy of the same arithmetic.
         *
         * The layout reserved the height this gives, and the empty band under the
         * controls was what happened when the two were worked out separately: the
         * reservation was for a square, the box was 16:9, and the difference
         * between them was drawn as background with nothing in it. Asking the
         * layout means the box is the size the room was reserved for by
         * construction, and a change to one cannot leave the other behind.
         *
         * The width is still worked out here, because a cover that is taller than
         * it is wide is the one shape whose box is narrower than the slot, and
         * lib/layout.js reserves that width as the height of a square that never
         * gets drawn there either. */
        const width = aspect > 0 && aspect < 1
            ? Math.round(size * aspect) + padding * 2
            : layout.artworkBoxWidth;
        const height = Layout.coverBoxHeight(size, layout.artworkBoxWidth, aspect, padding);

        this._artworkBox.set_width(width);
        this._artworkBox.set_height(height);

        /* The icon takes the artwork's shape: the box less the padding around it,
         * which is the same shape the box was just given and therefore never
         * larger than the space the layout reserved. St.Icon answers a preferred
         * size query from that explicit size rather than from icon_size, so the
         * box cannot be laid out a size the artwork does not have.
         *
         * The placeholder is the one case that is left alone: it is a themed icon
         * that is deliberately smaller than the slot and centred inside it, so it
         * keeps the square icon_size and takes no size of its own. Clearing the
         * pair rather than leaving them is what stops the shape of the last real
         * cover from outliving it. */
        if (this._artworkIsPlaceholder) {
            this._artworkIcon.set_width(-1);
            this._artworkIcon.set_height(-1);
        } else {
            this._artworkIcon.set_width(Math.max(0, width - padding * 2));
            this._artworkIcon.set_height(Math.max(0, height - padding * 2));
        }
    }

    /* ---------------------------------------------------------------- Marquee */

    _scheduleMarqueeUpdate() {
        if (this._marqueeUpdateId > 0)
            return;

        this._marqueeUpdateId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._marqueeUpdateId = 0;
            this._updateMarquee();
            return GLib.SOURCE_REMOVE;
        });
    }

    /* A title that fits must not move at all, and one that no longer fits
     * starts from the beginning: both are handled by cancelling whatever was
     * running and measuring again.
     *
     * The viewport's height is set here as well, because it is a plain widget
     * and so reports none of its own: without this the title row would collapse
     * to nothing and the clip would have no height to clip against. The width
     * is not set here at all, it comes from the column, which is what keeps the
     * title from ever deciding how wide the desklet is. */
    _updateMarquee() {
        /* The window is exactly one line of text tall, and every part of the
         * title is held to that same box.
         *
         * The height is not the title's to decide. The window reports the
         * height of one line and no width, so the information region is given
         * room for the title and the column's height stays a number the layout
         * decided. Everything that draws the title is then held to that same
         * box, so the region the title is painted in and the region it is
         * allowed to paint in are the same shape. */
        const text = this._titleTextSize();
        const viewportHeight = Math.max(0, Math.round(text.height));

        if (viewportHeight > 0 && this._titleViewport.get_height() !== viewportHeight)
            this._titleViewport.set_height(viewportHeight);

        const viewportWidth = this._titleViewport.get_width();

        if (this._titleHolder.get_width() !== viewportWidth)
            this._titleHolder.set_width(viewportWidth);

        if (this._titleHolder.get_height() !== viewportHeight)
            this._titleHolder.set_height(viewportHeight);

        const overflow = Layout.titleOverflow(text.width, viewportWidth);

        /* Whether the title is drawn as one label or as a scrolling strip is
         * decided here, and it is decided on the rendered width of the whole
         * title against the width of the window it has to fit in.
         *
         * On the rendered width rather than on how many characters there are:
         * a title of a few wide letters can be wider than a title of many
         * narrow ones, so a count would send one of them scrolling for no
         * reason and hold the other still when it has to move. */
        const fits = viewportWidth > 0 && overflow <= 0;

        this._titleStrip.set_size(viewportWidth, viewportHeight);

        /* Redraw before deciding whether the scroll has to start, so a resize
         * re-places a title that is not scrolling at all and so has nothing
         * else to move it. */
        if (fits) {
            this._sizeTitleGlyphPool(viewportWidth, viewportHeight);
            this._showStaticTitle(viewportWidth, viewportHeight);
        } else {
            this._sizeTitleGlyphPool(viewportWidth, viewportHeight);
            this._showScrollingTitle();
            this._updateTitleStrip(this._titleMarqueePosition());
        }

        /* A new title restarts the scroll from the beginning even if it
         * happens to be exactly as long as the one it replaced. */
        if (!this._marqueeDirty && overflow === this._marqueeOverflow)
            return;

        this._marqueeDirty = false;
        this._marqueeOverflow = overflow;

        this._logger.debug(overflow > 0 ? `title scrolls by ${overflow}px` : 'title fits');

        this._startTitleMarquee();
    }

    /* Makes the pool of labels big enough for the window, and no bigger.
     *
     * One label is needed per character on screen, and only characters that fit
     * inside the window are ever shown, so the number of them is bounded by how
     * many of the narrowest character will fit across it. The two copies of the
     * title share the pool: they are drawn into the same window, so between
     * them they can never need more characters than the window has room for. */
    _sizeTitleGlyphPool(width, height) {
        if (width <= 0)
            return;

        let narrowest = Infinity;

        for (let i = 0; i < this._titleCharW.length; i++)
            narrowest = Math.min(narrowest, this._titleCharW[i]);

        if (!Number.isFinite(narrowest) || narrowest <= 0)
            narrowest = 1;

        const needed = Math.min(TITLE_GLYPH_POOL_MAX,
            Math.ceil(width / narrowest) + 2);

        while (this._titleGlyphs.length > needed) {
            const label = this._titleGlyphs.pop();

            if (label)
                label.destroy();

            this._titleGlyphChars.pop();
        }

        while (this._titleGlyphs.length < needed) {
            const label = new St.Label({
                style_class: 'umd-title',
                text: '',
                x_align: Clutter.ActorAlign.START,
                y_align: Clutter.ActorAlign.START,
            });

            /* One character, so it can be placed on its own, and never
             * shortened: a character that does not fit the window is not drawn
             * at all rather than drawn short. */
            label.clutter_text.set_single_line_mode(true);
            label.clutter_text.set_ellipsize(Pango.EllipsizeMode.NONE);
            label.set_size(0, height);
            label.set_position(0, 0);
            label.hide();

            this._titleGlyphs.push(label);
            this._titleGlyphChars.push(-1);
            this._titleStrip.add_child(label);
        }

        for (const label of this._titleGlyphs) {
            if (label.get_height() !== height)
                label.set_height(height);
        }
    }

    /* The size of the title's own text, in pixels, at its full length.
     *
     * Read from the text's layout rather than from the label, because the
     * label's preferred size is a measurement that is queued: it reports the
     * previous title's size for a moment after a new one arrives, and a desklet
     * that has just started reports the placeholder's. The text's layout is the
     * text's size, and asking it cannot come back stale.
     *
     * Falls back to the label's own measurement if the text has no layout, so
     * this is never the reason a title is not measured at all. */
    _titleTextSize() {
        /* The title's own layout, measured on its own copy so the answer cannot
         * be a measurement of whatever was last drawn.
         *
         * A label's preferred size is what it last measured, and measuring it
         * is queued rather than done: a title that arrived a moment ago still
         * reports the size of the title before it, which for a desklet that has
         * just started is the placeholder. A title that measures short does not
         * scroll, and the one case the marquee exists for is the one it misses.
         *
         * Unconstrained, because a layout given a width wraps to fit it, and
         * asking a wrapped layout how big it is answers with several lines: the
         * title region came out sixty pixels tall for a fifteen pixel line of
         * text, and everything below it was pushed down the desklet with it. */
        this._measureTitleText(this._titleFullText || this._titleLabel.text || '');

        if (this._titleWidth > 0 && this._titleTextHeight > 0)
            return { width: this._titleWidth, height: this._titleTextHeight };

        return {
            width: this._naturalWidth(this._titleLabel),
            height: this._naturalHeight(this._titleLabel),
        };
    }

    /* The label's own width at full length, which is what the viewport has to
     * be measured against. St reports a four element answer as minimum and
     * natural size per axis; older releases return only the minimum. */
    _naturalWidth(actor) {
        const preferred = actor.get_preferred_size();
        const natural = preferred.length >= 4 ? preferred[2] : preferred[0];

        return Number.isFinite(natural) ? Math.max(0, natural) : 0;
    }

    /* The height the information column is when nothing is holding it in.
     *
     * This has to be the height that has to be *fitted*, and the column cannot
     * be asked for it, because the column is held to the room inside the frame
     * and therefore reports exactly that room however tall its children are. So
     * a pass that measured the column measured the height it had already
     * allowed, the layout concluded everything fitted, and the transport
     * controls were laid out at the bottom of a stack taller than the frame and
     * drawn past the bottom of the black rectangle. That state is stable too,
     * which is what made it survive: the next pass measured the same wrong
     * number and reached the same wrong conclusion.
     *
     * So it is worked out from the leaves instead. Each of them is measured on
     * its own, and none of them is inside the column's clamp, so none of them
     * can be squeezed by it. The two optional rows are measured through
     * _forcedNaturalHeight(), because the layout is being asked precisely to
     * decide whether to hide them and must not be given an answer that already
     * assumes it did. The spacing of every box in the stack is added, because
     * the gaps are part of the height.
     *
     * A label's height does not depend on how wide it is, so these are stable
     * numbers: a title is one line and stays one line whatever the width. */
    /* The height the information column is when nothing is holding it in.
     *
     * This has to be the height that has to be *fitted*, and the column cannot
     * be asked for it while it is clamped, because it then reports exactly the
     * room inside the frame however tall its children are. Measuring the live
     * column therefore measures the height that has already been allowed, the
     * layout concludes everything fits and drops nothing, and the transport
     * controls are laid out at the bottom of a stack taller than the frame and
     * drawn past the bottom of the black rectangle. That state is stable, so it
     * also survives to the next pass: the same wrong number, the same wrong
     * conclusion.
     *
     * A box's preferred height is also only recomputed when it is laid out, so
     * a sum taken from the row boxes is a sum of whatever was measured last,
     * which is the clamped size again, and a sum taken from the leaves is short
     * by whatever padding and spacing the stylesheet put around them.
     *
     * So the clamp is lifted, a relayout is forced, and the column is asked once
     * with nothing holding it in. The answer is kept, because it is a property
     * of the widgets and their text, neither of which changes from pass to pass,
     * and because reading it requires a relayout that must not be paid for on
     * every pass. It is invalidated when the text or the size changes, which are
     * the only things that can change it.
     */
    _columnNaturalHeight() {
        /* What the transport row costs this column, taken out of the height
         * rather than left out of the measurement.
         *
         * The column is measured with the row forced into it, and the row is then
         * measured again with the column, the difference being what the row costs.
         * Both halves matter and neither can be got from the other:
         *
         * Measuring the column with the row already hidden would hand the layout
         * a column that has already had the row taken out of it, and the layout
         * then takes it out a second time, because it is the thing deciding
         * whether the row is wanted and cannot be given an answer that assumes
         * the decision has been made. That is what a frame 30px shorter than the
         * space it holds came from: the row was 30px of column, the measurement
         * reported a column without it, and 30px more came off on top.
         *
         * And taking the row's own height instead would leave the gap above it
         * behind, so the frame would keep the one thing that setting the row off
         * is supposed to give back. The difference between the two measurements
         * is the row and its gap, and nothing else, because the only thing that
         * changed between them is whether the row is in the column.
         *
         * The second measurement is only taken while the row is switched off,
         * which is the only time the layout has anything to take off it, so the
         * cost is only ever paid when there is space to give back. */
        this._controlsHeight = 0;

        if (this._root && this._root.get_stage()) {
            const full = this._sideNaturalHeight(true);

            if (Number.isFinite(full) && full > 0)
                this._columnNatural = full;

            if (!this._controls.visible) {
                const without = this._sideNaturalHeight(false);

                this._controlsHeight = Number.isFinite(without) && without > 0
                    ? Math.max(0, full - without)
                    : 0;
            }
        }

        /* Never below what the rows physically need.
         *
         * A measurement taken while the box is still recovering from a previous
         * clamp comes back short, and a short measurement is worse than no
         * measurement: the layout is told the column fits, keeps every row, and
         * the column is then laid out taller than the frame and clipped. The
         * controls are the floor, because they are the one row the layout never
         * drops: a column that cannot hold them cannot hold the desklet's only
         * essential control, and the frame has to be measured against that
         * before anything else is decided.
         *
         * Their own height does not depend on the column, so this is not
         * affected by the clamp the column is under. It is measured as if they
         * were showing for the same reason the column above is: a floor built out
         * of a row that is switched off is a floor holding back the very space
         * the setting was asked to give back. */
        const floor = this._naturalHeight(this._titleViewport) +
            this._naturalHeight(this._seekTrack) +
            this._forcedNaturalHeight(this._controls);

        return Math.max(this._columnNatural || 0, floor);
    }

    /* The height the information column asks for with its transport row either
     * forced into it or taken out of it, measured with nothing holding the column
     * in.
     *
     * Unclamped and explicitly un-sized, so the box has to answer for what its
     * children want rather than for the size it was last given. The row is put
     * back exactly as it was afterwards, at zero opacity for the moment it is
     * borrowed, so nothing observes the desklet in a state it will not keep. */
    _sideNaturalHeight(controlsVisible) {
        const side = this._sideBox;
        const controls = this._controls;
        const wasVisible = controls.visible;
        const opacity = controls.opacity;
        const clampH = side._clampHeight;
        const capH = side._maxHeight;
        const height = side.height;

        if (controlsVisible !== wasVisible) {
            if (controlsVisible)
                controls.show();
            else
                controls.hide();
        }

        if (controlsVisible)
            controls.opacity = 0;

        side._clampHeight = 0;
        side._maxHeight = 0;
        side.set_height(-1);
        side.queue_relayout();
        side.ensure_style();

        const natural = side.get_preferred_size(-1)[3];

        /* Straight back, so nothing observes the desklet in this state. */
        side._clampHeight = clampH;
        side._maxHeight = capH;
        side.set_height(height);
        side.queue_relayout();

        controls.opacity = opacity;

        if (controlsVisible !== wasVisible) {
            if (controlsVisible)
                controls.hide();
            else
                controls.show();
        }

        return natural;
    }

    /* The natural height of a child, the height counterpart of _naturalWidth.
     * Used for the optional rows of the information column, so the layout knows
     * what dropping one would buy it. */
    _naturalHeight(actor) {
        const preferred = actor.get_preferred_size();
        const natural = preferred.length >= 4 ? preferred[3] : preferred[1];

        return Number.isFinite(natural) ? Math.max(0, natural) : 0;
    }

    /* The height an actor would report if it were showing.
     *
     * A hidden actor reports a preferred height of zero on the axis it is not
     * laid out on, so measuring the information column while the artist and the
     * time labels are hidden returns the height of what is left rather than the
     * height that has to be fitted into the frame. The layout is being asked
     * precisely to decide which rows to hide, so it cannot be handed an answer
     * that already assumes they are hidden: it drops nothing, and the column
     * stays taller than the frame.
     *
     * The actor is made visible for the measurement and hidden again straight
     * after, so the caller sees no change. A visible actor is measured without
     * being touched at all. */
    _forcedNaturalHeight(actor) {
        if (actor.visible)
            return this._naturalHeight(actor);

        const saved = actor.opacity;

        actor.show();
        actor.opacity = 0;

        const height = this._naturalHeight(actor);

        actor.opacity = saved;
        actor.hide();

        return height;
    }

    /* ------------------------------------------------------------------ Title */

    /* Where one character of the title sits, in pixels, measured on the title's
     * own layout.
     *
     * The layout is a copy, taken once from the label, so that setting the
     * text on it here cannot be undone by St deciding the label's text is
     * something else. The rectangles Pango answers with are in Pango units,
     * which are 1024 to the pixel. */
    _titleCharBox(index) {
        if (index < 0 || index >= this._titleCharX.length)
            return null;

        return { x: this._titleCharX[index], width: this._titleCharW[index] };
    }

    /* Measures the whole title, unconstrained, and lays it out one character at
     * a time.
     *
     * Unconstrained, because a layout given a width wraps to fit it, and
     * asking a wrapped layout how big it is answers with several lines: the
     * title region came out sixty pixels tall for a fifteen pixel line of text,
     * and everything below it was pushed down the desklet with it.
     *
     * Every character is measured rather than the title as a whole, because
     * that is what has to be placed: the scroll moves the title by fractions of
     * a pixel, and a character is the only thing that can be given one. */
    _measureTitleText(text) {
        const layout = this._titleLayout;
        const value = text || '';

        this._titleFullText = value;

        /* The font comes from the label, whose style is the desklet's theme.
         *
         * The layout was copied once at build time, when the label had not been
         * styled yet, so it carries whatever the theme node had then rather than
         * the font the title is actually drawn in: measured in the default font
         * the title came out 273px wide and 14px tall where it is 316px and
         * 15px, and the strip would have been laid out against the wrong text.
         * Asking again costs nothing and cannot go stale. */
        try {
            const node = this._titleLabel.get_theme_node();
            const font = node ? node.get_font() : null;

            if (font)
                layout.set_font_description(font);
        } catch (e) {
            /* No font to ask for: the layout keeps the one it has. */
        }

        try {
            layout.set_width(-1);
            layout.set_ellipsize(Pango.EllipsizeMode.NONE);
            layout.set_text(value, -1);

            const size = layout.get_pixel_size();

            this._titleWidth = size[0];
            this._titleTextHeight = size[1];
        } catch (e) {
            this._titleWidth = 0;
            this._titleTextHeight = 0;
        }

        const xs = [];
        const ws = [];

        for (let i = 0; i < value.length; i++) {
            let rect = null;

            try {
                rect = layout.index_to_pos(i);
            } catch (e) {
                rect = null;
            }

            if (rect) {
                xs.push(rect.x / Pango.SCALE);
                ws.push(rect.width / Pango.SCALE);
            } else {
                xs.push(0);
                ws.push(0);
            }
        }

        this._titleCharX = xs;
        this._titleCharW = ws;
    }

    /* The empty space left between the end of the title and the start of the
     * next copy of it.
     *
     * A quarter of the window, so it reads as a pause between the two rather
     * than as a missing character, and never so small that the wrap looks
     * like a glitch. */
    _titleGap() {
        return Math.max(24, Math.round(this._titleViewport.get_width() * 0.3));
    }

    /* Puts one character in one of the strip's labels.
     *
     * The label's text is only set when it has changed, which is a handful of
     * times a second rather than once a frame; the position is set every
     * frame, and it is a float, which is the whole point. */
    _titleGlyph(slot, index, x, height) {
        const text = this._titleFullText;

        if (index < 0 || index >= text.length)
            return false;

        const label = this._titleGlyphs[slot];

        if (!label)
            return false;

        if (this._titleGlyphChars[slot] !== index) {
            label.text = text.charAt(index);
            label.set_size(this._titleCharW[index], height);
            this._titleGlyphChars[slot] = index;
        }

        label.set_x(x);
        label.set_y(0);

        if (!label.visible)
            label.show();

        return true;
    }

    /* Puts away every label the frame did not use. */
    _titleGlyphHideFrom(slot) {
        for (let i = slot; i < this._titleGlyphs.length; i++) {
            if (this._titleGlyphs[i].visible)
                this._titleGlyphs[i].hide();

            this._titleGlyphChars[i] = -1;
        }
    }

    /* The title when the whole of it fits: one label, all of it, where the
     * alignment setting says, and nothing moving.
     *
     * This is the ordinary case and it is the one the marquee must not touch. It
     * is drawn by the label rather than by the strip, because the strip exists
     * to scroll: it lays the title out as a run of single characters with a
     * second copy of it a gap behind, so a title that fits is drawn twice, once
     * in place and once offset, which reads as the title being broken in two.
     *
     * The alignment is the user's choice, and the default of left is what lines
     * the title up with the artist under it. Alignment is not something the
     * scrolling version can have either way: a title that has to scroll starts
     * at the left of the window because that is where the window starts, and
     * text wider than the window it is in has no edge of its own to line up
     * with. */
    _showStaticTitle(width, height) {
        const label = this._titleLabel;

        this._titleGlyphHideFrom(0);

        if (this._titleStrip.visible)
            this._titleStrip.hide();

        if (label.text !== this._titleFullText)
            label.text = this._titleFullText;

        /* Placed by the setting, by arithmetic, not by asking to be aligned.
         *
         * `x_align` is inert on this label: it is a child of the holder, which
         * is a plain widget with no layout manager, and alignment is something
         * a layout applies to a child. The title used to be centred because it
         * was a child of a box and the box centred it, and when the strip took
         * over the window that stopped being true: the label kept asking to be
         * centred and sat wherever its position was put.
         *
         * So the offset is worked out here from the measured width of the title
         * and the width of the window, and the label is given exactly the width
         * of the text so its box is the text and sits wholly inside the window
         * whichever way it is aligned. */
        /* The width of the text as St measures it, not the one the marquee
         * measured for itself.
         *
         * These are normally the same number, but they are not necessarily read
         * at the same moment: the strip's measurement can be taken while the
         * label is still being styled, when the font is not resolved yet, and
         * it then reads wider than the title really is. That is harmless for
         * the strip, which re-measures before it scrolls anything, but here it
         * put the title in the wrong place for a second or two after a track
         * change: a right-aligned title sat short of the right edge, and a
         * centred one sat off centre, by however much the stale measurement was
         * out by.
         *
         * The label's own preferred size is St measuring this label with the
         * font this label is drawn in, so it is the width of the thing being
         * placed. Reading it cannot reach anything else either: the label is a
         * child of the plain holder, so its width is not what the column is
         * sized from, which is the whole reason the strip keeps a width of its
         * own measured separately. */
        const preferred = label.get_preferred_size();
        const natural = preferred.length >= 4 ? preferred[2] : preferred[0];
        const rendered = Math.min(width, Number.isFinite(natural) ? natural : 0);
        let offset = 0;

        if (this._titleAlignment === Clutter.ActorAlign.CENTER)
            offset = Math.round((width - rendered) / 2);
        else if (this._titleAlignment === Clutter.ActorAlign.END)
            offset = width - rendered;

        offset = Math.max(0, offset);

        if (label.get_width() !== rendered)
            label.set_width(rendered);

        if (label.x !== offset)
            label.set_x(offset);

        if (label.get_height() !== height)
            label.set_height(height);

        if (label.x_align !== Clutter.ActorAlign.START)
            label.x_align = Clutter.ActorAlign.START;

        if (label.y !== 0)
            label.set_y(0);

        if (!label.visible)
            label.show();
    }

    /* The title when it does not fit: the strip owns the window, and the label
     * goes back to being nothing but a source of the desklet's theme. */
    _showScrollingTitle() {
        const label = this._titleLabel;

        if (label.text !== '')
            label.text = '';

        if (label.visible)
            label.hide();

        if (!this._titleStrip.visible)
            this._titleStrip.show();
    }

    /* Draws the title where the scroll has it.
     *
     * Two copies of the title, one after the other with the gap between them,
     * and the window moves across both. A character is placed only when all of
     * it is inside the window, so nothing here can be painted past the edge:
     * that is the same rule the old slice obeyed, and it is why the title
     * cannot end up over the desktop. Unlike the slice, it is a rule about
     * where a character is drawn rather than about how much text to hand a
     * label, so a character can be drawn anywhere inside the window, which is
     * what makes the movement smooth.
     *
     * The position is a float, so the characters glide. The loop is continuous
     * and wraps at the point where the second copy is exactly where the first
     * one started, so the wrap cannot be seen. */
    _updateTitleStrip(position) {
        const width = this._titleViewport.get_width();
        const height = this._titleTextHeight;

        /* A title that fits is not drawn here at all, whatever asks for it.
         *
         * The strip draws the title twice: once where it is and once a gap
         * behind it, ready to come in from the right on the next pass of the
         * loop. That second copy is the point when the title scrolls, and it is
         * the whole bug when it does not, because a title that fits has nothing
         * to scroll and the copy just sits there beside it. */
        if (this._marqueeOverflow <= 0) {
            this._titleGlyphHideFrom(0);
            return;
        }

        if (width <= 0 || !this._titleFullText || this._titleWidth <= 0) {
            this._titleGlyphHideFrom(0);
            return;
        }

        const pitch = this._titleWidth + this._titleGap();
        const length = this._titleFullText.length;
        const box = index => this._titleCharBox(index);
        let slot = 0;

        for (let copy = 0; copy < 2; copy++) {
            /* Where the left edge of this copy's text sits in the window, as an
             * offset into the text itself. */
            const range = Layout.titleVisibleRange(length, box, position - copy * pitch, width);

            for (let i = range.start; i < range.end; i++) {
                if (slot >= this._titleGlyphs.length)
                    break;

                const x = this._titleCharX[i] + copy * pitch - position;

                if (!this._titleGlyph(slot, i, x, height))
                    break;

                slot++;
            }
        }

        this._titleGlyphHideFrom(slot);
    }

    /* How far along the title the window is, in pixels, as a float.
     *
     * The position comes from how long the title has been scrolling, not from
     * how long the desklet has been running, so it can be held still. It also
     * never resets: it runs from the start of the title round to the start
     * again, so there is no jump to hide at the end of it. */
    _titleMarqueePosition() {
        const pitch = this._titleWidth + this._titleGap();

        if (!(pitch > 0))
            return 0;

        const after = Math.max(0, this._titleMarqueeElapsedMs - Layout.MARQUEE_DWELL_MS) / 1000;

        return (after * Layout.MARQUEE_PIXELS_PER_SECOND) % pitch;
    }

    /* Advances the scroll by however long it has been playing, and redraws.
     *
     * While paused the elapsed time is not accumulated and the anchor is moved
     * to now, so the scroll holds exactly where it was and picks up from there
     * rather than jumping by however long the pause was. */
    _titleMarqueeTick() {
        const now = GLib.get_monotonic_time();

        if (!this._playing) {
            /* Paused: the elapsed time is not accumulated, and the anchor moves
             * to now so that resuming carries on from exactly here rather than
             * jumping by however long the pause was. Nothing is redrawn because
             * nothing moved. */
            this._titleMarqueeAnchorUs = now;
            return;
        }

        this._titleMarqueeElapsedMs += (now - this._titleMarqueeAnchorUs) / 1000;
        this._titleMarqueeAnchorUs = now;

        const position = this._titleMarqueePosition();

        this._marqueeOffset = -position;
        this._updateTitleStrip(position);
    }

    _startTitleMarquee() {
        this._stopTitleMarquee();

        this._titleMarqueeElapsedMs = 0;
        this._titleMarqueeAnchorUs = GLib.get_monotonic_time();

        /* A title that fits is not scrolled at all, so there is no timer to run
         * and nothing to draw: the label is already showing all of it. */
        if (this._marqueeOverflow <= 0) {
            this._titleGlyphHideFrom(0);
            return;
        }

        this._updateTitleStrip(0);

        this._titleMarqueeFrameId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, MARQUEE_STEP_MS, () => {
            this._titleMarqueeTick();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _stopTitleMarquee() {
        if (this._titleMarqueeFrameId > 0) {
            GLib.source_remove(this._titleMarqueeFrameId);
            this._titleMarqueeFrameId = 0;
        }
    }

    /* --------------------------------------------------------------- Timeline */

    /* Current position as a fraction of the track, or 0 when there is nothing
     * to play. While the handle is being dragged the fraction the user is
     * pointing at wins, so the bar cannot snap back mid drag.
     *
     * The length is passed in rather than read from the field, so the fraction
     * is worked out against the same length the elapsed label was formatted
     * with. Reading it from a field instead means the two can disagree, and they
     * do exactly that for the frame or two after a track change: MPRIS metadata
     * reaches the client asynchronously, so the length held here is still the
     * previous track's while the position is already the new one. The label
     * would then read "1:04" of "2:25" while the bar sat a third of the way
     * along. */
    _timelineFraction(positionUs, lengthUs) {
        if (this._seeking)
            return this._dragFraction;

        if (!(lengthUs > 0))
            return 0;

        return Layout.clamp(positionUs / lengthUs, 0, 1);
    }

    /* Re-draws the play head once the rail has settled on its final width.
     *
     * A resize arrives as a notification part way through a relayout, while the
     * rail is still being measured and may not have its final width yet. Drawing
     * straight from the notification therefore draws against whatever width the
     * rail happens to be on that frame, which for a column that is still
     * settling can be well short of the one it ends up at: the played part is
     * then drawn a third of the way along a rail that is three times as long.
     *
     * Waiting for the idle means drawing against the width the rail settled on.
     * The position timer redraws every second regardless, so this is only about
     * not getting the intermediate widths on screen. */
    _scheduleTimelineRender() {
        if (this._timelineUpdateId > 0)
            return;

        this._timelineUpdateId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._timelineUpdateId = 0;
            this._renderPosition(this._lengthUs);

            return GLib.SOURCE_REMOVE;
        });
    }

    _renderTimeline(positionUs, lengthUs) {
        if (positionUs === undefined)
            positionUs = this._currentPositionUs();

        if (lengthUs === undefined)
            lengthUs = this._lengthUs;

        const fraction = this._timelineFraction(positionUs, lengthUs);

        /* The width the fill is measured against is the width the rail is
         * *meant* to be, not whatever it happens to be right now.
         *
         * The rail is a child of a box that is being resized, and St allocates
         * it in stages, so at the moment a position update is rendered it can
         * briefly hold a width a fraction of the one it is about to settle on.
         * Measuring the fill against that gives a fill that is the right shape
         * at the wrong size: the desklet draws "half a bar" for a moment on
         * every tick, and a long enough window of them looks like the bar
         * stuttering.
         *
         * The layout has already worked out how wide the information column is,
         * and that is the width the rail is allocated once the resize settles,
         * so the fill is worked out from that instead. The live allocation is
         * used only as a fallback before the first layout pass has run, and a
         * zero rail draws nothing rather than a stale bar. */
        const intendedWidth = this._railWidth > 0
            ? this._railWidth
            : this._seekTrack.get_width();

        const trackWidth = Math.max(0, intendedWidth);
        const geometry = Layout.timelineGeometry(
            fraction, trackWidth, SEEK_HANDLE_SIZE);

        this._seekFill.set_width(geometry.fillWidth);
        this._seekFill.set_position(0, 0);

        /* The handle is placed on the rail rather than laid out inside it, so
         * it is centred here: half of it is above the rail and half below, and
         * neither the box nor the time labels have to make room for it. */
        this._seekHandle.set_position(
            geometry.handleX, -(SEEK_HANDLE_SIZE - SEEK_TRACK_HEIGHT) / 2);
    }

    _onSeekPress(event) {
        /* Only the primary button drags. Anything else, button 3 in
         * particular, belongs to Cinnamon: its Desklet handler sits on an
         * ancestor of this actor and needs the release to open the
         * configuration menu, so those events are left alone. */
        if (event.get_button() !== Clutter.BUTTON_PRIMARY)
            return Clutter.EVENT_PROPAGATE;

        if (!this._canSeek) {
            /* A drag left over from a track that has since become unseekable
             * would otherwise never end, and the bar would sit at whatever
             * fraction it was dropped on for the rest of the session. */
            this._cancelSeekDrag();

            return Clutter.EVENT_PROPAGATE;
        }

        this._seeking = true;
        this._updateDragFromEvent(event);

        /* Stopped on purpose. Cinnamon makes the whole desklet draggable from
         * any button 1 press on any part of it, by grabbing the pointer in a
         * handler on the desklet container. Letting this press through would
         * hand the pointer to that grab and the seek drag would never see a
         * single motion event, because the desklet would be dragged instead.
         * The rest of the body, and the header, still start a desklet drag. */
        return Clutter.EVENT_STOP;
    }

    _onSeekMotion(event) {
        if (!this._seeking)
            return Clutter.EVENT_PROPAGATE;

        this._updateDragFromEvent(event);

        return Clutter.EVENT_STOP;
    }

    _onSeekRelease(event) {
        if (event.get_button() !== Clutter.BUTTON_PRIMARY)
            return Clutter.EVENT_PROPAGATE;

        if (!this._seeking)
            return Clutter.EVENT_PROPAGATE;

        this._updateDragFromEvent(event);
        this._commitSeek();

        /* Also stopped, so the release does not carry on to the body handler
         * and turn a seek into a play/pause. */
        return Clutter.EVENT_STOP;
    }

    /* Ends a drag without seeking, and puts the bar back on the position the
     * player is actually at.
     *
     * The drag flag is cleared first and unconditionally, so no path out of a
     * drag can leave it set. A flag that survived would keep the bar drawn at
     * the fraction the pointer was last at, overriding every later position
     * update, which is how a paused track could appear to sit halfway along a
     * track it was nowhere near. */
    _cancelSeekDrag() {
        const wasSeeking = this._seeking;

        this._seeking = false;

        if (wasSeeking) {
            this._dragFraction = 0;
            this._renderPosition(this._lengthUs);
        }
    }

    _updateDragFromEvent(event) {
        const [stageX] = event.get_coords();
        const [trackX] = this._seekTrack.get_transformed_position();

        this._dragFraction = Layout.seekFraction(stageX, trackX, this._seekTrack.get_width());

        /* The elapsed time follows the pointer while it is being dragged. That
         * is the number the position would end up at, so it is the one worth
         * showing, and it is what makes a drag feel like it is doing something
         * before the player has been asked. */
        this._elapsedLabel.set_text(Layout.formatTime(this._dragFraction * this._lengthUs));
        this._renderTimeline();
    }

    /* Hands the requested position to the player and re-anchors the display on
     * it, so the bar does not jump back to where the player was while the seek
     * is still in flight. The player confirms with a Seeked signal, which
     * arrives as a normal position update and retires the pending seek through
     * _adoptPosition(). */
    _commitSeek() {
        const player = this._playerManager?.activePlayer;
        const positionUs = Math.round(this._dragFraction * this._lengthUs);

        this._seeking = false;

        if (!player || !this._canSeek) {
            /* Nothing to seek through, so the drag ends here and the bar goes
             * back to the position the player is at rather than staying where
             * the pointer was let go. */
            this._dragFraction = 0;
            this._renderPosition(this._lengthUs);

            return;
        }

        this._logger.debug(`seeking to ${Layout.formatTime(positionUs)}`);

        /* Set before the request leaves, because the reply to the confirmation
         * read below can arrive before the player has finished seeking, and it
         * must not be allowed to put the old position back on screen. */
        this._pendingSeekUs = positionUs;
        this._pendingSeekTrackId = Mpris.firstString(
            player.getMetadata()[Mpris.MetadataKey.TRACK_ID]);
        this._seekConfirmed = false;

        player.setPosition(positionUs);

        /* The display is anchored on the requested position and the anchor's
         * clock starts here, so a seek made while paused resumes from exactly
         * here and the bar does not move while the player catches up. */
        this._positionAnchorUs = positionUs;
        this._positionAnchorMs = GLib.get_monotonic_time() / 1000;
        this._renderPosition(this._lengthUs);

        /* Position is a cached property that players are free not to refresh,
         * and a player that is not playing gets no updates at all, so the real
         * value is asked for once to confirm where playback ended up. This is
         * a single call, not a poll.
         *
         * The answer goes through _adoptPosition(), not straight to the
         * display, so a reply that is still the old position is dropped rather
         * than undoing the seek. */
        this._requestPosition(player);
    }

    /* Seeking is only offered when the player says it can, and there is
     * something to seek through. */
    _updateSeekAvailability(capabilities, lengthUs) {
        const canControl = capabilities ? capabilities.canControl === true : false;
        const canSeek = canControl && capabilities.canSeek === true;

        this._canSeek = canSeek && lengthUs > 0;
        this._seekTrack.set_reactive(this._canSeek);
        this._seekHandle.set_reactive(this._canSeek);

        /* A drag in progress cannot be completed against a track that has just
         * stopped being seekable, so it is ended rather than left holding the
         * bar at a fraction the player will never reach. */
        if (!this._canSeek)
            this._cancelSeekDrag();
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
        /* A Seeked signal: the player announcing where it has landed. It is
         * handled like any other update, and what it brings is always taken. */
        connect('position-changed', () => this._updateFromPlayer());
        connect('capabilities-changed', () => this._updateFromPlayer());
    }

    _onActivePlayerChanged() {
        const player = this._playerManager.activePlayer;
        this._logger.debug(player ? `showing ${player.id}` : 'no active player');

        this._trackPlayerSignals(player);
        this._updateFromPlayer();
    }

    /* Drops a seek that is waiting to be confirmed once the track it was made
     * in is no longer the one being displayed. */
    _retirePendingSeekOnTrackChange() {
        if (this._pendingSeekUs < 0)
            return;

        const player = this._playerManager?.activePlayer;
        const trackId = Mpris.firstString(player.getMetadata()[Mpris.MetadataKey.TRACK_ID]);

        if (trackId === this._pendingSeekTrackId)
            return;

        this._logger.debug('track changed, dropping the pending seek');
        this._pendingSeekUs = -1;
        this._seekConfirmed = false;
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

        /* A track change invalidates a seek that was in flight, which would
         * otherwise hold the new track's display at the old track's target
         * until the player happened to report a position near it. */
        this._retirePendingSeekOnTrackChange();

        this._setTitle(Mpris.firstString(metadata[Mpris.MetadataKey.TITLE]) || player.playerName);
        const artist = Mpris.joinStrings(metadata[Mpris.MetadataKey.ARTIST]);

        if (this._artistLabel.text !== artist)
            this._columnNatural = 0;

        this._artistLabel.set_text(artist);

        this._artworkManager.setArtworkUrl(
            Mpris.firstString(metadata[Mpris.MetadataKey.ART_URL]) || null);

        this._setPlayPauseIcon(status);
        this._updateControlSensitivity(capabilities, hasTrack);
        this._updatePosition(player, status, hasTrack, capabilities);
    }

    /* Players re-send the full metadata on every state change, so the same
     * title arrives repeatedly. Setting it again would restart the marquee for
     * no reason, so an unchanged title is ignored.
     *
     * The comparison is against the whole title rather than the label, because
     * the label holds only the window of it that currently fits. */
    _setTitle(text) {
        if (this._titleFullText === text)
            return;

        this._titleFullText = text;
        this._marqueeDirty = true;
        /* A new title is a new natural height: a taller track name makes the
         * column taller, and a reused measurement would lay the controls out
         * for the previous one. */
        this._columnNatural = 0;
        this._scheduleMarqueeUpdate();
    }

    _setPlaceholder() {
        this._stopPositionTimer();
        this._positionAnchorUs = 0;
        this._positionAnchorMs = 0;
        this._lengthUs = 0;
        this._cancelSeekDrag();
        this._canSeek = false;
        this._playing = false;
        this._pausedPositionUs = 0;
        this._pendingSeekUs = -1;
        this._seekConfirmed = false;
        this._seekTrack.set_reactive(false);
        this._seekHandle.set_reactive(false);

        this._titleFullText = PLACEHOLDER_TEXT;
        this._titleGlyphHideFrom(0);
        this._artistLabel.set_text('');
        this._elapsedLabel.set_text('');
        this._durationLabel.set_text('');
        this._seekFill.set_width(0);
        this._seekHandle.set_position(0, -(SEEK_HANDLE_SIZE - SEEK_TRACK_HEIGHT) / 2);
        this._marqueeOverflow = 0;
        this._startTitleMarquee();

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

        this._artworkBox.set_style_class_name(`umd-artwork ${className}`);

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

        this._artworkIsPlaceholder = true;
        this._artworkAspect = 1;
        this._applyArtworkSize();
        /* The shape of the cover is part of the layout, not only of the box: the
         * frame is held to the height the cover and the column together need, so
         * a cover that changes shape needs the layout worked out again rather than
         * the box left at the height the last shape reserved for it. */
        this._scheduleLayoutUpdate();
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

        this._artworkIsPlaceholder = false;
        /* Read from the file that was just written, so the loading and caching
         * above are unchanged and only the shape of what came out is used. */
        this._artworkAspect = artworkAspect(path) || 1;
        this._applyArtworkSize();
        /* A 16:9 frame needs 90 of the height a square cover needs 160 of, and the
         * layout reserves the room and the frame is held to what is in it, so a
         * cover that is not square both gives the column more room and lets the
         * desklet end shortly below the controls rather than 70px above the bottom
         * of them. Both of those come from a layout pass, so one is asked for. */
        this._scheduleLayoutUpdate();

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
     * still shows a moving elapsed time between polls.
     *
     * A status change arrives here too, and that is the dangerous case: it is
     * the moment the player is most likely to report a position that is not the
     * one the desklet is already showing. So this reads the position and hands
     * it to _adoptPosition(), which decides whether it is allowed to replace
     * what is on screen. */
    _updatePosition(player, status, hasTrack, capabilities) {
        const length = player.getLength();

        this._updateSeekAvailability(capabilities, length);

        /* A different length means a different track, and the position on
         * screen belongs to the old one.
         *
         * MPRIS metadata reaches the client asynchronously, so for a short while
         * after a track change this reads the previous track's length while the
         * position has already moved to the new one. Left alone that puts the
         * bar and the elapsed label on two different tracks at once. The
         * position is dropped rather than rescaled, because there is no correct
         * way to guess where in a track we have not measured we are, and the
         * read below replaces it as soon as the player answers. */
        if (length !== this._lengthUs) {
            this._lengthUs = length;
            this._positionAnchorUs = 0;
            this._pausedPositionUs = 0;
            this._pendingSeekUs = -1;

            this._logger.debug(`track length ${Layout.formatTime(length)}`);
        }

        const playing = status === Mpris.PlaybackStatus.PLAYING;

        /* The wall clock that drives the extrapolation is restarted every time
         * playback starts and stopped every time it pauses.
         *
         * This is the one that makes the frozen position work without freezing
         * the wrong thing. While paused nothing re-anchors, so the clock's
         * timestamp goes stale along with everything else. If it were left
         * running, the first frame after Play would measure the whole pause as
         * elapsed playback: a ten second pause would put the bar ten seconds
         * further on, and a ten minute one would run it to the end of the track
         * and pin it there, because every real position afterwards would then be
         * behind the display and be discarded as a regression.
         *
         * So the timestamp is the moment playback last started, and the elapsed
         * time is only ever measured across continuous playing. */
        if (playing !== this._playing) {
            this._positionAnchorMs = GLib.get_monotonic_time() / 1000;

            /* And a position that arrived while paused describes a moment that
             * has passed, so it cannot anchor a run of playback either. The
             * player is asked for the real one below, and until it answers the
             * anchor stays where the pause left it rather than advancing. */
            if (playing)
                this._positionAnchorUs = this._pausedPositionUs;
        }

        this._playing = playing;

        if (!hasTrack || length <= 0) {
            this._stopPositionTimer();
            this._durationLabel.set_text('');
            this._pendingSeekUs = -1;
            this._pausedPositionUs = 0;
            this._renderPosition(0);
            return;
        }

        this._durationLabel.set_text(Layout.formatTime(length));

        /* A status change is the moment the player is most likely to be holding
         * a position that is not the one being displayed: the cached property
         * is whatever it was last refreshed to, and the specification does not
         * even require players to refresh it. So a real read off the bus is
         * asked for, and it is the answer that moves the display. The cache is
         * only ever a starting value, never the last word. */
        this._requestPosition(player);

        this._startPositionTimer(player);

        if (!this._playing) {
            this._stopPositionTimer();
            /* Frozen here, so resuming starts from it rather than from whatever
             * the cache happens to say. */
            this._pausedPositionUs = this._currentPositionUs();
        }
    }

    /* Asks the player where it is, and takes the answer only if nothing newer
     * has been asked since.
     *
     * The read is a round trip over D-Bus, so it is answered whenever it is
     * answered rather than whenever it was asked. There is always more than one
     * of them in flight: the timer asks every second, a status change asks again
     * on top of that, and a seek asks for a confirmation as well. Two replies
     * asked for in the order A then B can arrive B then A, and letting the older
     * one through puts the clock back to a moment that has already been passed.
     *
     * The serial makes that impossible in the only way that works: a reply that
     * has been overtaken is dropped rather than weighed against the display.
     * Comparing it against the position on screen instead would be worse than
     * doing nothing, because a position the desklet is already ahead of is
     * precisely the one it is getting right, and refusing it pins the bar
     * wherever it last was. */
    _requestPosition(player) {
        const serial = ++this._positionRequestSerial;

        player.refreshPosition(reported => {
            if (this._playerManager?.activePlayer !== player)
                return;

            if (serial !== this._positionRequestSerial) {
                this._logger.debug('dropping an overtaken position read');

                return;
            }

            this._adoptPosition(player, reported);
        });
    }

    /* Offers a position read from the player to the display.
     *
     * There is only one thing to decide here, and it is the whole of the rule:
     * whether a seek is in flight. Everything the caller passes has been read
     * off the bus, which is a synchronous Get of a value the player is holding
     * right now, so it is what the position is. It needs no further weighing,
     * and treating it as though it did is actively harmful: a bar that has run
     * ahead for any reason at all would then refuse the real position, because
     * the real one looks like a regression, and stay wrong for the rest of the
     * track. A bar that briefly shows a second behind where the clock has got
     * is invisible; a bar stuck at the end of a track is not.
     *
     *   a seek is in flight   the player has not been asked to move yet, so
     *                          anything it reports is the old position. It is
     *                          ignored, and the requested position keeps being
     *                          drawn until the player lands near it. This is the
     *                          race from the report, and it is the only reason
     *                          this method exists.
     *   anything else        taken, and the clock is re-anchored on it.
     */
    _adoptPosition(player, reported) {
        if (this._pendingSeekUs >= 0) {
            if (!Layout.positionAgrees(this._pendingSeekUs, reported)) {
                this._logger.debug(
                    `seek to ${Layout.formatTime(this._pendingSeekUs)} still pending, ` +
                    `ignoring ${Layout.formatTime(reported)}`);

                /* Re-render from the requested position so the drag does not
                 * snap back the moment the release event is handled. */
                this._renderPosition(this._lengthUs);
                return;
            }

            this._logger.debug(`seek to ${Layout.formatTime(reported)} confirmed`);
            this._pendingSeekUs = -1;
            this._seekConfirmed = true;
        }

        this._showPosition(player, reported);
    }

    /* Anchors the display on a position that has been accepted. */
    _showPosition(player, position) {
        /* The length already decided for this pass, rather than a second read of
         * the same cache: two reads a moment apart can disagree, and the one
         * that formatted the elapsed time has to be the one the bar is drawn
         * against. */
        const length = this._lengthUs;

        if (length <= 0) {
            this._elapsedLabel.set_text('');
            this._renderTimeline(0, 0);
            return;
        }

        /* Anchor the extrapolation at the position just read. */
        this._positionAnchorUs = position >= 0 ? position : 0;
        this._positionAnchorMs = GLib.get_monotonic_time() / 1000;

        this._renderPosition(length);
    }

    _currentPositionUs() {
        return Layout.extrapolatePosition(
            this._positionAnchorUs, this._positionAnchorMs,
            GLib.get_monotonic_time() / 1000, this._playing, this._lengthUs);
    }

    _renderPosition(length) {
        const bounded = length > 0 ? length : this._lengthUs;
        const position = Math.min(this._currentPositionUs(), bounded > 0 ? bounded : 0);

        if (bounded > 0)
            this._elapsedLabel.set_text(Layout.formatTime(position));

        this._renderTimeline(position, bounded);
    }

    _startPositionTimer(player) {
        if (this._positionTimerId > 0)
            return;

        this._positionTimerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, POSITION_TICK_MS, () => {
            if (this._playerManager.activePlayer !== player) {
                this._positionTimerId = 0;
                return GLib.SOURCE_REMOVE;
            }

            /* A track change is not announced by a signal of its own, and MPRIS
             * metadata reaches this side asynchronously, so the length is
             * re-read on every tick. That is what keeps the bar and the elapsed
             * label on the same track once a new one has arrived. */
            const length = player.getLength();

            if (length !== this._lengthUs) {
                this._lengthUs = length;
                this._positionAnchorUs = 0;
                this._pausedPositionUs = 0;
                this._durationLabel.set_text(length > 0 ? Layout.formatTime(length) : '');
                this._logger.debug(`track length ${Layout.formatTime(length)}`);
            }

            /* Re-read the real position off the bus, which re-anchors the clock
             * and so keeps the extrapolation from drifting. */
            this._requestPosition(player);

            this._renderPosition(this._lengthUs);

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
        this._stopTitleMarquee();
        this._trackPlayerSignals(null);

        if (this._layoutUpdateId > 0) {
            GLib.source_remove(this._layoutUpdateId);
            this._layoutUpdateId = 0;
        }

        if (this._marqueeUpdateId > 0) {
            GLib.source_remove(this._marqueeUpdateId);
            this._marqueeUpdateId = 0;
        }

        if (this._timelineUpdateId > 0) {
            GLib.source_remove(this._timelineUpdateId);
            this._timelineUpdateId = 0;
        }

        this._artworkManager?.destroy();
        this._playerManager?.destroy();

        this._artworkManager = null;
        this._playerManager = null;
    }
}

function main(metadata, deskletId) {
    return new UniversalMusicDesklet(metadata, deskletId);
}
