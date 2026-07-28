const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(__dirname));

let matchState = {
    p1Name: 'Player 1',
    p2Name: 'Player 2',
    p1Score: 0,
    p2Score: 0,
    p1Sets: 0,
    p2Sets: 0,
    matchFormat: 'bestOf5' // Default Best of 5
};

io.on('connection', (socket) => {
    socket.emit('updateState', matchState);

    socket.on('updateScore', (newState) => {
        matchState = newState;
        io.emit('updateState', matchState);
    });

    socket.on('resetMatch', () => {
        matchState.p1Score = 0;
        matchState.p2Score = 0;
        matchState.p1Sets = 0;
        matchState.p2Sets = 0;
        io.emit('updateState', matchState);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
