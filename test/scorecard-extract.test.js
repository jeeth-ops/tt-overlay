// 📷 Scorecard photos → figures, read by Claude (scorecard-extract.js), with
// the REAL @anthropic-ai/sdk talking to a stand-in for the Messages API
// (test/fake-anthropic.js) — so the request the server builds and the SDK's
// streaming / retry / error paths run for real, offline.
//
//   the request: model, the server-side fallback beta, effort, structured
//     output schema, streaming, every photo labelled with its innings
//   the answer: streamed JSON parsed; usage kept
//   commentary: its own schema and a larger output budget
//   failures in plain words: key refused, bad request, busy (retried),
//     server error (retried, then reported), refusal, too long, bad JSON
//   the schemas: strict (every key required, nothing extra), every figure nullable
//
// Run:  node test/scorecard-extract.test.js
const X = require('../scorecard-extract.js');
const { startFakeAnthropic } = require('./fake-anthropic.js');
const FX = require('./scorecard-import-fixtures.js');

const fails = [];
let passes = 0;
const check = (ok, msg) => { if (ok) passes++; else fails.push(msg); console.log(`  ${ok ? '✓' : '✗'} ${msg}`); };
const section = (t) => console.log('\n' + t);

const photos = [
    { mediaType: 'image/png', data: FX.png(1).toString('base64'), innings: 1 },
    { mediaType: 'image/jpeg', data: FX.png(2).toString('base64'), innings: 1 },
    { mediaType: 'image/png', data: FX.png(3).toString('base64'), innings: 2 }
];
async function errOf(p) { try { await p; return null; } catch (e) { return e; } }

(async () => {
    section('the request and the answer');
    let fake = await startFakeAnthropic(() => ({ json: FX.scorecard() }));
    const opts = { apiKey: 'sk-test', baseURL: fake.url };
    let r = await X.extractScorecard(photos, { teamA: 'DY PATIL SA', teamB: null, format: 'Custom', overs: 10 }, opts);
    const req = fake.requests[0];
    check(fake.requests.length === 1 && req.method === 'POST' && /^\/v1\/messages/.test(req.url), 'one call to the Messages API');
    check(req.headers['x-api-key'] === 'sk-test', 'the server\'s key is sent');
    check(String(req.headers['anthropic-beta'] || '').includes(X.FALLBACK_BETA) && req.body.fallbacks === 'default', 'server-side fallback switched on');
    check(req.body.model === 'claude-opus-5-5' && req.body.model === X.MODEL, 'model: claude-opus-5-5');
    check(req.body.stream === true && req.body.max_tokens === 32000, 'streamed, with room for two full innings');
    check(req.body.output_config && req.body.output_config.effort === 'high' && req.body.output_config.format.type === 'json_schema' && JSON.stringify(req.body.output_config.format.schema) === JSON.stringify(X.SCORECARD_SCHEMA), 'high effort, answer held to the scorecard schema');
    check(req.body.system === X.SCORECARD_SYSTEM && /never estimate/i.test(req.body.system) && /null/.test(req.body.system), 'the instructions: transcribe only what is printed, null when not readable');
    const content = req.body.messages[0].content;
    const images = content.filter(b => b.type === 'image');
    check(images.length === 3 && images[0].source.type === 'base64' && images[0].source.media_type === 'image/png' && images[1].source.media_type === 'image/jpeg' && images[2].source.data === photos[2].data, 'every photo sent, as it is');
    check(content[0].type === 'text' && /Photo 1/.test(content[0].text) && /1st innings/.test(content[0].text) && content[4].type === 'text' && /Photo 3/.test(content[4].text) && /2nd innings/.test(content[4].text), 'each photo labelled with the innings the person gave it');
    const last = content[content.length - 1].text;
    check(/DY PATIL SA/.test(last) && /\?/.test(last) && /Custom/.test(last) && /10 overs/.test(last), 'the person\'s team and format as hints');
    check(r.data.innings.length === 2 && r.data.innings[0].batting[0].name === 'Jeeth Kumar Suvarna (c)' && r.data.notes.length === 1, 'the streamed JSON comes back parsed');
    check(r.usage && r.usage.input_tokens === 1200 && r.model === 'claude-opus-5-5' && r.stopReason === 'end_turn', 'usage and model kept');
    await fake.close();

    fake = await startFakeAnthropic(() => ({ json: FX.commentary() }));
    r = await X.extractCommentary(photos.slice(0, 2), { innings: 1, battingTeam: 'DY PATIL SA' }, { apiKey: 'k', baseURL: fake.url });
    const cr = fake.requests[0].body;
    check(cr.max_tokens === 64000 && JSON.stringify(cr.output_config.format.schema) === JSON.stringify(X.COMMENTARY_SCHEMA) && cr.system === X.COMMENTARY_SYSTEM, 'commentary: its own schema and instructions, a larger budget');
    check(/DY PATIL SA/.test(cr.messages[0].content.slice(-1)[0].text) && /innings 1/.test(cr.messages[0].content.slice(-1)[0].text), 'commentary: told whose innings it is');
    check(r.data.entries.length === 5, 'commentary entries come back');
    await fake.close();

    section('failures, in plain words');
    let e = await errOf(X.extractScorecard([], {}, { apiKey: 'k' }));
    check(e && e.code === 'NO_PHOTOS', 'no photos: nothing is sent');
    fake = await startFakeAnthropic(() => ({ status: 401, error: 'invalid x-api-key' }));
    e = await errOf(X.extractScorecard(photos, {}, { apiKey: 'bad', baseURL: fake.url }));
    check(e instanceof X.ExtractError && e.code === 'AUTH' && !e.retryable && /ANTHROPIC_API_KEY/.test(e.message) && fake.requests.length === 1, 'a refused key: says to check ANTHROPIC_API_KEY, not retried');
    await fake.close();
    fake = await startFakeAnthropic(() => ({ status: 400, error: 'image too large' }));
    e = await errOf(X.extractScorecard(photos, {}, { apiKey: 'k', baseURL: fake.url }));
    check(e && e.code === 'BAD_REQUEST' && /could not be read/.test(e.message), 'a bad request: "the photos could not be read"');
    await fake.close();
    fake = await startFakeAnthropic((body, req, n) => (n === 1 ? { status: 429, error: 'rate limited' } : { json: FX.scorecard() }));
    r = await X.extractScorecard(photos, {}, { apiKey: 'k', baseURL: fake.url });
    check(fake.requests.length === 2 && r.data.innings.length === 2, 'busy (429): retried, then read');
    await fake.close();
    fake = await startFakeAnthropic(() => ({ status: 429, error: 'rate limited' }));
    e = await errOf(X.extractScorecard(photos, {}, { apiKey: 'k', baseURL: fake.url }));
    check(e && e.code === 'RATE_LIMIT' && e.retryable && fake.requests.length === 3, 'still busy after the retries: "try again in a minute"');
    await fake.close();
    fake = await startFakeAnthropic(() => ({ status: 500, error: 'boom' }));
    e = await errOf(X.extractScorecard(photos, {}, { apiKey: 'k', baseURL: fake.url }));
    check(e && e.code === 'API' && e.retryable && fake.requests.length === 3, 'a server error: retried twice, then reported');
    await fake.close();
    fake = await startFakeAnthropic(() => ({ json: {}, stopReason: 'refusal' }));
    e = await errOf(X.extractScorecard(photos, {}, { apiKey: 'k', baseURL: fake.url }));
    check(e && e.code === 'REFUSAL' && /by hand/.test(e.message), 'declined: "enter the figures by hand"');
    await fake.close();
    fake = await startFakeAnthropic(() => ({ text: '{"innings": [', stopReason: 'max_tokens' }));
    e = await errOf(X.extractScorecard(photos, {}, { apiKey: 'k', baseURL: fake.url }));
    check(e && e.code === 'TOO_LONG' && /split them/.test(e.message), 'cut off: "split the photos and read again"');
    await fake.close();
    fake = await startFakeAnthropic(() => ({ text: 'not json at all' }));
    e = await errOf(X.extractScorecard(photos, {}, { apiKey: 'k', baseURL: fake.url }));
    check(e && e.code === 'BAD_JSON' && e.retryable, 'an unreadable answer: "try again"');
    await fake.close();
    e = await errOf(X.extractScorecard(photos, {}, { apiKey: 'k', baseURL: 'http://127.0.0.1:1' }));
    check(e && e.code === 'CONNECTION', 'the service unreachable: "could not reach"');

    section('the schemas');
    const strict = (s, path) => {
        const bad = [];
        const walk = (n, p) => {
            if (!n || typeof n !== 'object') return;
            if (n.type === 'object') {
                if (n.additionalProperties !== false) bad.push(p + ': extra keys allowed');
                const keys = Object.keys(n.properties || {});
                if (JSON.stringify((n.required || []).slice().sort()) !== JSON.stringify(keys.slice().sort())) bad.push(p + ': not every key required');
                keys.forEach(k => walk(n.properties[k], p + '.' + k));
            }
            if (n.type === 'array') walk(n.items, p + '[]');
            (n.anyOf || []).forEach(x => walk(x, p));
        };
        walk(s, path);
        return bad;
    };
    check(!strict(X.SCORECARD_SCHEMA, 'scorecard').length && !strict(X.COMMENTARY_SCHEMA, 'commentary').length, 'strict: every key required, nothing extra');
    const bat = X.SCORECARD_SCHEMA.properties.innings.items.properties.batting.items.properties;
    const nullable = (p) => (p.anyOf || []).some(x => x.type === 'null');
    check(['runs', 'balls', 'fours', 'sixes', 'strikeRate', 'dismissal'].every(k => nullable(bat[k])), 'every printed figure may be null ("not readable" is never 0)');
    check(bat.confidence.enum.join() === 'high,medium,low' && bat.unclear.type === 'array', 'each row says how sure the reading is, and which values were unclear');

    console.log(`\n${passes} passed, ${fails.length} failed`);
    if (fails.length) { console.log('\nFAILED:\n - ' + fails.join('\n - ')); process.exit(1); }
    process.exit(0);
})().catch(err => { console.error(err); process.exit(1); });
