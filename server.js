const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(__dirname));

app.get('/', (req, res) => {
    res.sendFile(__dirname + '/index.html');
});

app.get('/overlay', (req, res) => {
    res.sendFile(__dirname + '/overlay.html');
});

io.on('connection', (socket) => {
    socket.on('updateScore', (data) => {
        io.emit('liveScore', data);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT);
