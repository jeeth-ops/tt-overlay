const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Yeh line ensure karti hai ki CSS, images, ya extra files sahi se load ho
app.use(express.static(__dirname));

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

// Socket.io Connection (Score live update karne ke liye)
io.on('connection', (socket) => {
    socket.on('updateScore', (data) => {
        io.emit('liveScore', data);
    });
});

// Server start karne ke liye
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
