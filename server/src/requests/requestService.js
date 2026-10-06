class RequestService {
  constructor(repository, realtime) {
    this.repository = repository;
    this.realtime = realtime;
  }

  create({ userName, type, socketId }) {
    const request = this.repository.create({ userName, type });
    this.realtime.watchRequest(socketId, request.id);
    this.realtime.publishNewRequest(request);
    return request;
  }

  list() {
    return this.repository.findAll();
  }

  findById(id) {
    return this.repository.findById(id);
  }

  accept(id, volunteerName) {
    const request = this.repository.findById(id);
    if (!request) {
      return { error: "not_found" };
    }
    if (request.status !== "pending") {
      return { error: "not_pending", request };
    }

    const acceptedRequest = this.repository.update(id, {
      status: "accepted",
      acceptedAt: new Date().toISOString(),
      volunteerName
    });
    this.realtime.publishRequestAccepted(acceptedRequest);
    return { request: acceptedRequest };
  }

  cancel(id) {
    const request = this.repository.findById(id);
    if (!request) {
      return { error: "not_found" };
    }
    if (request.status !== "pending") {
      return { error: "not_pending", request };
    }

    const cancelledRequest = this.repository.update(id, {
      status: "cancelled"
    });
    this.realtime.publishRequestCancelled(cancelledRequest);
    return { request: cancelledRequest };
  }
}

module.exports = RequestService;
