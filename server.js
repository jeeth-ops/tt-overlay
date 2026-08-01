const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const firebase = require('firebase/compat/app');
require('firebase/compat/firestore');

firebase.initializeApp({
    apiKey: "AIzaSyAYc_bEB9C4RhhLhPBEJsJRFRUppcR45yo",
    authDomain: "scorvix-faf0e.firebaseapp.com",
    projectId: "scorvix-faf0e",
    storageBucket: "scorvix-faf0e.firebasestorage.app",
    messagingSenderId: "725629580596",
    appId: "1:725629580596:web:7737847e7194650f276161",
    measurementId: "G-4EXH0QXHF7"
});

const db = firebase.firestore();
const app = express();
const server = http.createServer(app);

const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] }
});

app.use(express.static(__dirname));
app.use(express.json());

// Routes
app.get('/', (req, res) => res.sendFile(__dirname + '/index.html'));
app.get('/overlay', (req, res) => res.sendFile(__dirname + '/overlay.html'));
app.get('/tt-templates', (req, res) => res.sendFile(__dirname + '/tt-templates.html'));
app.get('/tt-panel', (req, res) => res.sendFile(__dirname + '/tt-panel.html'));
app.get('/tt-matchintro', (req, res) => res.sendFile(__dirname + '/tt-matchintro.html'));
app.get('/tt-matchintro-panel', (req, res) => res.sendFile(__dirname + '/tt-matchintro-panel.html'));
app.get('/tt-lowerthird', (req, res) => res.sendFile(__dirname + '/tt-lowerthird.html'));
app.get('/tt-lowerthird-panel', (req, res) => res.sendFile(__dirname + '/tt-lowerthird-panel.html'));

let roomStates = {};

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
                }
            }
        };
    }

    if (room.startsWith('room-') || (room.length === 6 && room !== 'scorvix-master-room')) {
        const uid = room.replace('room-', '');
        try {
            const doc = await db.collection("scorvix").doc(uid).get();
            if (doc.exists) {
                const data = doc.data();
                if (data.ttState) roomStates[room].ttState = { ...roomStates[room].ttState, ...data.ttState };
                if (data.footballState) roomStates[room].footballState = { ...roomStates[room].footballState, ...data.footballState };
                if (data.matchIntroState) roomStates[room].matchIntroState = { ...roomStates[room].matchIntroState, ...data.matchIntroState };
            }
        } catch (err) {
            console.log("Firestore fetch error:", err);
        }
    }
    return roomStates[room];
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

// Match Intro REST API
app.get('/api/matchintro-data', async (req, res) => {
    let room = req.query.id || req.query.uid || 'scorvix-master-room';
    if (!room.startsWith('room-') && room !== 'scorvix-master-room') room = `room-${room}`;
    const state = await getRoomState(room);
    res.json(state.matchIntroState);
});

io.on('connection', async (socket) => {
    let currentRoom = 'scorvix-master-room';
    socket.activeRoom = currentRoom;
    socket.join(currentRoom);

    const query = socket.handshake.query;
    const clientId = query.id || query.uid;
    const cleanQueryUid = query.uid ? query.uid.replace('overlay-', '') : null;
    
    if (clientId || cleanQueryUid) {
        const idVal = cleanQueryUid || clientId;
        currentRoom = `room-${idVal}`;
        socket.leave(socket.activeRoom);
        socket.join(currentRoom);
        socket.activeRoom = currentRoom;
    }

    const roomState = await getRoomState(currentRoom);
    const matchIdForClient = cleanQueryUid || clientId || 'default';

    if (roomState.matchIntroState) {
        socket.emit('liveMatchIntro', {
            matchId: matchIdForClient,
            config: roomState.matchIntroState,
            triggerReplay: false
        });
    }
    if (roomState.ttState) socket.emit('liveScore', roomState.ttState);
    if (roomState.footballState) socket.emit('liveFootballScore', roomState.footballState);

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

        io.to(room).emit('liveScore', state.ttState);

        if (targetId && targetId !== 'default') {
            db.collection("scorvix").doc(targetId).set({ ttState: state.ttState }, { merge: true }).catch(err => console.log("DB update error:", err));
        }
    });

    // ⚽ FOOTBALL SCOREBOARD PANEL & OVERLAY SOCKET HANDLING
    const handleFootballUpdate = async (data) => {
        let room = socket.activeRoom;
        const targetId = data.room ? data.room.replace('room-', '') : (data.id || data.uid || matchIdForClient);
        if (targetId && targetId !== 'default') {
            room = `room-${targetId}`;
            socket.leave(socket.activeRoom);
            socket.join(room);
            socket.activeRoom = room;
        }

        const state = await getRoomState(room);
        state.footballState = { ...state.footballState, ...data };

        // Broadcast updated football data to overlay and panels
        io.to(room).emit('liveFootballScore', state.footballState);

        // Save to Firestore Database
        if (targetId && targetId !== 'default') {
            db.collection("scorvix").doc(targetId).set({ footballState: state.footballState }, { merge: true }).catch(err => console.log("DB update error:", err));
        }
    };

    socket.on('updateFootballScore', handleFootballUpdate);
    socket.on('liveFootballScore', handleFootballUpdate);

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
    });

    socket.on('disconnect', () => {});
});

server.listen(process.env.PORT || 3000, () => {
    console.log(`Server running on port ${process.env.PORT || 3000}`);
});
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
