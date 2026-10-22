// ▶️ Homepage "Latest streams" — the REAL server.js over HTTP (in-memory
// MongoDB, Firebase tokens mapped to the test accounts):
//   • the list carries each tournament's latest YouTube videos; "live" only
//     while the panel keeps pinging (a match that never signed off is not
//     live weeks later)
//   • only chhayajeeth@gmail.com may add / remove / restore (403 for anyone
//     else, signed out included); a bad link is refused
//   • add: any YouTube video, its title from YouTube when none is typed;
//     shown to everyone at once (the cached list is dropped)
//   • remove: gone from the homepage for everyone; the owner's own view
//     lists it under "removed" with its title; restore brings it back — an
//     added one as added, a match's one in its tournament again
//   • every change is in the audit log
//
//   node test/homepage-streams-server.test.js     (needs the repo's npm install)
const F = require('./merge-fixtures.js');

let pass = 0, fail = 0;
function eq(name, a, b) {
  if (JSON.stringify(a) === JSON.stringify(b)) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log(`  FAIL  ${name} :: got ${JSON.stringify(a)} expected ${JSON.stringify(b)}`); }
}

// YouTube's oEmbed stands in here: the server asks it for a video's title.
const realFetch = global.fetch;
const oembedAsked = [];
global.fetch = async (url, opts) => {
  const u = String(url);
  if (u.startsWith('https://www.youtube.com/oembed')) {
    oembedAsked.push(u);
    if (/NOTITLE0001/.test(decodeURIComponent(u))) return new Response('Not Found', { status: 404 });
    return new Response(JSON.stringify({ title: '  Grand  Final\u0007 — Full Match  ', author_name: 'All Sports Live' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
  return realFetch(url, opts);
};

const DAY = 24 * 60 * 60 * 1000;
const tick = () => new Promise((r) => setTimeout(r, 5)); // adds never share a millisecond
const rec = (matchId, url, at, o) => Object.assign({
  _id: new F.ObjectId(), ownerUid: F.USERS.work.uid, leagueKey: 'pub cup', matchId, roomId: 'room-' + matchId, matchNo: 3,
  savedAt: at, format: 'T20', upcoming: false, streamUrl: url,
  teamA: { name: 'Dr DY Patil', short: 'DYP' }, teamB: { name: 'New Cricket Club', short: 'NCC' },
  scoreA: { runs: 150, wickets: 5, overs: '20.0' }, scoreB: { runs: 140, wickets: 9, overs: '20.0' }, winningTeam: 'A',
  battingCard: { A: [], B: [] }, bowlingCard: { A: [], B: [] }
}, o);

(async () => {
  const { bootServer } = require('./merge-server-boot.js');
  const { c, req } = await bootServer(async (c) => {
    await F.addLeague(c, { ownerUid: F.USERS.work.uid, leagueKey: 'pub cup', name: 'Pub Cup', token: 'tokPub',
      liveMatches: [{ matchId: 'm-live', roomId: 'room-m-live', startedAt: Date.now() - 60 * 1000 }, { matchId: 'm-stale', roomId: 'room-m-stale', startedAt: Date.now() - 26 * DAY }] });
    await c.records.insertOne(rec('m-live', 'https://youtu.be/LIVEVIDEO01', '2026-10-01T10:00:00.000Z'));
    await c.records.insertOne(rec('m-stale', 'https://www.youtube.com/live/WRONGLINK01', '2026-09-26T10:00:00.000Z'));
    await c.records.insertOne(rec('m-old', 'https://www.youtube.com/watch?v=OLDVIDEO001', '2026-09-20T10:00:00.000Z', { matchTitle: 'Semi Final' }));
  });
  const list = async (token) => (await req('GET', '/api/public/tournaments', null, token)).json;
  const pub = (j) => j.tournaments.find((t) => t.token === 'tokPub');
  const ids = (st) => (st || []).map((s) => s.videoId + (s.live ? ':live' : ''));

  console.log('\n=== the list ===');
  let j = await list();
  eq('a tournament\'s latest videos: the match being scored now first, then the newest', ids(pub(j).streams), ['LIVEVIDEO01:live', 'WRONGLINK01', 'OLDVIDEO001']);
  eq('a match whose live pointer is weeks old is not "live"', pub(j).streams.find((s) => s.videoId === 'WRONGLINK01').live, false);
  eq('nothing added or removed yet; the public list never shows what was removed', j.streamPicks, { added: [] });

  console.log('\n=== only the owner ===');
  const tries = [];
  for (const tok of [null, 'tok-work', 'tok-vinit', 'tok-other', 'tok-unverified']) {
    tries.push((await req('POST', '/api/admin/streams', { url: 'https://youtu.be/HACKVIDEO01' }, tok)).status);
    tries.push((await req('POST', '/api/admin/streams/LIVEVIDEO01/hide', {}, tok)).status);
    tries.push((await req('POST', '/api/admin/streams/LIVEVIDEO01/restore', {}, tok)).status);
  }
  eq('signed out or any other account: refused, every route', [...new Set(tries)], [403]);
  j = await list();
  eq('… and nothing changed', [ids(pub(j).streams), j.streamPicks], [['LIVEVIDEO01:live', 'WRONGLINK01', 'OLDVIDEO001'], { added: [] }]);
  const bad = await Promise.all(['', 'hello', 'https://vimeo.com/123', 'https://www.youtube.com/@allsportslive'].map((u) => req('POST', '/api/admin/streams', { url: u }, 'tok-owner')));
  eq('the owner pasting something that is not a video: refused with a reason', bad.map((r) => [r.status, /YouTube video link/.test(r.json.error)]), [[400, true], [400, true], [400, true], [400, true]]);
  eq('a made-up id on remove / restore: refused', [(await req('POST', '/api/admin/streams/short/hide', {}, 'tok-owner')).status, (await req('POST', '/api/admin/streams/$bad$bad$b/restore', {}, 'tok-owner')).status], [400, 400]);

  console.log('\n=== add ===');
  let r = await req('POST', '/api/admin/streams', { url: 'https://www.youtube.com/watch?v=ADDEDVIDE01&t=40s', label: 'Final · 26 Oct' }, 'tok-owner');
  eq('the owner adds a video without a title: YouTube\'s own title, tidied', [r.status, r.json.stream.videoId, r.json.stream.title, r.json.stream.label], [200, 'ADDEDVIDE01', 'Grand Final — Full Match', 'Final · 26 Oct']);
  await tick();
  r = await req('POST', '/api/admin/streams', { url: 'https://youtu.be/NOTITLE0001', title: '' }, 'tok-owner');
  eq('YouTube not answering: added anyway, no title', [r.status, r.json.stream.title], [200, '']);
  await tick();
  r = await req('POST', '/api/admin/streams', { url: 'TYPEDTITLE1', title: 'Opening ceremony <b>live</b>' }, 'tok-owner');
  eq('a bare id, a typed title (kept as text — the page escapes it)', [r.status, r.json.stream.title], [200, 'Opening ceremony <b>live</b>']);
  eq('YouTube asked only when no title was typed', oembedAsked.length, 2);
  j = await list();
  eq('everyone sees the added videos at once, newest first', j.streamPicks.added.map((a) => [a.videoId, a.title, a.label]),
    [['TYPEDTITLE1', 'Opening ceremony <b>live</b>', ''], ['NOTITLE0001', '', ''], ['ADDEDVIDE01', 'Grand Final — Full Match', 'Final · 26 Oct']]);

  console.log('\n=== remove ===');
  r = await req('POST', '/api/admin/streams/WRONGLINK01/hide', { title: 'DYP vs NCC', label: 'Match 3', tournament: 'Pub Cup' }, 'tok-owner');
  eq('the owner removes a wrong link pasted on a match', r.status, 200);
  j = await list();
  eq('gone from the tournament\'s videos for everyone, the rest stay', ids(pub(j).streams), ['LIVEVIDEO01:live', 'OLDVIDEO001']);
  eq('the public list still does not say what was removed', Object.keys(j.streamPicks), ['added']);
  let own = await list('tok-owner');
  eq('the owner\'s own view lists it, with its title, to put back', own.streamPicks.hidden.map((h) => [h.videoId, h.title, h.tournament, h.label]), [['WRONGLINK01', 'DYP vs NCC', 'Pub Cup', 'Match 3']]);
  eq('… and leaves it out of the tournament there too', ids(pub(own).streams), ['LIVEVIDEO01:live', 'OLDVIDEO001']);
  await tick();
  await req('POST', '/api/admin/streams/ADDEDVIDE01/hide', { title: 'ignored — the stored title wins' }, 'tok-owner');
  j = await list();
  own = await list('tok-owner');
  eq('an added video removed: off the list, kept under removed with its own title', [j.streamPicks.added.map((a) => a.videoId), own.streamPicks.hidden.map((h) => h.videoId + ':' + h.title)],
    [['TYPEDTITLE1', 'NOTITLE0001'], ['ADDEDVIDE01:Grand Final — Full Match', 'WRONGLINK01:DYP vs NCC']]);

  console.log('\n=== restore ===');
  await tick();
  await req('POST', '/api/admin/streams/ADDEDVIDE01/restore', {}, 'tok-owner');
  j = await list();
  eq('restore an added one: added again, at the top', j.streamPicks.added.map((a) => a.videoId), ['ADDEDVIDE01', 'TYPEDTITLE1', 'NOTITLE0001']);
  await req('POST', '/api/admin/streams/WRONGLINK01/restore', {}, 'tok-owner');
  j = await list();
  own = await list('tok-owner');
  eq('restore a match\'s one: back in its tournament', [ids(pub(j).streams), own.streamPicks.hidden], [['LIVEVIDEO01:live', 'WRONGLINK01', 'OLDVIDEO001'], []]);
  eq('restoring something never removed changes nothing', [(await req('POST', '/api/admin/streams/OLDVIDEO001/restore', {}, 'tok-owner')).status, ids(pub(await list()).streams)], [200, ['LIVEVIDEO01:live', 'WRONGLINK01', 'OLDVIDEO001']]);

  console.log('\n=== the record ===');
  const audits = (await c.audits.find({}).toArray()).filter((a) => /homepage stream/.test(a.action)).map((a) => a.action + ' ' + a.target + ' by ' + a.performedBy);
  eq('every change in the audit log, by the owner', audits, [
    'Add homepage stream ADDEDVIDE01 by chhayajeeth@gmail.com', 'Add homepage stream NOTITLE0001 by chhayajeeth@gmail.com', 'Add homepage stream TYPEDTITLE1 by chhayajeeth@gmail.com',
    'Remove homepage stream WRONGLINK01 by chhayajeeth@gmail.com', 'Remove homepage stream ADDEDVIDE01 by chhayajeeth@gmail.com',
    'Restore homepage stream ADDEDVIDE01 by chhayajeeth@gmail.com', 'Restore homepage stream WRONGLINK01 by chhayajeeth@gmail.com']);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
