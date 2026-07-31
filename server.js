const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
    cors: {
        origin: "*", 
        methods: ["GET", "POST"]
    }
});

app.use(express.static(__dirname));
app.use(express.json({ limit: '50mb' })); 
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// Routes
app.get('/', (req, res) => res.sendFile(__dirname + '/index.html'));
app.get('/tt-templates', (req, res) => res.sendFile(__dirname + '/tt-templates.html'));
app.get('/tt-panel', (req, res) => res.sendFile(__dirname + '/tt-panel.html'));
app.get('/overlay', (req, res) => res.sendFile(__dirname + '/overlay.html'));
app.get('/football-templates', (req, res) => res.sendFile(__dirname + '/football-templates.html'));
app.get('/football-panel', (req, res) => res.sendFile(__dirname + '/football-panel.html'));
app.get('/football-overlay', (req, res) => res.sendFile(__dirname + '/football-overlay.html'));
app.get('/tt-lowerthird', (req, res) => res.sendFile(__dirname + '/tt-lowerthird.html'));
app.get('/tt-lowerthird-panel', (req, res) => res.sendFile(__dirname + '/tt-lowerthird-panel.html'));

// --- DYNAMIC TEMPLATE SYSTEM ---
const templatesDB = path.join(__dirname, 'templates.json');

if (!fs.existsSync(templatesDB)) {
    fs.writeFileSync(templatesDB, JSON.stringify([]));
}

app.get('/api/get-sports', (req, res) => {
    const data = JSON.parse(fs.readFileSync(templatesDB, 'utf8'));
    res.json(data);
});

app.post('/api/create-template', (req, res) => {
    const { sportName, sportIcon, panelCode, overlayCode } = req.body;
    const slug = sportName.toLowerCase().replace(/[^a-z0-9]+/g, '-');

    fs.writeFileSync(path.join(__dirname, `${slug}-panel.html`), panelCode);
    fs.writeFileSync(path.join(__dirname, `${slug}-overlay.html`), overlayCode);
    
    const landingPageCode = `
    <!DOCTYPE html>
    <html>
    <head><title>${sportName} Controls</title></head>
    <body style="background:#0f172a; color:white; font-family:sans-serif; text-align:center; padding-top:100px;">
        <h1>${sportName} Dashboard</h1>
        <a href="/${slug}-panel.html" style="color:#f43f5e; font-size:20px; display:block; margin:20px;">🎮 Open Controller Panel</a>
        <a href="/${slug}-overlay.html" style="color:#10b981; font-size:20px; display:block; margin:20px;">📺 Open OBS Overlay</a>
        <br><br><a href="/" style="color:#94a3b8;">Back to Home</a>
    </body>
    </html>
    `;
    fs.writeFileSync(path.join(__dirname, `${slug}-templates.html`), landingPageCode);

    let templates = JSON.parse(fs.readFileSync(templatesDB, 'utf8'));
    const existingIndex = templates.findIndex(t => t.slug === slug);
    
    if (existingIndex >= 0) {
        templates[existingIndex].name = sportName;
        templates[existingIndex].icon = sportIcon || templates[existingIndex].icon;
    } else {
        templates.push({ name: sportName, icon: sportIcon || '🎯', slug: slug });
    }
    
    fs.writeFileSync(templatesDB, JSON.stringify(templates));
    res.json({ success: true, message: "Template deployed successfully!" });
});

app.post('/api/delete-template', (req, res) => {
    const { slug } = req.body;
    if (!slug) return res.status(400).json({ success: false, message: "Slug is required" });

    try {
        const filesToDelete = [
            path.join(__dirname, `${slug}-panel.html`),
            path.join(__dirname, `${slug}-overlay.html`),
            path.join(__dirname, `${slug}-templates.html`)
        ];
        filesToDelete.forEach(file => {
            if (fs.existsSync(file)) fs.unlinkSync(file);
        });

        let templates = JSON.parse(fs.readFileSync(templatesDB, 'utf8'));
        templates = templates.filter(t => t.slug !== slug);
        fs.writeFileSync(templatesDB, JSON.stringify(templates));

        res.json({ success: true, message: "Template deleted successfully!" });
    } catch (err) {
        console.error("Error deleting template:", err);
        res.status(500).json({ success: false, message: "Server error while deleting" });
    }
});
// --- END DYNAMIC SYSTEM ---

let roomStates = {};

function getRoomState(room) {
    if (!roomStates[room]) {
        roomStates[room] = {
            ttState: null,
            footballState: null,
            badmintonState: null,
            ttData: {
                ltTitle: "MATCH HIGHLIGHT",
                ltText: "Announcement text goes here",
                ltVisible: false
            }
        };
    }
    return roomStates[room];
}

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
    const room = req.body.room || (req.body.uid ? `room-${req.body.uid}` : 'scorvix-master-room');
    const state = getRoomState(room);
    
    if (req.body.ltTitle !== undefined) state.ttData.ltTitle = req.body.ltTitle;
    if (req.body.ltText !== undefined) state.ttData.ltText = req.body.ltText;
    if (req.body.ltVisible !== undefined) state.ttData.ltVisible = req.body.ltVisible;
    
    io.to(room).emit('updateLowerThird', state.ttData);
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
    }

    const roomState = getRoomState(currentRoom);
    if (roomState.footballState) socket.emit('liveFootballScore', roomState.footballState);
    if (roomState.ttState) socket.emit('liveScore', roomState.ttState);
    if (roomState.badmintonState) socket.emit('liveBadmintonScore', roomState.badmintonState);

    socket.on('joinRoom', (userData) => {
        let roomName = 'scorvix-master-room';
        if (userData && userData.uid) {
            roomName = `room-${userData.uid}`; 
        }

        socket.leave(socket.activeRoom);
        socket.join(roomName);
        socket.activeRoom = roomName;

        const targetState = getRoomState(roomName);
        if (targetState.ttState) socket.emit('liveScore', targetState.ttState);
        if (targetState.footballState) socket.emit('liveFootballScore', targetState.footballState);
        if (targetState.badmintonState) socket.emit('liveBadmintonScore', targetState.badmintonState);
    });

    const handleScoreUpdate = (event, stateKey, data) => {
        const room = socket.activeRoom; 
        const state = getRoomState(room);
        state[stateKey] = data;
        io.to(room).emit(event, data);
    };

    socket.on('updateScore', (data) => handleScoreUpdate('liveScore', 'ttState', data));
    socket.on('liveScore', (data) => handleScoreUpdate('liveScore', 'ttState', data));
    socket.on('liveFootballScore', (data) => handleScoreUpdate('liveFootballScore', 'footballState', data));
    socket.on('liveBadmintonScore', (data) => handleScoreUpdate('liveBadmintonScore', 'badmintonState', data));

    socket.on('triggerGoalAnimation', (data) => {
        const room = socket.activeRoom;
        io.to(room).emit('playGoalAnimation', data);
    });

    socket.on('disconnect', () => {
        console.log('Client disconnected cleanup:', socket.id);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
