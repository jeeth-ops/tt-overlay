const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const admin = require('firebase-admin');
const crypto = require('crypto');

// Safe Initialization to prevent crashes on Render if environment variables are missing
try {
    if (process.env.FIREBASE_PRIVATE_KEY) {
        admin.initializeApp({
            credential: admin.credential.cert({
                projectId: process.env.FIREBASE_PROJECT_ID || "scorvix-faf0e",
                clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
                privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n')
            })
        });
    } else {
        admin.initializeApp({
            projectId: "scorvix-faf0e"
        });
    }
} catch (e) {
    console.log("Firebase Admin Init Error:", e);
}

const db = admin.firestore();
const app = express();
const server = http.createServer(app);

const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] }
});

app.use(express.static(__dirname));
app.use(express.json());

// 🔐 Verifies a Firebase ID token and returns the real, cryptographically-
// confirmed uid — or null if it's missing/invalid/expired. This is the only
// trustworthy way to know who someone actually is; a uid supplied in a URL
// or socket payload can be typed/guessed/copied by anyone, but an ID token
// is signed by Firebase and can't be forged.
async function verifyFirebaseIdToken(idToken) {
    if (!idToken) return null;
    try {
        const decoded = await admin.auth().verifyIdToken(idToken);
        return decoded.uid;
    } catch (err) {
        return null;
    }
}

// 🔐 Lets the panel owner generate a "control token" so a second device
// (e.g. phone, via the Control-from-Mobile QR) can operate their SAME match
// — without exposing their real uid, and without letting anyone who merely
// obtains the link hijack someone else's room. Only someone holding a valid
// Firebase ID token for the room's real owner can mint a token for that room.
app.post('/api/create-control-token', async (req, res) => {
    const ownerUid = await verifyFirebaseIdToken(req.body.idToken);
    if (!ownerUid) return res.status(401).json({ success: false, error: 'Invalid or expired login' });

    const token = crypto.randomBytes(24).toString('hex');
    try {
        await db.collection('controlTokens').doc(token).set({
            room: `room-${ownerUid}`,
            ownerUid,
            createdAt: Date.now()
        });
        res.json({ success: true, token });
    } catch (err) {
        console.log('Control token creation error:', err);
        res.status(500).json({ success: false });
    }
});

// Routes
app.get('/', (req, res) => res.sendFile(__dirname + '/index.html'));
app.get('/overlay', (req, res) => res.sendFile(__dirname + '/overlay.html'));
app.get('/tt-templates', (req, res) => res.sendFile(__dirname + '/tt-templates.html'));
app.get('/tt-panel', (req, res) => res.sendFile(__dirname + '/tt-panel.html'));
app.get('/tt-matchintro', (req, res) => res.sendFile(__dirname + '/tt-matchintro.html'));
app.get('/tt-matchintro-panel', (req, res) => res.sendFile(__dirname + '/tt-matchintro-panel.html'));
app.get('/tt-lowerthird', (req, res) => res.sendFile(__dirname + '/tt-lowerthird.html'));
app.get('/tt-lowerthird-panel', (req, res) => res.sendFile(__dirname + '/tt-lowerthird-panel.html'));
app.get('/cricket-templates', (req, res) => res.sendFile(__dirname + '/cricket-templates.html'));
app.get('/cricket-overlay', (req, res) => res.sendFile(__dirname + '/cricket-overlay.html'));
app.get('/cricket-panel', (req, res) => res.sendFile(__dirname + '/cricket-panel.html'));
app.get('/football-matchintro', (req, res) => res.sendFile(__dirname + '/football-matchintro.html'));
app.get('/football-matchintro-panel', (req, res) => res.sendFile(__dirname + '/football-matchintro-panel.html'));

let roomStates = {};
const firestoreWriteTimers = {}; // debounce map: targetId -> timeout handle
const hydratedRooms = {}; // room -> true once we've pulled its saved state from Firestore.
// Without this, getRoomState() below was hitting Firestore on EVERY single
// call — every button press, every color drag, every socket connect — instead
// of just once per room. On Render's free plan that network round-trip is
// what was causing the multi-second lag on every single update.

async function getRoomState(room) {
    if (!roomStates[room]) {
        roomStates[room] = {
            ttState: {
                tourneyTitle: "TABLE TENNIS SUPER LEAGUE",
                p1Name: "Team A", p2Name: "Team B", 
                p1Score: 0, p2Score: 0, p1Sets: 0, p2Sets: 0, server: 1, img1: "", img2: "", state: "score-in", colors: {
                    bg: "#0e101c",
                    accent: "#ec4a9b",
                    text: "#ffffff"
                },
                ltTitle: "MATCH HIGHLIGHT", ltText: "Announcement text goes here", ltVisible: false
            },
            footballState: {
                showScoreboard: true,
                nameA: "REAL MADRID",
                nameB: "BARCELONA",
                logoA: "",
                logoB: "",
                showLogoA: true,
                showLogoB: true,
                scoreA: 0,
                scoreB: 0,
                colorA: "#0284c7",
                colorB: "#dc2626",
                colorClock: "#090d16",
                colorModal: "#38bdf8",
                penA: "",
                penB: "",
                timer: "00:00",
                matchDuration: 90,
                activeModal: "",
                showActionReplay: false
            },
            matchIntroState: {
                league: "TABLE TENNIS",
                round: "Quarter Final",
                venue: "Table Tennis Arena",
                teamA: { name: "Team A", logo: "" },
                teamB: { name: "Team B", logo: "" },
                colors: {
                    pink: "#ec4a9b", pinkSoft: "#f472b6", purple: "#8b6cf0", cyan: "#3fd6ea",
                    headerBg: "#0a0a0f", cardBg: "rgba(14,16,28,.55)",
                    navyDeep: "#060a16", navyMid: "#131c36", navyEnd: "#1b2a4d",
                    bgOpacity: 0.3
                },
                // Team names auto-sync with the TT scorecard until both
                // sides have real names filled in — see reconcileTeamNames().
            },
            cricketState: {
                format: "T20",
                customOvers: 20,
                venue: "",
                broadcaster: "BCCI.TV",
                teamA: { name: "India", short: "IND", color: "#1c3a8a", flagUrl: "" },
                teamB: { name: "Australia", short: "AUS", color: "#f2c200", flagUrl: "" },
                battingTeam: "A",
                score: { runs: 0, wickets: 0, overs: 0, balls: 0 },
                target: null,
                striker: { name: "Batsman 1", runs: 0, balls: 0, fours: 0, sixes: 0 },
                nonStriker: { name: "Batsman 2", runs: 0, balls: 0, fours: 0, sixes: 0 },
                bowler: { name: "Bowler", overs: 0, balls: 0, maidens: 0, runs: 0, wickets: 0 },
                thisOver: [],
                partnershipRuns: 0,
                partnershipBalls: 0,
                milestonesHit: {},
                visible: true
            },
            footballMatchIntroState: {
                league: "LAKERS CUP PLAYOFFS",
                venue: "American Airlines Center - Dallas, TX",
                kickoff: "Tomorrow, 8PM EST",
                teamA: { name: "Player A", logo: "", color: "#1c8a4a", colorAuto: true },
                teamB: { name: "Player B", logo: "", color: "#c41c2e", colorAuto: true },
                colors: {
                    navyDeep: "#060a16", navyMid: "#0d1424", navyEnd: "#151f38",
                    headerBg: "#05060a", cardBorder: "rgba(255,255,255,.14)",
                    accent: "#3fd6ea"
                },
                visible: true
            }
        };
    }

    const isUserRoom = room.startsWith('room-') || (room.length === 6 && room !== 'scorvix-master-room');

    // Only fetch from Firestore the first time this room is seen after a server
    // start/restart. We mark it hydrated BEFORE the await so two near-simultaneous
    // calls (e.g. panel connecting + panel immediately emitting an update) don't
    // both fire a redundant fetch.
    if (isUserRoom && !hydratedRooms[room]) {
        hydratedRooms[room] = true;
        const uid = room.replace('room-', '');
        try {
            const doc = await db.collection("scorvix").doc(uid).get();
            if (doc.exists) {
                const data = doc.data();
                if (data.ttState) roomStates[room].ttState = { ...roomStates[room].ttState, ...data.ttState };
                if (data.footballState) roomStates[room].footballState = { ...roomStates[room].footballState, ...data.footballState };
                if (data.matchIntroState) roomStates[room].matchIntroState = { ...roomStates[room].matchIntroState, ...data.matchIntroState };
                if (data.cricketState) roomStates[room].cricketState = { ...roomStates[room].cricketState, ...data.cricketState };
                if (data.footballMatchIntroState) roomStates[room].footballMatchIntroState = { ...roomStates[room].footballMatchIntroState, ...data.footballMatchIntroState };
            }
        } catch (err) {
            console.log("Firestore fetch error:", err);
            hydratedRooms[room] = false; // allow retry on next call since this fetch failed
        }
    }
    return roomStates[room];
}

// 🌟 Keeps team names/logos in sync between the TT scorecard (ttState) and
// the Match Intro template (matchIntroState) for the SAME match — in
// whichever order the user fills them in. Whichever side still has the
// untouched default ("Team A"/"Team B") adopts the other side's real names.
// Once BOTH sides have real (non-default) names, nothing here touches them
// again — so a later manual fix on either side stays exactly as typed.
// Returns 'matchIntro' | 'tt' | false depending on which side (if any) was
// just filled in, so the caller knows what to broadcast/persist.
function reconcileTeamNames(state) {
    if (!state.ttState || !state.matchIntroState) return false;
    const tt = state.ttState;
    const mi = state.matchIntroState;
    const ttHasReal = tt.p1Name && tt.p1Name !== "Team A" && tt.p2Name && tt.p2Name !== "Team B";
    const miHasReal = mi.teamA && mi.teamA.name && mi.teamA.name !== "Team A" && mi.teamB && mi.teamB.name && mi.teamB.name !== "Team B";

    if (ttHasReal && !miHasReal) {
        mi.teamA = { ...mi.teamA, name: tt.p1Name, logo: tt.img1 || "" };
        mi.teamB = { ...mi.teamB, name: tt.p2Name, logo: tt.img2 || "" };
        return 'matchIntro';
    }
    if (miHasReal && !ttHasReal) {
        tt.p1Name = mi.teamA.name;
        tt.img1 = mi.teamA.logo || "";
        tt.p2Name = mi.teamB.name;
        tt.img2 = mi.teamB.logo || "";
        return 'tt';
    }
    return false;
}

// Lower Third REST APIs
app.get('/api/tt-data', async (req, res) => {
    let room = req.query.id || req.query.uid || 'scorvix-master-room';
    if (!room.startsWith('room-') && room !== 'scorvix-master-room') room = `room-${room}`;
    const state = await getRoomState(room);
    res.json({
        ltTitle: state.ttState.ltTitle || "MATCH HIGHLIGHT",
        ltText: state.ttState.ltText || "Announcement text goes here",
        ltVisible: state.ttState.ltVisible || false
    });
});

app.post('/api/update-tt-data', async (req, res) => {
    let room = req.body.id || req.query.id || req.body.uid || req.query.uid || 'scorvix-master-room';
    if (!room.startsWith('room-') && room !== 'scorvix-master-room') room = `room-${room}`;
    const state = await getRoomState(room);
    
    if (req.body.ltTitle !== undefined) state.ttState.ltTitle = req.body.ltTitle;
    if (req.body.ltText !== undefined) state.ttState.ltText = req.body.ltText;
    if (req.body.ltVisible !== undefined) state.ttState.ltVisible = req.body.ltVisible;

    io.to(room).emit('liveLowerThird', {
        ltTitle: state.ttState.ltTitle,
        ltText: state.ttState.ltText,
        ltVisible: state.ttState.ltVisible
    });

    if (room.startsWith('room-')) {
        const uid = room.replace('room-', '');
        db.collection("scorvix").doc(uid).set({ ttState: state.ttState }, { merge: true }).catch(err => console.log("DB update error:", err));
    }
    res.json({ success: true });
});

// 🔗 OBS/vMix Link Activity Logging
// Panels call this whenever a user copies or previews their overlay link,
// so it shows up in the Maalik Panel's Analytics tab alongside login/logout
// and overlay-open events. Kept as its own lightweight route (rather than
// requiring the panel to load the Firestore client SDK just for this) so any
// current or future panel can log link activity with one small fetch call.
app.post('/api/log-link-action', async (req, res) => {
    try {
        const { email, action, overlay } = req.body;
        if (!email || !action) {
            return res.status(400).json({ success: false, error: 'email and action are required' });
        }
        await db.collection('analytics_logs').add({
            email,
            action,
            overlay: overlay || 'Unknown',
            time: new Date().toLocaleString()
        });
        res.json({ success: true });
    } catch (err) {
        console.log('Log link action error:', err);
        res.status(500).json({ success: false });
    }
});

// Match Intro REST API
app.get('/api/matchintro-data', async (req, res) => {
    let room = req.query.id || req.query.uid || 'scorvix-master-room';
    if (!room.startsWith('room-') && room !== 'scorvix-master-room') room = `room-${room}`;
    const state = await getRoomState(room);
    const changed = reconcileTeamNames(state);
    if (changed && room.startsWith('room-')) {
        const uid = room.replace('room-', '');
        const patch = changed === 'matchIntro' ? { matchIntroState: state.matchIntroState } : { ttState: state.ttState };
        db.collection("scorvix").doc(uid).set(patch, { merge: true }).catch(err => console.log("DB update error:", err));
    }
    res.json(state.matchIntroState);
});

io.on('connection', async (socket) => {
    let currentRoom = 'scorvix-master-room';
    socket.activeRoom = currentRoom;
    socket.join(currentRoom);

    const query = socket.handshake.query;
    const clientId = query.id || query.uid;
    const cleanQueryUid = query.uid ? query.uid.replace('overlay-', '') : null;
    // Overlay pages connect with a "room" query param (e.g. ?room=room-xxxxx).
    // This was not being read before, so overlays never joined the correct
    // room and stayed stuck in 'scorvix-master-room'.
    const cleanQueryRoom = query.room ? query.room.replace('room-', '') : null;

    if (clientId || cleanQueryUid || cleanQueryRoom) {
        const idVal = cleanQueryRoom || cleanQueryUid || clientId;
        currentRoom = `room-${idVal}`;
        socket.leave(socket.activeRoom);
        socket.join(currentRoom);
        socket.activeRoom = currentRoom;
    }

    const roomState = await getRoomState(currentRoom);
    const matchIdForClient = cleanQueryRoom || cleanQueryUid || clientId || 'default';

    const connectSyncResult = reconcileTeamNames(roomState);
    if (roomState.matchIntroState) {
        socket.emit('liveMatchIntro', {
            matchId: matchIdForClient,
            config: roomState.matchIntroState,
            triggerReplay: false
        });
    }
    if (roomState.ttState) socket.emit('liveScore', roomState.ttState);
    if (roomState.footballState) socket.emit('liveFootballScore', roomState.footballState);
    if (roomState.cricketState) socket.emit('liveCricketScore', roomState.cricketState);
    if (roomState.footballMatchIntroState) socket.emit('liveFootballMatchIntro', { config: roomState.footballMatchIntroState, triggerReplay: false });
    if (connectSyncResult && currentRoom.startsWith('room-')) {
        const uid = currentRoom.replace('room-', '');
        const patch = connectSyncResult === 'matchIntro' ? { matchIntroState: roomState.matchIntroState } : { ttState: roomState.ttState };
        db.collection("scorvix").doc(uid).set(patch, { merge: true }).catch(err => console.log("DB update error:", err));
    }

    // SCOREBOARD PANEL UPDATE HANDLING (Table Tennis)
    socket.on('updateScore', async (data) => {
        let room = socket.activeRoom;
        const targetId = data.id || data.uid || matchIdForClient;
        if (targetId && targetId !== 'default') {
            room = `room-${targetId}`;
            socket.leave(socket.activeRoom);
            socket.join(room);
            socket.activeRoom = room;
        }

        const state = await getRoomState(room);
        state.ttState = { ...state.ttState, ...data };
        // 🩹 Self-heal: an old bug could nest these top-level keys inside
        // ttState itself, growing deeper on every save until Firestore
        // rejected the write ("deeper than 20 levels or contains a cycle").
        // Stripping them here fixes already-corrupted rooms automatically.
        delete state.ttState.ttState;
        delete state.ttState.footballState;
        delete state.ttState.matchIntroState;

        io.to(room).emit('liveScore', state.ttState);

        // 🌟 Keep the Match Intro template's teams in sync in real time too
        // (not just on next page load) — works both ways, see reconcileTeamNames().
        const scoreSyncResult = reconcileTeamNames(state);
        if (scoreSyncResult === 'matchIntro') {
            io.to(room).emit('liveMatchIntro', {
                matchId: targetId || matchIdForClient,
                config: state.matchIntroState,
                triggerReplay: false
            });
            if (targetId && targetId !== 'default') {
                db.collection("scorvix").doc(targetId).set({ matchIntroState: state.matchIntroState }, { merge: true }).catch(err => console.log("DB update error:", err));
            }
        }

        // Debounced (max once per 700ms per room) — same fix already applied
        // to football. Without this, every point/voice-command/text-edit fired
        // its own immediate Firestore write, and those queued up on Node's
        // single event loop, delaying processing of the NEXT update (for TT,
        // football, or anyone else's room) behind it.
        if (targetId && targetId !== 'default') {
            clearTimeout(firestoreWriteTimers[targetId + ':tt']);
            firestoreWriteTimers[targetId + ':tt'] = setTimeout(() => {
                db.collection("scorvix").doc(targetId).set({ ttState: state.ttState }, { merge: true }).catch(err => console.log("DB update error:", err));
            }, 700);
        }
    });

    // ⚽ FOOTBALL SCOREBOARD PANEL & OVERLAY SOCKET HANDLING
    const handleFootballUpdate = async (data) => {
        let room = socket.activeRoom;
        const targetId = data.room ? data.room.replace('room-', '') : (data.id || data.uid || matchIdForClient);
        if (targetId && targetId !== 'default') {
            room = `room-${targetId}`;
            // Only leave/join if the socket isn't already in this room —
            // avoids unnecessary work on every single keystroke/slider event.
            if (socket.activeRoom !== room) {
                socket.leave(socket.activeRoom);
                socket.join(room);
                socket.activeRoom = room;
            }
        }

        const state = await getRoomState(room);
        state.footballState = { ...state.footballState, ...data };

        // Broadcast updated football data to overlay and panels IMMEDIATELY —
        // this is what makes the overlay feel instant.
        io.to(room).emit('liveFootballScore', state.footballState);

        // Save to Firestore, but debounced (max once per 700ms per room).
        // Without this, rapid updates (e.g. dragging a color picker) queue up
        // many DB writes back-to-back, which can make later live updates feel
        // delayed since Node has to work through the backlog.
        if (targetId && targetId !== 'default') {
            clearTimeout(firestoreWriteTimers[targetId]);
            firestoreWriteTimers[targetId] = setTimeout(() => {
                db.collection("scorvix").doc(targetId).set({ footballState: state.footballState }, { merge: true }).catch(err => console.log("DB update error:", err));
            }, 700);
        }
    };

    socket.on('updateFootballScore', handleFootballUpdate);
    socket.on('liveFootballScore', handleFootballUpdate);

    // 🏏 CRICKET SCOREBOARD PANEL & OVERLAY SOCKET HANDLING
    // Mirrors handleFootballUpdate: merge partial updates into persisted room
    // state, broadcast immediately, save to Firestore debounced (700ms) so
    // rapid ball-by-ball updates don't queue up a DB write per click.
    const handleCricketUpdate = async (data) => {
        let room = socket.activeRoom;
        const targetId = data.room ? data.room.replace('room-', '') : (data.id || data.uid || matchIdForClient);
        if (targetId && targetId !== 'default') {
            room = `room-${targetId}`;
            if (socket.activeRoom !== room) {
                socket.leave(socket.activeRoom);
                socket.join(room);
                socket.activeRoom = room;
            }
        }

        const state = await getRoomState(room);
        state.cricketState = { ...state.cricketState, ...data };

        io.to(room).emit('liveCricketScore', state.cricketState);

        if (targetId && targetId !== 'default') {
            clearTimeout(firestoreWriteTimers[`cricket-${targetId}`]);
            firestoreWriteTimers[`cricket-${targetId}`] = setTimeout(() => {
                db.collection("scorvix").doc(targetId).set({ cricketState: state.cricketState }, { merge: true }).catch(err => console.log("DB update error:", err));
            }, 700);
        }
    };

    socket.on('updateCricketScore', handleCricketUpdate);
    socket.on('liveCricketScore', handleCricketUpdate);

    // One-off milestone animations (FOUR/SIX/WICKET/50/100/victory/etc.) are
    // pure broadcast events — they are NOT merged into cricketState and are
    // NOT written to Firestore, since they're a transient overlay animation
    // trigger, not part of the persisted scoreboard.
    socket.on('cricketEvent', (data) => {
        let room = socket.activeRoom;
        const targetId = data.room ? data.room.replace('room-', '') : (data.id || data.uid || matchIdForClient);
        if (targetId && targetId !== 'default') room = `room-${targetId}`;
        io.to(room).emit('cricketEvent', data.event || data);
    });

    // 🏈 FOOTBALL MATCH INTRO PANEL & OVERLAY SOCKET HANDLING
    // Broadcast is ALWAYS immediate (no delay ever added to what viewers see)
    // — only the Firestore save is debounced, purely to avoid flooding the DB
    // on rapid edits. That debounce never delays the live update itself.
    const handleFootballMatchIntroUpdate = async (data) => {
        let room = socket.activeRoom;
        const targetId = data.room ? data.room.replace('room-', '') : (data.id || data.uid || matchIdForClient);
        if (targetId && targetId !== 'default') {
            room = `room-${targetId}`;
            if (socket.activeRoom !== room) {
                socket.leave(socket.activeRoom);
                socket.join(room);
                socket.activeRoom = room;
            }
        }

        const state = await getRoomState(room);
        if (data.config) {
            state.footballMatchIntroState = data.config;
        } else {
            state.footballMatchIntroState = { ...state.footballMatchIntroState, ...data };
        }

        io.to(room).emit('liveFootballMatchIntro', {
            config: state.footballMatchIntroState,
            triggerReplay: data.triggerReplay || false
        });

        if (targetId && targetId !== 'default') {
            clearTimeout(firestoreWriteTimers[`fmi-${targetId}`]);
            firestoreWriteTimers[`fmi-${targetId}`] = setTimeout(() => {
                db.collection("scorvix").doc(targetId).set({ footballMatchIntroState: state.footballMatchIntroState }, { merge: true }).catch(err => console.log("DB update error:", err));
            }, 700);
        }
    };
    socket.on('updateFootballMatchIntro', handleFootballMatchIntroUpdate);
    socket.on('liveFootballMatchIntro', handleFootballMatchIntroUpdate);

    // Match Intro Socket Update Handling
    socket.on('updateMatchIntro', async (data) => {
        let room = socket.activeRoom;
        const targetId = data.id || data.uid || matchIdForClient;
        if (targetId && targetId !== 'default') {
            room = `room-${targetId}`;
            socket.leave(socket.activeRoom);
            socket.join(room);
            socket.activeRoom = room;
        }
        
        const state = await getRoomState(room);
        if (data.config) {
            state.matchIntroState = data.config;
        } else {
            state.matchIntroState = data; 
        }

        io.to(room).emit('liveMatchIntro', {
            matchId: targetId,
            config: state.matchIntroState,
            triggerReplay: data.triggerReplay || false
        });

        if (targetId && targetId !== 'default') {
            db.collection("scorvix").doc(targetId).set({ matchIntroState: state.matchIntroState }, { merge: true }).catch(err => console.log("DB update error:", err));
        }

        // 🌟 If TT's team names are still default and Match Intro just got
        // real ones, push those into the TT scorecard too — so opening the
        // scorecard next (even on a different device) already has them.
        const introSyncResult = reconcileTeamNames(state);
        if (introSyncResult === 'tt') {
            io.to(room).emit('liveScore', state.ttState);
            if (targetId && targetId !== 'default') {
                db.collection("scorvix").doc(targetId).set({ ttState: state.ttState }, { merge: true }).catch(err => console.log("DB update error:", err));
            }
        }
    });

    socket.on('disconnect', () => {});
});

const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
