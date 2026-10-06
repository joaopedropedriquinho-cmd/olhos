const { randomUUID } = require("node:crypto");

class InMemoryRequestRepository {
  constructor() {
    this.requests = new Map();
  }

  create({ userName, type }) {
    const request = {
      id: randomUUID(),
      userName,
      type,
      status: "pending",
      createdAt: new Date().toISOString(),
      acceptedAt: null,
      volunteerName: null
    };

    this.requests.set(request.id, request);
    return { ...request };
  }

  findAll() {
    return [...this.requests.values()]
      .map((request) => ({ ...request }))
      .sort((first, second) => second.createdAt.localeCompare(first.createdAt));
  }

  findById(id) {
    const request = this.requests.get(id);
    return request ? { ...request } : null;
  }

  update(id, changes) {
    const request = this.requests.get(id);
    if (!request) {
      return null;
    }

    const updatedRequest = { ...request, ...changes };
    this.requests.set(id, updatedRequest);
    return { ...updatedRequest };
  }
}

module.exports = InMemoryRequestRepository;
