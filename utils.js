const cluster = require('cluster');
const debug = require('debug');
const _ = require('underscore');

const pckg = require('./package.json');

function loggerBuilder(level, category){
  if (cluster.isWorker) {
    return debug(`${level}:${pckg.name}[${cluster.worker.process.pid}/${cluster.worker.id}]:${category}`);
  }
  return debug(`${level}:${pckg.name}:${category}`);
}

exports.loggerBuilder = {
  'trace': _.partial(loggerBuilder, 'trace'),
  'debug': _.partial(loggerBuilder, 'debug'),
  'info': _.partial(loggerBuilder, 'info'),
  'warn': _.partial(loggerBuilder, 'warn'),
  'error': _.partial(loggerBuilder, 'error')
};
