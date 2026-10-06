const express = require("express");

function createMobileRouter(requestService) {
  const router = express.Router();

  router.post("/request-help", (req, res) => {
    const { userName, type, socketId } = req.body || {};

    if (userName !== undefined && typeof userName !== "string") {
      return res.status(400).json({
        success: false,
        message: "O nome deve ser um texto."
      });
    }
    if (type !== undefined && typeof type !== "string") {
      return res.status(400).json({
        success: false,
        message: "O tipo de ajuda deve ser um texto."
      });
    }
    if (socketId !== undefined && typeof socketId !== "string") {
      return res.status(400).json({
        success: false,
        message: "A conexão em tempo real informada é inválida."
      });
    }

    const request = requestService.create({
      userName: (userName?.trim() || "Pessoa usuária").slice(0, 100),
      type: (type?.trim() || "visual_assistance").slice(0, 100),
      socketId
    });

    return res.status(201).json({
      success: true,
      requestId: request.id,
      status: request.status,
      message: "Seu pedido foi enviado. Estamos procurando um voluntário."
    });
  });

  router.get("/request-status/:id", (req, res) => {
    const request = requestService.findById(req.params.id);
    if (!request) {
      return res.status(404).json({
        success: false,
        requestId: req.params.id,
        status: null,
        hasVolunteer: false,
        volunteerName: null,
        message: "Pedido não encontrado."
      });
    }

    const hasVolunteer = request.status === "accepted" && Boolean(request.volunteerName);
    return res.json({
      success: true,
      requestId: request.id,
      status: request.status,
      hasVolunteer,
      volunteerName: hasVolunteer ? request.volunteerName : null,
      message: statusMessage(request.status, request.volunteerName)
    });
  });

  router.post("/cancel/:id", (req, res) => {
    const result = requestService.cancel(req.params.id);
    if (result.error === "not_found") {
      return res.status(404).json({
        success: false,
        requestId: req.params.id,
        status: null,
        message: "Pedido não encontrado."
      });
    }
    if (result.error === "not_pending") {
      return res.status(409).json({
        success: false,
        requestId: req.params.id,
        status: result.request.status,
        message: "Este pedido não pode mais ser cancelado."
      });
    }

    return res.json({
      success: true,
      requestId: result.request.id,
      status: result.request.status,
      message: "Seu pedido foi cancelado."
    });
  });

  return router;
}

function statusMessage(status, volunteerName) {
  if (status === "accepted") {
    return `${volunteerName || "Um voluntário"} aceitou ajudar você.`;
  }
  if (status === "cancelled") {
    return "Este pedido foi cancelado.";
  }
  return "Seu pedido está aguardando um voluntário.";
}

module.exports = createMobileRouter;
