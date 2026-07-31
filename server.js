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
                tourneyTitle: "TABLE TENNIS SUPER LEAGUE MAHARASHTRA 2025",
                p1Name: "PHANTOM STARS", p2Name: "MUMBAI MOZARTT", 
                p1Score: 0, p2Score: 0, p1Sets: 0, p2Sets: 0, server: 1, img1: "", img2: "", state: "score-in",
                ltTitle: "MATCH HIGHLIGHT", ltText: "Announcement text goes here", ltVisible: false
            },
            footballState: null,
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

    if (room.startsWith('room-')) {
        const uid = room.replace('room-', '');
        try {
            const doc = await db.collection("scorvix").doc(uid).get();
            if (doc.exists) {
                const data = doc.data();
                if (data.ttState) roomStates[room].ttState = { ...roomStates[room].ttState, ...data.ttState };
                if (data.matchIntroState) roomStates[room].matchIntroState = { ...roomStates[room].matchIntroState, ...data.matchIntroState };
            }
        } catch (err) {
            console.log("Firestore fetch error:", err);
        }
    }
    return roomStates[room];
}

// Match Intro REST API
app.get('/api/matchintro-data', async (req, res) => {
    let room = 'scorvix-master-room';
    if (req.query.room) room = req.query.room;
    else if (req.query.uid) room = `room-${req.query.uid}`;
    
    const state = await getRoomState(room);
    res.json(state.matchIntroState);
});

io.on('connection', async (socket) => {
    let currentRoom = 'scorvix-master-room';
    socket.activeRoom = currentRoom;
    socket.join(currentRoom);

    const query = socket.handshake.query;
    if (query.uid) {
        currentRoom = `room-${query.uid}`;
        socket.leave(socket.activeRoom);
        socket.join(currentRoom);
        socket.activeRoom = currentRoom;
    }

    const roomState = await getRoomState(currentRoom);
    if (roomState.matchIntroState) socket.emit('liveMatchIntro', roomState.matchIntroState);
    if (roomState.ttState) socket.emit('liveScore', roomState.ttState);

    socket.on('joinRoom', async (userData) => {
        let roomName = 'scorvix-master-room';
        if (userData && userData.uid) roomName = `room-${userData.uid}`;

        socket.leave(socket.activeRoom);
        socket.join(roomName);
        socket.activeRoom = roomName;

        const targetState = await getRoomState(roomName);
        if (targetState.matchIntroState) socket.emit('liveMatchIntro', targetState.matchIntroState);
    });

    // Match Intro Real-time Socket Sync
    socket.on('updateMatchIntro', async (data) => {
        let room = socket.activeRoom;
        if (data && data.uid) {
            room = `room-${data.uid}`;
            socket.leave(socket.activeRoom);
            socket.join(room);
            socket.activeRoom = room;
        }
        const state = await getRoomState(room);
        state.matchIntroState = data;
        io.to(room).emit('liveMatchIntro', data);

        if (data && data.uid) {
            db.collection("scorvix").doc(data.uid).set({ matchIntroState: data }, { merge: true }).catch(err => console.log("DB update error:", err));
        }
    });

    socket.on('disconnect', () => {});
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
