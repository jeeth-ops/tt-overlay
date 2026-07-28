const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

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


// ----------------- NAYE LOWER THIRD ROUTES & DATA -----------------

// Lower Third ka live data store
let ttData = {
    ltTitle: "MATCH HIGHLIGHT",
    ltText: "Announcement text goes here",
    ltVisible: false
};

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
    res.json(ttData);
});

// 8. Lower Third Data Update API (Control Panel ke liye)
app.post('/api/update-tt-data', (req, res) => {
    if (req.body.ltTitle !== undefined) ttData.ltTitle = req.body.ltTitle;
    if (req.body.ltText !== undefined) ttData.ltText = req.body.ltText;
    if (req.body.ltVisible !== undefined) ttData.ltVisible = req.body.ltVisible;
    res.json({ success: true, ttData });
});


// Socket.io Connection (Score live update karne ke liye)
io.on('connection', (socket) => {
    // Table Tennis Live Score
    socket.on('updateScore', (data) => {
        io.emit('liveScore', data);
    });

    // Football Live Score & State Sync
    socket.on('updateFootballScore', (data) => {
        io.emit('liveFootballScore', data);
    });
});

// Server start karne ke liye
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
