// A stand-in for the Anthropic Messages API (POST /v1/messages, streamed),
// for tests: the real @anthropic-ai/sdk talks to it through `baseURL`, so the
// request the server builds (model, beta header, fallbacks, schema, images)
// and the SDK's streaming / error paths are exercised for real, offline.
//
//   const fake = await startFakeAnthropic((body, req) => ({ json: {...} }));
//   fake.url → base URL; fake.requests → every request received
//   reply: { json } → streamed text block with JSON.stringify(json)
//          { text } → streamed raw text   { stopReason: 'refusal' | 'max_tokens' }
//          { status: 401 | 429 | 500, error: 'message' }
const http = require('http');

function sse(res, events) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    for (const e of events) res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
    res.end();
}

function streamFor(reply, body) {
    const text = reply.text != null ? reply.text : JSON.stringify(reply.json == null ? {} : reply.json);
    const chunks = [];
    for (let i = 0; i < text.length; i += 700) chunks.push(text.slice(i, i + 700));
    const events = [
        { type: 'message_start', message: { id: 'msg_fake', type: 'message', role: 'assistant', model: (body && body.model) || 'claude-opus-5-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1200, output_tokens: 1 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        ...chunks.map(t => ({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: t } })),
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: reply.stopReason || 'end_turn', stop_sequence: null }, usage: { output_tokens: Math.max(1, Math.round(text.length / 4)) } },
        { type: 'message_stop' }
    ];
    return events;
}

function startFakeAnthropic(handler) {
    const requests = [];
    const server = http.createServer((req, res) => {
        let buf = '';
        req.on('data', (c) => { buf += c; });
        req.on('end', async () => {
            let body = null;
            try { body = JSON.parse(buf); } catch (e) { /* not json */ }
            requests.push({ method: req.method, url: req.url, headers: req.headers, body });
            let reply;
            try { reply = await handler(body, req, requests.length); } catch (e) { reply = { status: 500, error: String(e.message || e) }; }
            reply = reply || {};
            if (reply.delayMs) await new Promise(r => setTimeout(r, reply.delayMs));
            if (reply.status && reply.status !== 200) {
                const type = { 400: 'invalid_request_error', 401: 'authentication_error', 403: 'permission_error', 429: 'rate_limit_error', 500: 'api_error', 529: 'overloaded_error' }[reply.status] || 'api_error';
                res.writeHead(reply.status, Object.assign({ 'Content-Type': 'application/json' }, reply.status === 429 ? { 'retry-after': '0' } : {}));
                res.end(JSON.stringify({ type: 'error', error: { type, message: reply.error || 'error' } }));
                return;
            }
            sse(res, streamFor(reply, body));
        });
    });
    return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => {
            const { port } = server.address();
            resolve({ url: `http://127.0.0.1:${port}`, requests, close: () => new Promise(r => server.close(() => r())) });
        });
    });
}

module.exports = { startFakeAnthropic };
