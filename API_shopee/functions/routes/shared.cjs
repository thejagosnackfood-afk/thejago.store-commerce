function wrap(handler, handlers) {
  return async (req, res) => {
    try {
      handlers.prepareRequest(req, res);
      await handler(req, res);
    } catch (error) {
      handlers.handleError(req, res, error);
    }
  };
}

module.exports = { wrap };
