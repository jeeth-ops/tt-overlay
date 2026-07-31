const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const firebase = require('firebase/compat/app');
require('firebase/compat/firestore');

// Initialize Firebase on the server side for robust state persistence & fetching
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
    cors: {
        origin: "*", 
        methods: ["GET", "POST"]
    }
});

app.use(express.static(__dirname));
app.use(express.json());

// Routes
app.get('/', (req, res) => {
    res.sendFile(__dirname + '/index.html');
});

app.get('/tt-templates', (req, res) => {
    res.sendFile(__dirname + '/tt-templates.html');
});

app.get('/tt-panel', (req, res) => {
    res.sendFile(__dirname + '/tt-panel.html');
});

app.get('/overlay', (req, res) => {
    res.sendFile(__dirname + '/overlay.html');
});

app.get('/football-templates', (req, res) => {
    res.sendFile(__dirname + '/football-templates.html');
});

app.get('/football-panel', (req, res) => {
    res.sendFile(__dirname + '/football-panel.html');
});

app.get('/football-overlay', (req, res) => {
    res.sendFile(__dirname + '/football-overlay.html');
});

// --- MATCH INTRO ROUTES ---
app.get('/tt-matchintro', (req, res) => {
    res.sendFile(__dirname + '/tt-matchintro.html');
});

app.get('/tt-matchintro-panel', (req, res) => {
    res.sendFile(__dirname + '/tt-matchintro-panel.html');
});

// --- LOWER THIRD ROUTES ---
app.get('/tt-lowerthird', (req, res) => {
    res.sendFile(__dirname + '/tt-lowerthird.html');
});

app.get('/tt-lowerthird-panel', (req, res) => {
    res.sendFile(__dirname + '/tt-lowerthird-panel.html');
});

let roomStates = {};

// Asynchronous helper to get room state, fetching from Firestore if not in memory
async function getRoomState(room) {
    if (!roomStates[room]) {
        roomStates[room] = {
            // --- CENTRALIZED MASTER STATE FOR TABLE TENNIS ---
            ttState: {
                tourneyTitle: "TABLE TENNIS SUPER LEAGUE MAHARASHTRA 2025",
                matchFormat: "bestOf5",
                matchCategory: "Mixed Doubles",
                teamMatchup: "SCL vs KB",
                winner: "PHANTOM STARS WON THE MATCH",
                p1Name: "PHANTOM STARS", 
                p2Name: "MUMBAI MOZARTT", 
                p1Score: 0, 
                p2Score: 0, 
                p1Sets: 0, 
                p2Sets: 0, 
                server: 1, 
                img1: "", 
                img2: "", 
                state: "score-in",
                setsHistory: [], 
                standings: [
                    { team: "PHANTOM STARS", ties: 5, tiesWon: 5, gamesPlayed: 135, matchesWon: 28, gamesWon: 77, points: 77 },
                    { team: "MUMBAI MOZARTT", ties: 5, tiesWon: 1, gamesPlayed: 135, matchesWon: 23, gamesWon: 68, points: 68 },
                    { team: "PBG PUNE JAGUARS", ties: 5, tiesWon: 3, gamesPlayed: 135, matchesWon: 21, gamesWon: 68, points: 68 },
                    { team: "CENTURY WARRIORS", ties: 5, tiesWon: 3, gamesPlayed: 135, matchesWon: 21, gamesWon: 66, points: 66 },
                    { team: "PING PANTHERS", ties: 5, tiesWon: 1, gamesPlayed: 135, matchesWon: 22, gamesWon: 64, points: 64 },
                    { team: "BAYSIDE SPINNERS TTC", ties: 5, tiesWon: 1, gamesPlayed: 135, matchesWon: 17, gamesWon: 59, points: 59 }
                ]
            },
            footballState: null,
            matchIntroState: null,
            lowerThirdState: null,
            ttData: {
                ltTitle: "MATCH HIGHLIGHT",
                ltText: "Announcement text goes here",
                ltVisible: false
            }
        };
    }

    // If it's a user specific room, verify and sync state from Firestore if available
    if (room.startsWith('room-')) {
        const uid = room.replace('room-', '');
        try {
            const doc = await db.collection("scorvix").doc(uid).get();
            if (doc.exists) {
                roomStates[room].ttState = { ...roomStates[room].ttState, ...doc.data() };
            }
        } catch (err) {
            console.log("Firestore sync fetch error:", err);
        }
    }

    return roomStates[room];
}

app.get('/api/tt-data', async (req, res) => {
    let room = 'scorvix-master-room';
    if (req.query.room) {
        room = req.query.room;
    } else if (req.query.uid) {
        room = `room-${req.query.uid}`;
    }
    const state = await getRoomState(room);
    res.json(state.ttState);
});

app.post('/api/update-tt-data', async (req, res) => {
    const room = req.body.room || 'scorvix-master-room';
    const state = await getRoomState(room);
    
    // Merge incoming updates into master ttState
    state.ttState = { ...state.ttState, ...req.body };
    io.to(room).emit('liveScore', state.ttState);

    if (room.startsWith('room-')) {
        const uid = room.replace('room-', '');
        db.collection("scorvix").doc(uid).set(state.ttState, { merge: true }).catch(err => console.log("DB update error:", err));
    }

    res.json({ success: true, ttState: state.ttState });
});

io.on('connection', async (socket) => {
    console.log('Client connected:', socket.id);

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
    if (roomState.footballState) {
        socket.emit('liveFootballScore', roomState.footballState);
    }
    if (roomState.ttState) {
        socket.emit('liveScore', roomState.ttState);
    }

    socket.on('joinRoom', async (userData) => {
        let roomName = 'scorvix-master-room';
        if (userData && userData.uid) {
            roomName = `room-${userData.uid}`; 
        }

        socket.leave(socket.activeRoom);
        socket.join(roomName);
        socket.activeRoom = roomName;

        const targetState = await getRoomState(roomName);
        if (targetState.ttState) {
            socket.emit('liveScore', targetState.ttState);
        }
        if (targetState.footballState) {
            socket.emit('liveFootballScore', targetState.footballState);
        }
    });

    socket.on('updateScore', async (data) => {
        let room = socket.activeRoom;
        if (data && data.uid) {
            room = `room-${data.uid}`;
            socket.leave(socket.activeRoom);
            socket.join(room);
            socket.activeRoom = room;
        }
        const state = await getRoomState(room);
        state.ttState = data;
        io.to(room).emit('liveScore', data);

        if (data && data.uid) {
            db.collection("scorvix").doc(data.uid).set(data, { merge: true }).catch(err => console.log("Firestore sync error:", err));
        }
    });

    socket.on('liveScore', async (data) => {
        let room = socket.activeRoom;
        if (data && data.uid) {
            room = `room-${data.uid}`;
            socket.leave(socket.activeRoom);
            socket.join(room);
            socket.activeRoom = room;
        }
        const state = await getRoomState(room);
        state.ttState = data;
        io.to(room).emit('liveScore', data);

        if (data && data.uid) {
            db.collection("scorvix").doc(data.uid).set(data, { merge: true }).catch(err => console.log("Firestore sync error:", err));
        }
    });

    socket.on('liveFootballScore', async (data) => {
        let room = socket.activeRoom;
        if (data && data.uid) {
            room = `room-${data.uid}`;
            socket.leave(socket.activeRoom);
            socket.join(room);
            socket.activeRoom = room;
        }
        const state = await getRoomState(room);
        state.footballState = data;
        io.to(room).emit('liveFootballScore', data);
    });

    socket.on('disconnect', () => {
        console.log('Client disconnected:', socket.id);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
