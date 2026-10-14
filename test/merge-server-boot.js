// Boots the REAL server.js inside this test process, against an in-memory
// MongoDB (test/mongo-memory.js) and a stand-in for Firebase Admin whose ID
// tokens map to the test accounts. One boot per process (server.js listens
// on a port and keeps timers running — the test ends with process.exit).
const path = require('path');
const http = require('http');
const { MemoryDb } = require('./mongo-memory.js');
const F = require('./merge-fixtures.js');
const { USERS } = F;

const TOKENS = {
    'tok-owner': { uid: USERS.owner.uid, email: USERS.owner.email, email_verified: true },
    'tok-work': { uid: USERS.work.uid, email: USERS.work.email, email_verified: true },
    'tok-vinit': { uid: USERS.vinit.uid, email: USERS.vinit.email, email_verified: true },
    'tok-other': { uid: USERS.other.uid, email: USERS.other.email, email_verified: true },
    'tok-unverified': { uid: 'u-fake', email: USERS.work.email, email_verified: false }
};

async function bootServer(seed) {
    const mem = new MemoryDb();
    const realMongo = require('mongodb');
    class FakeClient { async connect() {} db(name) { return { databaseName: name || 'scorvix', collection: (n) => mem.collection(n) }; } }
    const mongoStub = new Proxy(realMongo, { get: (t, k) => (k === 'MongoClient' ? FakeClient : t[k]) });
    require.cache[require.resolve('mongodb')] = { id: 'mongodb', filename: require.resolve('mongodb'), loaded: true, exports: mongoStub };
    const fakeDoc = { get: async () => ({ exists: false, data: () => null }), set: async () => {}, update: async () => {}, onSnapshot: () => () => {} };
    const adminStub = {
        initializeApp() {}, credential: { cert: () => ({}) },
        firestore: () => ({ collection: () => ({ doc: () => fakeDoc, where: () => ({ get: async () => ({ docs: [] }) }) }) }),
        auth: () => ({
            verifyIdToken: async (t) => { if (TOKENS[t]) return TOKENS[t]; throw new Error('invalid token'); },
            getUser: async (uid) => { if (!F.EMAIL_OF[uid]) throw new Error('no user'); return { uid, email: F.EMAIL_OF[uid] }; },
            getUserByEmail: async (e) => { if (!F.UID_OF[e]) throw new Error('no user'); return { uid: F.UID_OF[e], email: e }; },
            listUsers: async () => ({ users: [] })
        })
    };
    require.cache[require.resolve('firebase-admin')] = { id: 'firebase-admin', filename: require.resolve('firebase-admin'), loaded: true, exports: adminStub };

    const port = 4300 + Math.floor(Math.random() * 600);
    process.env.PORT = String(port);
    process.env.MONGODB_URI = 'mongodb://memory';
    const c = F.collections(mem);
    await F.indexes(c);
    if (seed) await seed(c, mem);

    const req = (method, url, body, token) => new Promise((resolve, reject) => {
        const data = body ? JSON.stringify(body) : null;
        const r = http.request({ host: '127.0.0.1', port, method, path: url, headers: Object.assign({ 'Content-Type': 'application/json' }, token ? { Authorization: 'Bearer ' + token } : {}, data ? { 'Content-Length': Buffer.byteLength(data) } : {}) }, (res) => {
            let buf = '';
            res.on('data', (ch) => { buf += ch; });
            res.on('end', () => { let json = null; try { json = JSON.parse(buf); } catch (e) { /* not json */ } resolve({ status: res.statusCode, json, headers: res.headers, text: buf }); });
        });
        r.on('error', reject);
        if (data) r.write(data);
        r.end();
    });

    process.chdir(path.join(__dirname, '..'));
    require('../server.js');
    for (let i = 0; i < 200; i++) {
        await new Promise(r => setTimeout(r, 50));
        try { const r = await req('GET', '/api/tournament-merge/access', null, 'tok-owner'); if (r.status === 200) return { port, mem, c, req }; } catch (e) { /* not listening yet */ }
    }
    throw new Error('server.js did not come up');
}

module.exports = { bootServer, TOKENS };
