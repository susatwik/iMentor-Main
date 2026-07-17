// server/services/socketService.js
const { Server } = require("socket.io");
const log = require("../utils/logger");

let io;

/**
 * Initialize Socket.io server
 * @param {object} server - HTTP server instance
 */
function initSocket(server) {
    io = new Server(server, {
        cors: {
            origin: "*", // Adjust in production
            methods: ["GET", "POST"]
        }
    });

    io.on("connection", (socket) => {
        log.info('SYSTEM', `Socket connected: ${socket.id}`);

        socket.on("join", (userId) => {
            if (userId) {
                const roomName = String(userId);
                socket.join(roomName);
                log.info('SYSTEM', `Socket ${socket.id} joined room: ${roomName}`);

                // Confirm join to client
                socket.emit("joined", { room: roomName });
            }
        });

        socket.on("disconnect", () => {
            log.info('SYSTEM', `Socket disconnected: ${socket.id}`);
        });
    });

    return io;
}

/**
 * Send an event to a specific user
 * @param {string} userId - User ID
 * @param {string} event - Event name
 * @param {object} data - Data to send
 */
function emitToUser(userId, event, data) {
    if (io) {
        const roomName = String(userId);
        const clientsInRoom = io.sockets.adapter.rooms.get(roomName);
        const clientCount = clientsInRoom ? clientsInRoom.size : 0;

        io.to(roomName).emit(event, data);
        // log.info('SYSTEM', `Emitted '${event}' to user ${roomName} (${clientCount} clients)`);
    } else {
        log.warn('SYSTEM', "Socket.io not initialized. Cannot emit.");
    }
}

/**
 * Get the Socket.io instance
 */
function getIO() {
    return io;
}

/**
 * Emit chat streaming events to a specific user
 */
function emitChatStream(userId, type, data) {
    // type can be 'stream_start', 'stream_token', 'stream_end', 'stream_error'
    const eventName = `chat_${type}`;
    emitToUser(userId, eventName, data);
}

module.exports = {
    initSocket,
    emitToUser,
    emitChatStream,
    getIO
};
