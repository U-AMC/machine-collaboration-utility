/* global logger */
module.exports = function unplug(self, params) {
  self.fsm.unplug();
  if (self.currentJob) {
    try {
      self.currentJob.cancel();
      self.currentJob = undefined;
    } catch (ex) {
      logger.error('job cancel error', ex);
    }
    self.currentJob = undefined;
  }
  return self.getBot();
};
