const express = require("express");

function createRequestRouter(requestService) {
  const router = express.Router();

  router.post("/", (req, res) => {
    const { userName, type, socketId } = req.body || {};

    if (typeof userName !== "string" || !userName.trim()) {
      return res.status(400).json({ error: "userName é obrigatório." });
    }
    if (typeof type !== "string" || !type.trim()) {
      return res.status(400).json({ error: "type é obrigatório." });
    }
    if (socketId !== undefined && typeof socketId !== "string") {
      return res.status(400).json({ error: "socketId inválido." });
    }

    const request = requestService.create({
      userName: userName.trim().slice(0, 100),
      type: type.trim().slice(0, 100),
      socketId
    });
    return res.status(201).json({ request });
  });

  router.get("/", (_req, res) => {
    res.json({ requests: requestService.list() });
  });

  router.post("/:id/accept", (req, res) => {
    const volunteerName =
      typeof req.body?.volunteerName === "string" && req.body.volunteerName.trim()
        ? req.body.volunteerName.trim().slice(0, 100)
        : "Voluntário";
    const result = requestService.accept(req.params.id, volunteerName);

    if (result.error === "not_found") {
      return res.status(404).json({ error: "Pedido não encontrado." });
    }
    if (result.error === "not_pending") {
      return res.status(409).json({
        error: "Este pedido não está mais disponível.",
        request: result.request
      });
    }
    return res.json({ request: result.request });
  });

  router.post("/:id/cancel", (req, res) => {
    const result = requestService.cancel(req.params.id);

    if (result.error === "not_found") {
      return res.status(404).json({ error: "Pedido não encontrado." });
    }
    if (result.error === "not_pending") {
      return res.status(409).json({
        error: "Este pedido não pode mais ser cancelado.",
        request: result.request
      });
    }
    return res.json({ request: result.request });
  });

  return router;
}

module.exports = createRequestRouter;
