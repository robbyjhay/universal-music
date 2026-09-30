// lib/layout.js
//
// Presentation arithmetic for Universal Music.
//
// Every function in this module is a plain computation over plain numbers:
// no GObject, no Clutter, no St and no D-Bus. desklet.js measures the real
// desklet allocation and asks this module what to do with it. That keeps the
// layout rules, the timeline geometry and the title marquee in one readable
// place, and testable without a running Cinnamon session.
//
// Nothing here knows about MPRIS or about any particular player.

/**
 * LayoutMode
 *
 * The shape the desklet draws itself in, chosen from the space it was given.
 */
const LayoutMode = Object.freeze({
    /* Cover above the track information. */
    VERTICAL: 'vertical',
    /* Cover beside the track information. */
    HORIZONTAL: 'horizontal',
    /* Not enough room for the full layout: information is dropped. */
    COMPACT: 'compact',
});

/* Break points below, all measured on the content box, i.e. the desklet
 * allocation minus its own padding. They are deliberately generous in the
 * middle: switching to a side by side layout only pays off once the widget is
 * clearly wider than it is tall, and a desklet that is a little too short for
 * the full layout loses its artist line and its time labels rather than its
 * controls. */
const COMPACT_MIN_WIDTH = 132;
const COMPACT_MIN_HEIGHT = 116;

/* A side by side layout also needs enough width for both columns to stay
 * legible, so wide-but-short on its own is not enough. */
const HORIZONTAL_MIN_WIDTH = 240;
const HORIZONTAL_MIN_ASPECT = 1.35;

/* Hard ceiling on the desklet, in pixels. This is the single bound that makes
 * the layout provably convergent, and it is deliberately small.
 *
 * The desklet is sized to its own contents, so the sizes it reports *are* the
 * size it gets, and every one of them can be traced back to a measurement of
 * the last one. That is a loop, and a loop with a gain above one does not
 * settle: one pass measured a little wider, asked for a little more, and the
 * widget grew until it was millions of pixels across, which is enough to take
 * the compositor down with it.
 *
 * So the measurement itself is clamped here, before anything is worked out from
 * it, and the information column is capped at the width the desklet will not go
 * below. Between them, no layout can ask for more than this: a widget that has
 * lost track of what it is supposed to look like can produce a wrong looking
 * desklet, never one wider than this. */
const MAX_CONTENT_WIDTH = 420;

/* The cover keeps its own aspect ratio, so it is always drawn into a square.
 * These bound that square: never so small that the cover stops being readable,
 * and in the compact layout never large enough to squeeze out the controls. */
const MIN_ARTWORK_SIZE = 32;
const COMPACT_ARTWORK_MAX_SIZE = 56;

/* The dimensions the user can ask for. Both axes have a finite hard limit, and
 * they are the only numbers that are ever handed to St as a size: a value that
 * has been through clampWidgetSize() cannot be larger than MAX_WIDGET_WIDTH or
 * MAX_WIDGET_HEIGHT however it was typed, stored or corrupted.
 *
 * Both ceilings are derived from the layout above rather than picked to look
 * generous, because past them the layout stops gaining anything:
 *
 *   width   the side by side layout needs HORIZONTAL_MIN_WIDTH to engage at
 *           all, and the largest preset is 340px wide. A little past that the
 *           extra width is only ever handed to the text column and the seek
 *           rail, which look stretched rather than roomier.
 *   height  the stacked layout sizes the cover from what is left of the height
 *           once the information column has had its share, and the cover stops
 *           growing once it reaches ARTWORK_SIZES.large. The largest preset is
 *           380px tall, so anything past that is empty background below a
 *           column that has already stopped needing room.
 *
 * Both presets and the custom sizes therefore have somewhere useful to go
 * without the widget becoming a poster for one track. */
const MIN_WIDGET_WIDTH = 150;
const MAX_WIDGET_WIDTH = 420;
const MIN_WIDGET_HEIGHT = 100;
const MAX_WIDGET_HEIGHT = 440;

/* The size presets, in pixels.
 *
 * These are the width the desklet was given before there was a width setting,
 * and each one is its own class in stylesheet.css: the same numbers decide the
 * padding, the spacing and the cover limit, so a preset and an exact size are
 * the same answer rather than two systems that have to be kept in step.
 *
 * The height of each is what the layout needs to draw itself without being cut
 * off: the cover plus the information column plus the padding and the gap
 * between them. Every one of them is inside MIN/MAX_WIDGET_*, so a preset can
 * never be a way around the limits. */
const SIZE_PRESETS = {
    small: { width: 150, height: 260 },
    medium: { width: 180, height: 310 },
    large: { width: 220, height: 380 },
    wide: { width: 340, height: 180 },
};

/* The preset used when the setting holds something that is not a preset, and
 * the dimensions it stands for. */
const DEFAULT_PRESET = 'medium';
const DEFAULT_SIZE = SIZE_PRESETS[DEFAULT_PRESET];

/* The preset key that means "use the width and the height settings". Choosing
 * one of the named presets instead fills those two settings in, so a preset is
 * a starting point rather than a second, competing source of truth. */
const CUSTOM_PRESET = 'custom';

/* Marquee tuning. Text moves at a constant speed with a pause at each end,
 * which reads as a deliberate scroll rather than a distracting ticker. The
 * duration is derived from how far the text has to travel and is clamped so
 * that neither a slightly long nor a very long title produces silly speeds. */
const MARQUEE_PIXELS_PER_SECOND = 26;
const MARQUEE_MIN_DURATION_MS = 1800;
const MARQUEE_MAX_DURATION_MS = 12000;
const MARQUEE_DWELL_MS = 1100;

/* Below this, a title is simply clipped rather than scrolled. A title that is a
 * few pixels too wide would otherwise creep along for the whole time it is on
 * screen, which reads as a glitch rather than as a deliberate scroll. */
const MARQUEE_MIN_OVERFLOW = 6;

/**
 * MarqueeSegmentKind
 *
 * A hold keeps the text still for a moment; a slide moves it.
 */
const MarqueeSegmentKind = Object.freeze({
    HOLD: 'hold',
    SLIDE: 'slide',
});

/**
 * clamp
 * @value (number), @min (number), @max (number)
 *
 * Constrains a value to a range. A reversed range collapses to @min, so a
 * caller can never be handed an impossible value by bad input.
 */
function clamp(value, min, max) {
    if (max < min)
        return min;

    if (!Number.isFinite(value))
        return min;

    return Math.min(Math.max(value, min), max);
}

/**
 * presetSize
 * @key (string): a preset name.
 *
 * The dimensions of one of the named size presets, clamped like any other
 * width so a preset can never be a way around the limits. Returns null for
 * "custom" and for anything that is not a preset, which is the caller's cue
 * to use the width and height settings instead.
 */
function presetSize(key) {
    if (!Object.prototype.hasOwnProperty.call(SIZE_PRESETS, key))
        return null;

    return clampWidgetSize(SIZE_PRESETS[key].width, SIZE_PRESETS[key].height);
}

/**
 * clampWidgetSize
 * @width, @height (numbers)
 *
 * The size the desklet is actually given.
 *
 * Everything a user can type arrives here first, and everything that comes out
 * is a whole number of pixels inside the hard limits. That is the whole point
 * of the function: it is the only route from a setting to a size, so a value
 * cannot reach St without passing the bounds, and a value that is not a number
 * at all cannot reach it either.
 *
 * A value that is missing, negative, fractional, NaN or infinite comes out as
 * the default preset, rather than as the minimum, because the minimum is a
 * usable size but a broken setting is not something to interpret. Only a value
 * that is genuinely too large or genuinely too small is clamped to the nearest
 * limit, so a number the user did mean survives as close to what they meant as
 * the limits allow.
 */
function clampWidgetSize(width, height) {
    return {
        width: clampDimension(width, MIN_WIDGET_WIDTH, MAX_WIDGET_WIDTH, DEFAULT_SIZE.width),
        height: clampDimension(height, MIN_WIDGET_HEIGHT, MAX_WIDGET_HEIGHT, DEFAULT_SIZE.height),
    };
}

/**
 * clampDimension
 * @value (number), @min (number), @max (number), @fallback (number)
 *
 * One axis of clampWidgetSize(): rounded to a whole pixel and held inside @min
 * and @max. Anything that is not a usable number becomes @fallback, which is
 * itself inside the limits, so this cannot return a value outside them
 * whatever it is handed.
 */
function clampDimension(value, min, max, fallback) {
    const size = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : NaN;

    return clamp(Number.isFinite(size) ? size : fallback, min, max);
}

/**
 * resolveWidgetSize
 * @options (object):
 *   preset: name of the size preset, or "custom".
 *   width:  the width setting, in pixels.
 *   height: the height setting, in pixels.
 *
 * The one place a size is decided: a named preset brings its own dimensions,
 * anything else uses the width and height settings, and both come out clamped.
 *
 * Returns:
 *   { width, height, preset, custom }
 * where preset is the key that was used, or the default one if the setting held
 * something that is not a preset, and custom says whether the width and height
 * settings are what the size came from.
 */
function resolveWidgetSize(options) {
    const settings = options || {};
    /* "custom" is named here rather than derived from SIZE_PRESETS not holding
     * it, because it has to be told apart from a preset that is not a preset:
     * one means the width and height settings decide, the other is a stale or
     * corrupt value that falls back to the default. */
    const custom = settings.preset === CUSTOM_PRESET;
    const key = Object.prototype.hasOwnProperty.call(SIZE_PRESETS, settings.preset)
        ? settings.preset
        : DEFAULT_PRESET;
    const fromPreset = custom ? null : presetSize(key);
    const size = fromPreset || clampWidgetSize(settings.width, settings.height);

    return {
        width: size.width,
        height: size.height,
        preset: custom ? CUSTOM_PRESET : key,
        custom,
    };
}

/**
 * resolveLayout
 * @options (object):
 *   width:           content width in pixels.
 *   height:          content height in pixels.
 *   minWidth:        the width the desklet will never be narrower than, in
 *                    pixels, or 0 when that is not known.
 *   infoHeight:      natural height of the information column in pixels, or 0
 *                    when it has not been measured yet.
 *   artistHeight:    natural height of the artist line, or 0.
 *   timesHeight:     natural height of the time labels row, or 0.
 *   artworkMax:      largest cover the size preset allows, in pixels.
 *   artworkPadding:  horizontal padding of the cover box, in pixels.
 *   spacing:         spacing between the cover and the information column.
 *
 * Decides the shape of the desklet for one particular allocation. The cover
 * size is the minimum of what the preset allows and what actually fits.
 *
 * Everything here is worked out from @width and @height, which the caller has
 * already reduced to the inside of the desklet's own frame, and the answer
 * describes children that fit inside exactly that: the cover box, the height
 * the information column may occupy, and which of its optional rows there is
 * room for. A child that would not fit is asked for a smaller size rather than
 * being allowed to draw past the frame.
 *
 * Returns:
 *   mode, vertical, artworkSize, artworkBoxWidth, showArtwork, infoMaxWidth,
 *   columnMaxHeight, showArtist, showTimes, contentWidth, contentHeight
 */
function resolveLayout(options) {
    const width = Math.max(0, Number(options.width) || 0);
    const height = Math.max(0, Number(options.height) || 0);
    const minWidth = Math.max(0, Number(options.minWidth) || 0);
    const infoHeight = Math.max(0, Number(options.infoHeight) || 0);
    const artistHeight = Math.max(0, Number(options.artistHeight) || 0);
    const timesHeight = Math.max(0, Number(options.timesHeight) || 0);
    const padding = Math.max(0, Number(options.artworkPadding) || 0);
    const artworkMax = Math.max(MIN_ARTWORK_SIZE, Number(options.artworkMax) || 0);

    /* The gap between the cover and the information column is measured from the
     * running layout, and it is the one input that is added rather than
     * subtracted, so it is the one input that can push two children out of the
     * box they are laid out in: a gap of 5000px in a 260px widget asks for
     * 5000px more than there is. It is bounded by the widget here, once, where
     * everything downstream can treat it as a gap that fits.
     *
     * A gap wider or taller than the widget collapses to nothing rather than to
     * its own size, because there is no room for both a gap and the children it
     * separates: the children still have to be inside the widget. */
    const measuredSpacing = Math.max(0, Number(options.spacing) || 0);
    const spacing = Math.min(measuredSpacing, Math.max(width, height));

    /* No usable measurement yet: fall back to the stacked layout, which is the
     * one that needs the least room, and let the next allocation correct it. */
    if (width <= 0 || height <= 0)
        return buildLayout(LayoutMode.VERTICAL, { width, height, minWidth, infoHeight, artistHeight, timesHeight, artworkMax, padding, spacing });

    /* A wide desklet is checked first, because it is the one layout that does
     * not need much height: the information column is a narrow strip and the
     * cover takes whatever vertical room is left. */
    if (width >= HORIZONTAL_MIN_WIDTH && width / height >= HORIZONTAL_MIN_ASPECT) {
        return buildLayout(LayoutMode.HORIZONTAL, { width, height, minWidth, infoHeight, artistHeight, timesHeight, artworkMax, padding, spacing });
    }

    /* Otherwise the cover and the information are stacked, and a desklet that
     * cannot hold both comfortably drops to the compact layout. */
    if (width < COMPACT_MIN_WIDTH || height < COMPACT_MIN_HEIGHT) {
        return buildLayout(LayoutMode.COMPACT, {
            width, height, minWidth, infoHeight, artistHeight, timesHeight,
            artworkMax: Math.min(artworkMax, COMPACT_ARTWORK_MAX_SIZE),
            padding, spacing,
        });
    }

    return buildLayout(LayoutMode.VERTICAL, { width, height, minWidth, infoHeight, artistHeight, timesHeight, artworkMax, padding, spacing });
}

/* The rooms are deliberately spelled out rather than folded into a ternary:
 * assigning to an undeclared name is a runtime error in a module but not a
 * parse error, so `node --check` and GJS's importer both accept a file that
 * throws the moment this runs. Every local in this module is declared for that
 * reason, and the strict mode it is loaded under would refuse the assignment. */
function buildLayout(mode, size) {
    const horizontal = mode === LayoutMode.HORIZONTAL;

    /* The cover is square and keeps its aspect ratio, so it can only grow
     * along the axis that is left over: the height when the information sits
     * beside it, the width when the information sits below it.
     *
     * When the information sits beside it, the height of that column is the
     * better yardstick. Using the desklet's own height here would make the
     * cover chase it, because a taller cover asks for a taller desklet.
     *
     * When the information sits below it, the cover is bounded on the other
     * axis too: what is left of the height once the column and the gap between
     * them are taken out of it. Without that, a height chosen on its own could
     * be too short for the cover and the column together, and the cover would
     * be drawn past the bottom of the desklet. An unmeasured column is zero
     * tall, which costs nothing: the very first pass is corrected by the
     * allocation that comes back from it. */
    let room;

    if (horizontal) {
        room = size.infoHeight > 0
            ? Math.min(size.height, size.infoHeight)
            : size.height;
    } else {
        room = Math.min(size.width, size.height - size.spacing - size.infoHeight);
    }

    /* The width always has the last word, in either layout. A cover is never
     * wider than the widget it is in, so the box around it cannot be either,
     * and this is the one place that says so rather than leaving it to which of
     * the two cases above happened to run. */
    room = Math.min(room, size.width);

    const available = room - size.padding * 2;
    let artworkSize = Math.round(clamp(available, MIN_ARTWORK_SIZE, size.artworkMax));
    let artworkBoxWidth = artworkSize + size.padding * 2;

    /* The padding around the cover is added to the cover to get the box, so a
     * padding wider than the widget would make the box wider than the widget:
     * at a 150px widget with 200px of padding the box works out at 432px,
     * which is a child wider than its parent and is exactly the shape of thing
     * that used to grow the desklet without end.
     *
     * So the box is bounded by the width rather than merely by the cover, and
     * the cover is taken back out of it. The cover is never sacrificed for
     * that: its minimum is a floor on legibility, and the padding is only ever
     * something the stylesheet happens to put there, so when the two cannot
     * both fit the cover keeps the room and the padding gives way. */
    if (artworkBoxWidth > size.width) {
        artworkBoxWidth = Math.max(0, size.width);
        artworkSize = Math.max(MIN_ARTWORK_SIZE, artworkBoxWidth - size.padding * 2);
    }

    /* The part of the column the desklet is actually for: the title, the seek
     * bar and the transport controls.
     *
     * The compact layout has already given up both optional rows, so for it
     * this is the whole column: the rows it dropped are not in @infoHeight any
     * more, and subtracting their heights again would reserve a third of the
     * frame for rows that are not being drawn. That is how a 150x100 desklet
     * ended up drawing a 32px cover above a column it then clipped at 40px,
     * with the transport controls cut off by the bottom of the frame. */
    const minimumColumn = mode === LayoutMode.COMPACT
        ? Math.max(0, size.infoHeight)
        : Math.max(0, size.infoHeight - size.artistHeight - size.timesHeight);

    /* In the stacked layout the cover and the column share the height, and a
     * frame too short for both has to give something up. It gives up the cover.
     *
     * The cover is bounded by what is left once the column is guaranteed its
     * essential share, and is not drawn at all when there is no room for a
     * legible one.
     *
     * There is a second reason to drop it, and it is the one that bites on a
     * small frame: a cover small enough to fit is not the same as a column big
     * enough to fit beside it. At 150x100 the essential column needs 32px of
     * rows, the gap takes 6 more, and the frame has 80 to share, so a 32px cover
     * does fit, and it leaves the column 42px for 38px of rows plus its own
     * gaps. The cover was drawn, the column was clipped, and the transport
     * controls were cut off at the bottom of the frame.
     *
     * So the cover also goes when keeping it would leave the column less than it
     * needs. The column is what the desklet exists to show and the cover is a
     * decoration, and this is the one trade the layout is allowed to make. */
    let showArtwork = true;

    if (!horizontal && minimumColumn > 0) {
        const coverRoom = size.height - size.spacing - minimumColumn;
        /* The room the column would be left with if the cover were drawn. */
        const columnRoom = size.height - size.spacing - artworkBoxWidth;

        if (coverRoom < MIN_ARTWORK_SIZE + size.padding * 2 || columnRoom < minimumColumn) {
            showArtwork = false;
            artworkSize = 0;
            artworkBoxWidth = 0;
        } else if (artworkBoxWidth > coverRoom) {
            artworkBoxWidth = coverRoom;
            artworkSize = Math.max(0, artworkBoxWidth - size.padding * 2);
        }
    }

    /* How wide the information column is allowed to ask to be.
     *
     * This is deliberately taken from the width the desklet will not go below
     * rather than from the width it was just given. A width that depends on the
     * measurement is a width that feeds back into it: the column asks for that
     * much, the desklet grows to fit, the next pass measures a little more, and
     * a desklet with a long title in it grows without end. A width that is
     * already a floor cannot grow anything, so the desklet stays at the size it
     * was always going to be, and the column simply takes whatever room the
     * layout really has. */
    /* A floor cannot be larger than the widget itself, so a theme minimum wider
     * than the configured size narrows the column rather than widening the
     * widget past what was asked for. This is a minimum on a width, so it can
     * only make the column ask for less, never more. */
    const ceiling = Math.min(size.minWidth > 0 ? size.minWidth : size.width, size.width);

    /* The height the information column may occupy, which is what is left of
     * the frame once the cover and the gap have taken their share.
     *
     * In the side by side layout the column spans the full height, because
     * there is nothing stacked above or below it. In the stacked layout it gets
     * what is left, and the cover above has already been bounded so that what
     * is left is at least the column's essential part. */
    const columnMaxHeight = Math.max(0, horizontal
        ? size.height
        : size.height - size.spacing - artworkBoxWidth);

    /* Which of the column's optional rows there is room for.
     *
     * The column is a vertical stack: the title, the artist, the seek bar with
     * its time labels, and the transport buttons. Only the first and the last
     * are worth insisting on, so when the stack does not fit the optional rows
     * are dropped until it does. What is left is a column that fits, rather
     * than one drawn past the bottom of the frame and over whatever happens to
     * be behind the desklet.
     *
     * The taller row goes first, because dropping it buys the most room and the
     * shorter one is the better of the two to keep. Dropping them in a fixed
     * order instead would keep the taller one whenever it happened to fit
     * alongside the other, which is how a column ends up holding 86px of rows
     * in 80px of space.
     *
     * The controls are never on this list. They are the one part of the column
     * the desklet is for, so a frame too small for everything keeps them and
     * loses the labels. */
    let showTimes = mode !== LayoutMode.COMPACT;
    let showArtist = mode !== LayoutMode.COMPACT;
    /* The compact layout has already given up both optional rows, so what it
     * still needs is the essential part. Everywhere else the column starts at
     * its natural height and is given up row by row until it fits. */
    let needed = mode === LayoutMode.COMPACT
        ? minimumColumn
        : size.infoHeight;

    if (needed > columnMaxHeight) {
        const drops = size.timesHeight >= size.artistHeight
            ? [
                () => { showTimes = false; return size.timesHeight; },
                () => { showArtist = false; return size.artistHeight; },
            ]
            : [
                () => { showArtist = false; return size.artistHeight; },
                () => { showTimes = false; return size.timesHeight; },
            ];

        for (const drop of drops) {
            if (needed <= columnMaxHeight)
                break;

            needed -= drop();
        }
    }

    return {
        mode,
        vertical: !horizontal,
        artworkSize,
        artworkBoxWidth,
        /* False when the frame is too short to hold a legible cover beside the
         * information, in which case artworkSize and artworkBoxWidth are both
         * zero and the caller should not draw one. */
        showArtwork,
        infoMaxWidth: Math.round(clamp(horizontal
            ? ceiling - artworkBoxWidth - size.spacing
            : ceiling, 0, MAX_CONTENT_WIDTH)),
        /* The height ceiling, not just the width one, is what stops a stack of
         * children from hanging out of the bottom of the frame: the column
         * cannot ask to be taller than the room that is actually inside the
         * desklet. */
        columnMaxHeight: Math.round(columnMaxHeight),
        showArtist,
        showTimes,
        /* The box every child is fitted into, handed back so the caller sizes
         * the frame's contents from the same numbers the children were sized
         * from rather than measuring it a second time. */
        contentWidth: Math.round(size.width),
        contentHeight: Math.round(size.height),
    };
}

/**
 * clampMeasurement
 * @value (number): a measured size in pixels.
 *
 * The size the layout is worked out from. A measurement past MAX_CONTENT_WIDTH
 * is not a desklet, it is a widget that has already gone wrong, and the layout
 * must not be derived from it: the sizes it produces would be the very thing
 * that keeps the widget growing.
 */
function clampMeasurement(value) {
    return Math.min(Math.max(0, Number(value) || 0), MAX_CONTENT_WIDTH);
}

/**
 * timelineGeometry
 * @fraction (0..1), @trackWidth (number), @handleWidth (number)
 *
 * Where the progress fill and the drag handle go for one playback position.
 *
 * The track lays its children out from the left, so the handle is positioned
 * after the fill and then shifted back into place. Returning the shift rather
 * than a raw position keeps the caller from having to know that.
 *
 * Returns: { fillWidth, handleX, handleShift, travel }
 */
function timelineGeometry(fraction, trackWidth, handleWidth) {
    const track = Math.max(0, trackWidth);
    const handle = Math.max(0, handleWidth);
    const position = clamp(fraction, 0, 1);

    /* The handle never leaves the track, so it travels the track minus its own
     * width. */
    const travel = Math.max(0, track - handle);
    const fillWidth = Math.round(position * track);
    const handleX = Math.round(position * travel);

    return {
        fillWidth,
        handleX,
        /* The track lays its children out from the left, so the handle starts
         * out behind the fill at fillWidth and has to be moved forward by
         * however much of that is too much. */
        handleShift: handleX - fillWidth,
        travel,
    };
}

/**
 * seekFraction
 * @pointerX, @trackX, @trackWidth (numbers)
 *
 * Maps a pointer position onto the timeline. The result is clamped, so a click
 * past either end seeks to the start or to the end of the track rather than
 * to a position outside it.
 */
function seekFraction(pointerX, trackX, trackWidth) {
    if (!(trackWidth > 0))
        return 0;

    return clamp((pointerX - trackX) / trackWidth, 0, 1);
}

/* ------------------------------------------------------------------ Position
 *
 * MPRIS does not push the playback position. Position is a plain cached
 * property, and the specification says players are not even required to refresh
 * it while playing, so the desklet re-reads it from the bus on a timer and
 * advances the displayed value on the wall clock in between.
 *
 * Everything that decides which of those two numbers is shown lives here, as
 * arithmetic over plain numbers, because the bugs that used to be here were all
 * of one kind: a number from the player was allowed to replace a number the
 * desklet already knew was better.
 */

/* How far the player may land from a position a seek asked for before the seek
 * counts as confirmed. Generous, because a player is free to round where it
 * seeks to, and because a player that clamps to the end of a track it will not
 * report the length of would otherwise never confirm at all. */
const POSITION_AGREE_TOLERANCE_US = 2000000;

/**
 * extrapolatePosition
 * @anchorUs, @anchorMs, @nowMs, @playing, @lengthUs (numbers)
 *
 * The position the desklet shows at @nowMs.
 *
 * The clock only runs while the track is playing. A paused player does not
 * advance, so advancing the display for it would walk the elapsed time and the
 * seek bar away from a position that is, by definition, not moving: the bar
 * would creep onwards after every pause. Held at the anchor, the paused
 * position stays exactly where the player left it.
 *
 * Clamped to the track length, so a player that reports no length, or a
 * slightly optimistic one, cannot run the counter past the end. */
function extrapolatePosition(anchorUs, anchorMs, nowMs, playing, lengthUs) {
    const anchor = Number.isFinite(anchorUs) && anchorUs > 0 ? anchorUs : 0;
    const elapsedUs = playing ? Math.max(0, (nowMs - anchorMs) * 1000) : 0;
    const position = anchor + elapsedUs;
    const limit = Number.isFinite(lengthUs) && lengthUs > 0 ? lengthUs : 0;

    return limit > 0 ? Math.max(0, Math.min(position, limit)) : Math.max(0, position);
}

/**
 * positionAgrees
 * @targetUs, @reportedUs (numbers)
 *
 * True when a read from the player lands close enough to a position the desklet
 * asked for to count as the player having got there. Used to retire a pending
 * seek: until the player confirms, a position from it is not allowed to move
 * the display, and this is the test that ends that wait.
 *
 * Both ends of the track are treated as already reached, because a player that
 * has clamped to the end of a track it will not report the length of would
 * otherwise leave the display stuck waiting for a value that never arrives. */
function positionAgrees(targetUs, reportedUs) {
    if (!Number.isFinite(targetUs) || targetUs < 0)
        return true;

    if (!Number.isFinite(reportedUs) || reportedUs < 0)
        return false;

    if (targetUs === 0)
        return reportedUs <= POSITION_AGREE_TOLERANCE_US;

    return Math.abs(reportedUs - targetUs) <= POSITION_AGREE_TOLERANCE_US;
}

/**
 * marqueeSegments
 * @overflow (number): how many pixels wider the title is than its viewport.
 *
 * The scroll cycle for a title that does not fit: hold still, slide out, hold
 * at the end, slide back. An empty list means the title fits and must stay
 * exactly where it is.
 */
function marqueeSegments(overflow) {
    const distance = Math.ceil(overflow);

    if (distance < MARQUEE_MIN_OVERFLOW)
        return [];

    const slide = clamp(Math.round(distance / MARQUEE_PIXELS_PER_SECOND * 1000),
        MARQUEE_MIN_DURATION_MS, MARQUEE_MAX_DURATION_MS);

    return [
        { kind: MarqueeSegmentKind.HOLD, offset: 0, durationMs: MARQUEE_DWELL_MS },
        { kind: MarqueeSegmentKind.SLIDE, offset: -distance, durationMs: slide },
        { kind: MarqueeSegmentKind.HOLD, offset: -distance, durationMs: MARQUEE_DWELL_MS },
        { kind: MarqueeSegmentKind.SLIDE, offset: 0, durationMs: slide },
    ];
}

/**
 * titleOverflow
 * @textWidth (number): the rendered width of the whole title, in pixels.
 * @viewportWidth (number): the width available to draw it in, in pixels.
 *
 * How many pixels wider the title is than the space it has to be drawn in, and
 * so whether it has to be scrolled at all.
 *
 * This is the whole test for whether the marquee runs, and it is on the
 * rendered width of the title rather than on how many characters it has. A few
 * wide letters can be wider than many narrow ones, so counting characters sends
 * one of them scrolling for no reason and holds the other still when it has to
 * move.
 *
 * A title that fits, or that has no width to be measured in, has no overflow
 * and is drawn as one piece of text with no animation of any kind.
 */
function titleOverflow(textWidth, viewportWidth) {
    if (!Number.isFinite(viewportWidth) || viewportWidth <= 0)
        return 0;

    const rendered = Number.isFinite(textWidth) ? Math.max(0, textWidth) : 0;

    /* Not rounded, and that matters in both directions.
     *
     * Rounded to nothing, a title a fraction of a pixel too wide for the window
     * would count as fitting, be drawn as one static label, and paint that
     * fraction past the edge of the window: the scroll exists to keep a long
     * title inside the window, and rounding would switch it off for exactly the
     * titles closest to the edge. Rounded up, a title a fraction of a pixel too
     * wide would be scrolled, which is a whole animation for something no one
     * can see. The difference is the answer either way. */
    return Math.max(0, rendered - viewportWidth);
}

/**
 * titleVisibleRange
 * @length (number): how many characters the whole title has.
 * @charBox (function): where one character sits, as {x, width} in pixels, or
 *   null if it cannot be placed.
 * @from (number): where in the text, in pixels, the left edge of the window is.
 *   This is a position in the text and may be negative or fractional.
 * @width (number): how many pixels wide the window is.
 *
 * The run of characters that lies wholly inside a window of a given width placed
 * at a given position in the text.
 *
 * This is the containment rule the scrolling title is built on: a character is
 * shown only when all of it is inside the window, so whatever is on screen has
 * been measured against the window and cannot reach past its edge. Nothing
 * relies on a clip, which does not work here: a label moved left of its window
 * is painted wherever its position says, so a title scrolled by moving the
 * label was drawn out over the desktop.
 *
 * `from` is a position rather than a distance, so it may be negative, which is
 * what a second copy of the title entering from the right is measured against,
 * and it is deliberately not rounded, so a caller can move the window a
 * fraction of a pixel at a time and have the answer move with it.
 *
 * The range can come back empty, and that is the correct answer rather than an
 * error: a window past the end of the text, or one waiting for a second copy
 * to arrive, has nothing in it, and the gap between the two is the point.
 */
function titleVisibleRange(length, charBox, from, width) {
    if (!Number.isFinite(length) || length <= 0)
        return { start: 0, end: 0 };

    /* Nowhere to show it, or nothing to measure it with: nothing can be inside
     * a window that has no width, so nothing is shown. */
    if (typeof charBox !== 'function' || !Number.isFinite(width) || width <= 0)
        return { start: 0, end: 0 };

    const box = index => {
        const rect = charBox(index);

        if (!rect)
            return null;

        const x = Number(rect.x);
        const size = Number(rect.width);

        if (!Number.isFinite(x) || !Number.isFinite(size))
            return null;

        return { x, width: Math.max(0, size) };
    };

    const left = Number.isFinite(from) ? from : 0;
    const right = left + width;
    let start = 0;

    /* Wholly inside means the character starts at or after the left edge, not
     * merely that it reaches into it: one that starts before the edge is
     * painted before it. */
    while (start < length) {
        const current = box(start);

        if (current && current.x >= left)
            break;

        start++;
    }

    let end = start;

    while (end < length) {
        const current = box(end);

        if (!current || current.x + current.width > right)
            break;

        end++;
    }

    return { start, end };
}

/**
 * formatTime
 * @microseconds (number)
 *
 * Formats a duration or a position as m:ss, or h:mm:ss for long tracks.
 */
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

var layout = {
    LayoutMode,
    MarqueeSegmentKind,
    COMPACT_MIN_WIDTH,
    COMPACT_MIN_HEIGHT,
    HORIZONTAL_MIN_WIDTH,
    HORIZONTAL_MIN_ASPECT,
    MIN_ARTWORK_SIZE,
    COMPACT_ARTWORK_MAX_SIZE,
    MARQUEE_DWELL_MS,
    MARQUEE_MIN_OVERFLOW,
    MARQUEE_PIXELS_PER_SECOND,
    POSITION_AGREE_TOLERANCE_US,
    MAX_CONTENT_WIDTH,
    MIN_WIDGET_WIDTH,
    MAX_WIDGET_WIDTH,
    MIN_WIDGET_HEIGHT,
    MAX_WIDGET_HEIGHT,
    DEFAULT_PRESET,
    DEFAULT_SIZE,
    CUSTOM_PRESET,
    SIZE_PRESETS,
    clamp,
    clampMeasurement,
    presetSize,
    clampWidgetSize,
    resolveWidgetSize,
    resolveLayout,
    timelineGeometry,
    seekFraction,
    extrapolatePosition,
    positionAgrees,
    marqueeSegments,
    titleOverflow,
    titleVisibleRange,
    formatTime,
};
