// Boots the REAL server.js in this process for a test: MongoDB is the
// in-memory test/mongo-memory.js (production indexes created first),
// firebase-admin a stub that knows no users (opts.idTokens: { token: decoded }
// are the only ID tokens it accepts). Resolves once the server answers.
//
//   const { port, mem, url } = await bootServer();
const path = require('path');
const http = require('http');
const { MemoryDb } = require('./mongo-memory.js');
const F = require('./merge-fixtures.js');

async function bootServer(opts){
  opts = opts || {};
  const mem = new MemoryDb();
  const realMongo = require('mongodb');
  class Client { async connect(){} db(name){ return { databaseName: name || 'scorvix', collection: (n) => mem.collection(n) }; } }
  require.cache[require.resolve('mongodb')] = { id: 'mongodb', filename: require.resolve('mongodb'), loaded: true,
    exports: new Proxy(realMongo, { get: (t, k) => (k === 'MongoClient' ? Client : t[k]) }) };
  const fakeDoc = { get: async () => ({ exists: false, data: () => null }), set: async () => {}, update: async () => {}, onSnapshot: () => () => {} };
  require.cache[require.resolve('firebase-admin')] = { id: 'firebase-admin', filename: require.resolve('firebase-admin'), loaded: true, exports: {
    initializeApp(){}, credential: { cert: () => ({}) },
    firestore: () => ({ collection: () => ({ doc: () => fakeDoc, where: () => ({ get: async () => ({ docs: [] }) }) }) }),
    auth: () => ({ verifyIdToken: async (t) => { if(opts.idTokens && opts.idTokens[t]) return opts.idTokens[t]; throw new Error('no tokens here'); }, getUser: async () => { throw new Error('no user'); },
      getUserByEmail: async () => { throw new Error('no user'); }, listUsers: async () => ({ users: [] }) }) } };
  const port = opts.port || (5200 + Math.floor(Math.random() * 700));
  process.env.PORT = String(port);
  process.env.MONGODB_URI = 'mongodb://memory';
  await F.indexes(F.collections(mem));
  if(opts.seed) await opts.seed(mem);
  process.chdir(path.join(__dirname, '..'));
  require('../server.js');
  const status = (u) => new Promise((resolve) => {
    http.get({ host: '127.0.0.1', port, path: u }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); }).on('error', () => resolve(0));
  });
  for(let i = 0; i < 200; i++){
    await new Promise(r => setTimeout(r, 20));
    if(await status('/cricket-overlay') === 200) return { port, mem, url: (p) => `http://127.0.0.1:${port}${p}` };
  }
  throw new Error('server.js did not come up');
}

// A JSON request to it.
function request(port, method, url, body, headers){
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({ host: '127.0.0.1', port, method, path: url,
      headers: Object.assign({}, data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}, headers || {}) }, (res) => {
      let buf = '';
      res.on('data', (ch) => { buf += ch; });
      res.on('end', () => { let json = null; try { json = JSON.parse(buf); } catch(e) {} resolve({ status: res.statusCode, json, headers: res.headers }); });
    });
    r.on('error', reject);
    if(data) r.write(data);
    r.end();
  });
}

module.exports = { bootServer, request };
