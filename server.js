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

    // Table Tennis Live Score - Automatically switch room if data.uid exists
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

    // FOOTBALL: Live Score & State Sync - Automatically switch room if data.uid exists
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
