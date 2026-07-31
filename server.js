const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

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

// --- NEW MATCH INTRO ROUTES ---
app.get('/tt-matchintro', (req, res) => {
    res.sendFile(__dirname + '/tt-matchintro.html');
});

app.get('/tt-matchintro-panel', (req, res) => {
    res.sendFile(__dirname + '/tt-matchintro-panel.html');
});
// -----------------------------

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

app.get('/tt-lowerthird', (req, res) => {
    res.sendFile(__dirname + '/tt-lowerthird.html');
});

app.get('/tt-lowerthird-panel', (req, res) => {
    res.sendFile(__dirname + '/tt-lowerthird-panel.html');
});

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

app.post('/api/update-tt-data', (req, res) => {
    const room = req.body.room || 'scorvix-master-room';
    const state = getRoomState(room);
    
    if (req.body.ltTitle !== undefined) state.ttData.ltTitle = req.body.ltTitle;
    if (req.body.ltText !== undefined) state.ttData.ltText = req.body.ltText;
    if (req.body.ltVisible !== undefined) state.ttData.ltVisible = req.body.ltVisible;
    
    res.json({ success: true, ttData: state.ttData });
});

io.on('connection', (socket) => {
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
        console.log(`Overlay socket ${socket.id} joined query room: ${currentRoom}`);
    }

    const roomState = getRoomState(currentRoom);
    if (roomState.footballState) {
        socket.emit('liveFootballScore', roomState.footballState);
    }
    if (roomState.ttState) {
        socket.emit('liveScore', roomState.ttState);
    }

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

    socket.on('updateScore', (data) => {
        let room = socket.activeRoom;
        if (data && data.uid) {
            room = `room-${data.uid}`;
            socket.leave(socket.activeRoom);
            socket.join(room);
            socket.activeRoom = room;
        }
        const state = getRoomState(room);
        state.ttState = data;
        io.to(room).emit('liveScore', data);
    });

    socket.on('liveScore', (data) => {
        let room = socket.activeRoom;
        if (data && data.uid) {
            room = `room-${data.uid}`;
            socket.leave(socket.activeRoom);
            socket.join(room);
            socket.activeRoom = room;
        }
        const state = getRoomState(room);
        state.ttState = data;
        io.to(room).emit('liveScore', data);
    });

    socket.on('liveFootballScore', (data) => {
        let room = socket.activeRoom;
        if (data && data.uid) {
            room = `room-${data.uid}`;
            socket.leave(socket.activeRoom);
            socket.join(room);
            socket.activeRoom = room;
        }
        const state = getRoomState(room);
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
