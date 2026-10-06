const express = require("express");

function createAssistantRouter(visionService) {
  const router = express.Router();

  router.post("/vision", async (req, res, next) => {
    try {
      const result = await visionService.describeImage(req.body?.imageDataUrl);
      res.json(result);
    } catch (error) {
      next(error);
    }
  });

  return router;
}

module.exports = createAssistantRouter;
