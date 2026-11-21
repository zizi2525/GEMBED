const app = require('../apiServer');

module.exports = (req, res) => {
  return app(req, res);
};
