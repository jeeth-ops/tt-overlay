// 📷 Scorecard photos → structured figures, read by Claude (vision).
//
// Used by the scorecard import (scorecard-import.js). Turns photos or
// screenshots of a printed / app scorecard (CricHeroes and similar) into
// plain JSON: both innings' batting and bowling tables, extras, totals, fall
// of wickets, the result line — and, separately, ball-by-ball commentary.
// Nothing here writes to the database; the import shows every value for
// review and correction before anything is saved.
//
// Needs ANTHROPIC_API_KEY (the same key the support chat uses). Without it
// the import still works: figures are typed in, or read in the browser with
// Tesseract.js (see scorecard-import.html).
'use strict';

const MODEL = 'claude-opus-5-5';
// A refusal is very unlikely on a scorecard, but if a safety classifier ever
// declines, the API re-runs the request on Anthropic's recommended model
// instead of returning nothing.
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

const nullable = (schema) => ({ anyOf: [schema, { type: 'null' }] });
const INT = nullable({ type: 'integer' });
const NUM = nullable({ type: 'number' });
const STR = nullable({ type: 'string' });
const CONF = { type: 'string', enum: ['high', 'medium', 'low'] };
const obj = (properties) => ({ type: 'object', additionalProperties: false, required: Object.keys(properties), properties });

// What Claude returns for the scorecard photos. Every figure is nullable:
// null means "not printed / not readable", never zero.
const SCORECARD_SCHEMA = obj({
    match: obj({
        teamNames: { type: 'array', items: { type: 'string' } },
        resultText: STR,
        tossText: STR,
        venue: STR,
        date: STR,
        format: STR,
        oversPerInnings: INT
    }),
    innings: {
        type: 'array',
        items: obj({
            inningsNumber: { type: 'integer' },
            battingTeam: STR,
            batting: {
                type: 'array',
                items: obj({
                    name: { type: 'string' },
                    dismissal: STR,
                    runs: INT,
                    balls: INT,
                    fours: INT,
                    sixes: INT,
                    strikeRate: NUM,
                    isCaptain: { type: 'boolean' },
                    isWicketKeeper: { type: 'boolean' },
                    photo: INT,
                    confidence: CONF,
                    unclear: { type: 'array', items: { type: 'string' } }
                })
            },
            didNotBat: { type: 'array', items: { type: 'string' } },
            bowling: {
                type: 'array',
                items: obj({
                    name: { type: 'string' },
                    overs: STR,
                    maidens: INT,
                    runs: INT,
                    wickets: INT,
                    wides: INT,
                    noBalls: INT,
                    dots: INT,
                    economy: NUM,
                    photo: INT,
                    confidence: CONF,
                    unclear: { type: 'array', items: { type: 'string' } }
                })
            },
            extras: obj({ total: INT, wides: INT, noBalls: INT, byes: INT, legByes: INT, penalty: INT }),
            total: obj({ runs: INT, wickets: INT, overs: STR, declared: { type: 'boolean' }, allOut: { type: 'boolean' } }),
            fallOfWickets: {
                type: 'array',
                items: obj({ wicket: INT, runs: INT, overs: STR, batter: STR })
            },
            sourcePhotos: { type: 'array', items: { type: 'integer' } }
        })
    },
    notes: { type: 'array', items: { type: 'string' } }
});

// Ball-by-ball commentary photos.
const COMMENTARY_SCHEMA = obj({
    entries: {
        type: 'array',
        items: obj({
            label: { type: 'string' },
            marker: STR,
            bowler: STR,
            batter: STR,
            text: STR,
            photo: INT,
            confidence: CONF
        })
    },
    overSummaries: {
        type: 'array',
        items: obj({ over: INT, runs: INT, scoreText: STR, photo: INT })
    },
    notes: { type: 'array', items: { type: 'string' } }
});

const SCORECARD_SYSTEM = `You transcribe photos and screenshots of a cricket scorecard (usually from the CricHeroes app) into JSON for a scoring database. The JSON becomes a real match record that players' statistics are built from, so a wrong number is worse than a missing one.

- Transcribe only what is printed. When a value is not shown, cut off or unreadable, use null and name the field in "unclear". Never estimate, compute or infer a figure that is not printed — the person reviewing will fill it in.
- Copy player and team names exactly as printed. Remove role markers such as (c), (wk), †, * from the name and report them with isCaptain / isWicketKeeper.
- Copy each batter's dismissal line exactly as printed ("c Rohit Shukla b Garv Jain", "not out", "run out (Jai Chougule)", "lbw b Garv Jain", "retired hurt"). Use null when a batter who batted has no dismissal line in the photo.
- A table often continues over several photos, and consecutive screenshots overlap: list every batter and bowler once, in printed order. In "photo", give the number of the photo the row was read from.
- Write overs exactly as printed: "19.4" is 19 overs and 4 balls.
- Innings are numbered in match order: innings 1 is the team that batted first. Use the photos' headings ("1st innings", team name with total) to decide. The person's note on each photo says which innings they think it shows; follow the photo when the two disagree, and say so in "notes".
- "didNotBat" lists the names under "Yet to bat" / "Did not bat".
- Fall of wickets only when the photo prints it.
- Put anything you could not place, and any doubt worth a human check, in "notes".`;

const COMMENTARY_SYSTEM = `You transcribe photos and screenshots of ball-by-ball cricket commentary (usually from the CricHeroes app) into JSON. It is shown on a public match page next to the official scorecard.

- One entry per delivery, in match order (first ball of the innings first, even when the app lists the newest ball at the top). Consecutive screenshots overlap: list each delivery once.
- "label" is the over.ball number exactly as printed ("19.6"). "marker" is what the ball's circle or badge shows, as printed: "0" or "•" for a dot ball, "1", "2", "4", "6", "W", "1wd", "wd", "nb", "1nb", "lb", "2lb", "b", "4b"… Use null when there is no marker.
- "bowler" and "batter" come from the "Bowler to Batter" line, spelled exactly as printed. "text" is the commentary sentence as printed, without the over number and names when those are already in their own fields.
- Over summaries ("End of over 12: 9 runs, TEAM 86/2") go in "overSummaries".
- Never invent a delivery or a figure that is not printed. If part of an over is missing from the photos, leave it out and say so in "notes".`;

function labelFor(photo, i) {
    const bits = [`Photo ${i + 1}`];
    if (photo.innings) bits.push(`the person marked it as ${photo.innings === 1 ? '1st' : photo.innings === 2 ? '2nd' : photo.innings + 'th'} innings`);
    if (photo.note) bits.push(String(photo.note).slice(0, 120));
    return bits.join(' — ');
}

// photos: [{ mediaType, data (base64, no data: prefix), innings?, note? }]
function scorecardContent(photos, hints) {
    const content = [];
    photos.forEach((p, i) => {
        content.push({ type: 'text', text: labelFor(p, i) });
        content.push({ type: 'image', source: { type: 'base64', media_type: p.mediaType, data: p.data } });
    });
    const h = hints || {};
    const lines = ['Transcribe this match scorecard.'];
    if (h.teamA || h.teamB) lines.push(`The two teams, as the person entered them: "${h.teamA || '?'}" and "${h.teamB || '?'}". Keep the spelling printed in the photos.`);
    if (h.format) lines.push(`Match format, as the person entered it: ${h.format}${h.overs ? ` (${h.overs} overs per innings)` : ''}.`);
    content.push({ type: 'text', text: lines.join('\n') });
    return content;
}

function commentaryContent(photos, hints) {
    const content = [];
    photos.forEach((p, i) => {
        content.push({ type: 'text', text: `Photo ${i + 1}` });
        content.push({ type: 'image', source: { type: 'base64', media_type: p.mediaType, data: p.data } });
    });
    const h = hints || {};
    content.push({ type: 'text', text: `Transcribe the ball-by-ball commentary of ${h.battingTeam ? `"${h.battingTeam}"'s innings` : 'this innings'}${h.innings ? ` (innings ${h.innings})` : ''}.` });
    return content;
}

class ExtractError extends Error {
    constructor(message, code, retryable) {
        super(message);
        this.code = code;
        this.retryable = !!retryable;
    }
}

function loadSdk() {
    // Loaded on first use, so the server (and its tests) start without it.
    const mod = require('@anthropic-ai/sdk');
    return mod.default || mod;
}

// One structured-output request. Streams (long outputs, many images) and
// returns the parsed JSON plus usage.
async function callClaude(opts) {
    const Anthropic = opts.Anthropic || loadSdk();
    const client = opts.client || new Anthropic(Object.assign({ apiKey: opts.apiKey }, opts.baseURL ? { baseURL: opts.baseURL } : {}, { maxRetries: 2, timeout: 9 * 60 * 1000 }));
    let message;
    try {
        const stream = client.beta.messages.stream({
            model: MODEL,
            max_tokens: opts.maxTokens || 32000,
            betas: [FALLBACK_BETA],
            fallbacks: 'default',
            output_config: { effort: 'high', format: { type: 'json_schema', schema: opts.schema } },
            system: opts.system,
            messages: [{ role: 'user', content: opts.content }]
        });
        message = await stream.finalMessage();
    } catch (err) {
        if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
            throw new ExtractError('The ANTHROPIC_API_KEY on the server was refused — check it in the server settings.', 'AUTH', false);
        }
        if (err instanceof Anthropic.RateLimitError) throw new ExtractError('Photo reading is busy right now — try again in a minute.', 'RATE_LIMIT', true);
        if (err instanceof Anthropic.BadRequestError) throw new ExtractError(`The photos could not be read (${String(err.message || '').slice(0, 160)}).`, 'BAD_REQUEST', false);
        if (err instanceof Anthropic.APIConnectionError) throw new ExtractError('Could not reach the photo-reading service — try again.', 'CONNECTION', true);
        if (err instanceof Anthropic.APIError) throw new ExtractError(`Photo reading failed (${err.status || 'error'}) — try again.`, 'API', true);
        throw err;
    }
    if (message.stop_reason === 'refusal') throw new ExtractError('The photo-reading service declined these photos. Enter the figures by hand.', 'REFUSAL', false);
    if (message.stop_reason === 'max_tokens') throw new ExtractError('Too many photos in one go — split them and read again.', 'TOO_LONG', false);
    const text = (message.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
    let data;
    try { data = JSON.parse(text); } catch (e) { throw new ExtractError('The photo-reading service returned something unreadable — try again.', 'BAD_JSON', true); }
    return { data, usage: message.usage || null, model: message.model || MODEL, stopReason: message.stop_reason };
}

async function extractScorecard(photos, hints, opts) {
    if (!photos || !photos.length) throw new ExtractError('No photos to read.', 'NO_PHOTOS', false);
    return callClaude(Object.assign({}, opts, { schema: SCORECARD_SCHEMA, system: SCORECARD_SYSTEM, content: scorecardContent(photos, hints), maxTokens: 32000 }));
}

async function extractCommentary(photos, hints, opts) {
    if (!photos || !photos.length) throw new ExtractError('No photos to read.', 'NO_PHOTOS', false);
    return callClaude(Object.assign({}, opts, { schema: COMMENTARY_SCHEMA, system: COMMENTARY_SYSTEM, content: commentaryContent(photos, hints), maxTokens: 64000 }));
}

module.exports = {
    MODEL, FALLBACK_BETA, SCORECARD_SCHEMA, COMMENTARY_SCHEMA, SCORECARD_SYSTEM, COMMENTARY_SYSTEM,
    ExtractError, extractScorecard, extractCommentary, scorecardContent, commentaryContent
};
