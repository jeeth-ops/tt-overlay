const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);

// CORS enabled for Socket.io to prevent connection blocking on Render
const io = new Server(server, {
    cors: {
        origin: "*", 
        methods: ["GET", "POST"]
    }
});

// Yeh line ensure karti hai ki CSS, images, ya extra files sahi se load ho
app.use(express.static(__dirname));

// POST data (JSON) ko read karne ke liye zaroori hai
app.use(express.json());

// ----------------- PURANE ROUTES (JAISE THE WAISE) -----------------

// 1. Home Page (Brand Name & Sports Button ke liye)
app.get('/', (req, res) => {
    res.sendFile(__dirname + '/index.html');
});

// 2. Templates Page (Table Tennis templates dikhane ke liye)
app.get('/tt-templates', (req, res) => {
    res.sendFile(__dirname + '/tt-templates.html');
});

// 3. Control Panel Page (Aapka purana panel jahan se score update hoga)
app.get('/tt-panel', (req, res) => {
    res.sendFile(__dirname + '/tt-panel.html');
});

// 4. Overlay Page (OBS/vMix ke stream par dikhane ke liye)
app.get('/overlay', (req, res) => {
    res.sendFile(__dirname + '/overlay.html');
});


// ----------------- NAYE FOOTBALL ROUTES & SOCKETS -----------------

// Football Templates Page route
app.get('/football-templates', (req, res) => {
    res.sendFile(__dirname + '/football-templates.html');
});

// Football Control Panel route
app.get('/football-panel', (req, res) => {
    res.sendFile(__dirname + '/football-panel.html');
});

// Football Overlay route (OBS/vMix ke liye)
app.get('/football-overlay', (req, res) => {
    res.sendFile(__dirname + '/football-overlay.html');
});


// ----------------- ROOM-WISE STATE STORAGE (100% ISOLATED) -----------------
let roomStates = {};

function getRoomState(room) {
    if (!roomStates[room]) {
        roomStates[room] = {
            ttState: null,
            footballState: null,
            ttData: {
                ltTitle: "MATCH HIGHLIGHT",
                ltText: "Announcement text goes here",
                ltVisible: false
            }
        };
    }
    return roomStates[room];
}

// 5. Lower Third Overlay file ka route (OBS ke liye)
app.get('/tt-lowerthird', (req, res) => {
    res.sendFile(__dirname + '/tt-lowerthird.html');
});

// 6. Lower Third Control Panel ka route
app.get('/tt-lowerthird-panel', (req, res) => {
    res.sendFile(__dirname + '/tt-lowerthird-panel.html');
});

// 7. Lower Third Data Fetch API (Overlay ke liye)
app.get('/api/tt-data', (req, res) => {
    let room = 'scorvix-master-room';
    if (req.query.room) {
        room = req.query.room;
    } else if (req.query.uid) {
        room = `room-${req.query.uid}`;
    }
    const state = getRoomState(room);
    res.json(state.ttData);
});

// 8. Lower Third Data Update API (Control Panel ke liye)
app.post('/api/update-tt-data', (req, res) => {
    const room = req.body.room || 'scorvix-master-room';
    const state = getRoomState(room);
    
    if (req.body.ltTitle !== undefined) state.ttData.ltTitle = req.body.ltTitle;
    if (req.body.ltText !== undefined) state.ttData.ltText = req.body.ltText;
    if (req.body.ltVisible !== undefined) state.ttData.ltVisible = req.body.ltVisible;
    
    res.json({ success: true, ttData: state.ttData });
});


// Socket.io Connection with Strict Room Isolation
io.on('connection', (socket) => {
    console.log('Client connected:', socket.id);

    let currentRoom = 'scorvix-master-room';
    socket.activeRoom = currentRoom;
    socket.join(currentRoom);

    // Agar overlay URL me ?uid=XYZ pass kiya gaya ho (vMix/OBS ke liye)
    const query = socket.handshake.query;
    if (query.uid) {
        currentRoom = `room-${query.uid}`;
        socket.leave(socket.activeRoom);
        socket.join(currentRoom);
        socket.activeRoom = currentRoom;
        console.log(`Overlay socket ${socket.id} joined query room: ${currentRoom}`);
    }

    // Turant latest state bhej do agar is room ki state saved hai
    const roomState = getRoomState(currentRoom);
    if (roomState.footballState) {
        socket.emit('liveFootballScore', roomState.footballState);
    }
    if (roomState.ttState) {
        socket.emit('liveScore', roomState.ttState);
    }

    // Panel se joinRoom event aane par room properly assign karein
    socket.on('joinRoom', (userData) => {
        let roomName = 'scorvix-master-room';

        if (userData && userData.uid) {
            roomName = `room-${userData.uid}`; 
        }

        socket.leave(socket.activeRoom);
        socket.join(roomName);
        socket.activeRoom = roomName;
        console.log(`Socket ${socket.id} switched to secure room: ${roomName}`);

        const targetState = getRoomState(roomName);
        if (targetState.ttState) {
            socket.emit('liveScore', targetState.ttState);
        }
        if (targetState.footballState) {
            socket.emit('liveFootballScore', targetState.footballState);
        }
    });

    // Table Tennis Live Score (Room Isolated) - Handling both updateScore and liveScore securely
    socket.on('updateScore', (data) => {
        const room = socket.activeRoom || 'scorvix-master-room';
        const state = getRoomState(room);
        state.ttState = data;
        io.to(room).emit('liveScore', data);
    });

    socket.on('liveScore', (data) => {
        const room = socket.activeRoom || 'scorvix-master-room';
        const state = getRoomState(room);
        state.ttState = data;
        io.to(room).emit('liveScore', data);
    });

    // FOOTBALL: Live Score & State Sync (Room Isolated)
    socket.on('liveFootballScore', (data) => {
        const room = socket.activeRoom || 'scorvix-master-room';
        const state = getRoomState(room);
        state.footballState = data;
        io.to(room).emit('liveFootballScore', data);
    });

    socket.on('disconnect', () => {
        console.log('Client disconnected:', socket.id);
    });
});

// Server start karne ke liye
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
