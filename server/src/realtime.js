function createRealtime(io) {
  const requestSockets = new Map();
  const socketRequests = new Map();

  io.on("connection", (socket) => {
    const role = socket.handshake.auth?.role;
    if (role === "volunteer") {
      socket.join("volunteers");
      io.emit("volunteer_online", { socketId: socket.id });
    }

    socket.on("disconnect", () => {
      for (const requestId of socketRequests.get(socket.id) || []) {
        if (requestSockets.get(requestId) === socket.id) {
          requestSockets.delete(requestId);
        }
      }
      socketRequests.delete(socket.id);

      if (role === "volunteer") {
        io.emit("volunteer_offline", { socketId: socket.id });
      }
    });
  });

  return {
    watchRequest(socketId, requestId) {
      if (typeof socketId !== "string" || !io.sockets.sockets.has(socketId)) {
        return;
      }
      requestSockets.set(requestId, socketId);
      const requests = socketRequests.get(socketId) || new Set();
      requests.add(requestId);
      socketRequests.set(socketId, requests);
    },

    publishNewRequest(request) {
      io.to("volunteers").emit("new_request", request);
    },

    publishRequestAccepted(request) {
      const socketId = requestSockets.get(request.id);
      if (socketId) {
        io.to(socketId).emit("request_accepted", request);
        io.to(socketId).emit("request_status", {
          requestId: request.id,
          status: request.status,
          hasVolunteer: Boolean(request.volunteerName),
          volunteerName: request.volunteerName
        });
      }
      requestSockets.delete(request.id);
      io.to("volunteers").emit("request_accepted", request);
    },

    publishRequestCancelled(request) {
      const socketId = requestSockets.get(request.id);
      if (socketId) {
        io.to(socketId).emit("request_cancelled", request);
        io.to(socketId).emit("request_status", {
          requestId: request.id,
          status: request.status,
          hasVolunteer: false,
          volunteerName: null
        });
      }
      requestSockets.delete(request.id);
      io.to("volunteers").emit("request_cancelled", request);
    }
  };
}

module.exports = createRealtime;
