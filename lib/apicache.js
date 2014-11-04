var memCache    = require('memory-cache');
var inflection  = require('inflection');
var _           = require('lodash');
var redis       = require('redis');
var bunyan = require('bunyan');
var PrettyStream = require('bunyan-prettystream');
var prettyStdOut = new PrettyStream();
prettyStdOut.pipe(process.stdout);

var t           = {
  seconds:      1000,
  minutes:      60000,
  hours:        3600000,
  days:         3600000 * 24,
  weeks:        3600000 * 24 * 7,
  months:       3600000 * 24 * 30,
  years:        3600000 * 24 * 365
};

function cacheDriver() {
  var driver;
  var client;

  this.setDriver = function(cacheType, driverOpts) {
    driver = cacheType;

    if (driver === 'redis' && _.isEmpty(client)) {
      client = redis.createClient(driverOpts);
    }
  };

  this.get = function(key, callback) {
    if (driver === 'memcache') {
      var reply = memCache.get(key);
      return callback(null, reply);
    }

    client.get(key, function(err, reply) {
      callback(err, JSON.parse(reply));
    });
  };

  this.set = function(key, response, duration) {
    if (driver === 'memcache') {
      memCache.put(key, response, duration);
      return true;
    }

    return client.setex(
      key,
      Math.round(duration / 1000),
      JSON.stringify(response)
    );
  };

  this.del = function(key) {
    if (driver === 'memcache') {
      memCache.del(key);
      return true;
    }

    client.del(key);
    return true;
  };

  this.clearAll = function() {
    if (driver === 'memcache') {
      memCache.clear();
      return true;
    }

    client.flushdb();
    return true;
  };

  return this;
}

function ApiCache() {
  var globalOptions = {
    debug:            false,
    defaultDuration:  3600000,
    enabled:          true,
    driver:           'memcache'
  };

  // default logegr
  var logLevel = process.env.LOG_LEVEL || 'info';
  var log = bunyan.createLogger({
    name: 'apiache',
    level: logLevel,
    streams: [ { level: 'debug', type: 'raw', stream: prettyStdOut } ]
  });

  var index = null;
  var cacheSystem = cacheDriver();
  cacheSystem.setDriver(globalOptions.driver);

  this.clear = function(target) {
    var group = index.groups[target];

    if (group) {
      log.debug('clearing group: ', target);

      _.each(group, function(key) {
        log.debug('clearing key: ', key);
        cacheSystem.del(key);
        index.all = _.without(index.all, key);
      });

      delete index.groups[target];
    } else if (target) {
      log.debug('clearing key: ', target);
      cacheSystem.del(target);
      index.all = _.without(index.all, target);
      _.each(index.groups, function(group, groupName) {
        index.groups[groupName] = _.without(group, target);
        if (!index.groups[groupName].length) {
          delete index.groups[groupName];
        }
      });
    } else {
      log.debug('clearing entire index');
      cacheSystem.clearAll();
      this.resetIndex();
    }

    return this.getIndex();
  };

  this.getIndex = function(group) {
    if (group) {
      return index.groups[group];
    } else {
      return index;
    }
  };

  this.middleware = function cache(duration, middlewareToggle) {

    if (typeof duration === 'string') {
      var split = duration.match(/^(\d+)\s(\w+)$/);

      if (split.length === 3) {
        var len = split[1];
        var unit = inflection.pluralize(split[2]);

        duration = (len || 1) * (t[unit] || 1);
      }
    }

    if (typeof duration !== 'number' || duration === 0) {
      duration = globalOptions.defaultDuration ;
    }
    return function cache(req, res, next) {

      var cached;
      var bypass = !globalOptions.enabled ||
        req.headers['x-apicache-bypass'] ||
        (_.isFunction(middlewareToggle) && !middlewareToggle(req, res));

      if (bypass) {
        if (req.headers['x-apicache-bypass']) {
          log.debug('bypass detected, skipping cache.');
        }
        return next();
      }

      cacheSystem.get(req.url, function(err, reply) {

        if (cached = reply) {
          log.debug('returning cached version of "' + req.url + '"');

          res.statusCode = cached.status;
          res.set(cached.headers);

          return res.send(cached.body);
        } else {
          log.debug('path "' + req.url + '" not found in cache');

          res.realSend = res.send;

          res.send = function(a, b) {
            var responseObj = {
              headers: {
                'Content-Type': 'application/json; charset=utf-8'
              }
            };

            responseObj.status =
              !_.isUndefined(b) ? a : (_.isNumber(a) ? a : res.statusCode);
            responseObj.body =
              !_.isUndefined(b) ? b : (!_.isNumber(a) ? a : null);

            // last bypass attempt
            var bypass2 =
              !cached &&
              !req.headers['x-apicache-bypass'] &&
              responseObj.status < 400;

            if (bypass2) {
              if (globalOptions.debug) {
                if (req.apicacheGroup) {
                  log.debug('group detected: ' + req.apicacheGroup);
                  index.groups[req.apicacheGroup] =
                    index.groups[req.apicacheGroup] || [];
                  index.groups[req.apicacheGroup].push(req.url);
                }

                index.all.push(req.url);
                log.debug('adding cache entry for "' + req.url +
                  '" @ ' + duration + ' milliseconds');
              }

              _.each([ 'Cache-Control', 'Expires' ], function(h) {
                var header = res.get(h);
                if (!_.isUndefined(header)) {
                  responseObj.headers[h] = header;
                }
              });
              cacheSystem.set(req.url, responseObj, duration);
            }

            return res.realSend(responseObj.body);
          };
          next();
        }
      });

    };
  };

  this.options = function(options) {
    if (options) {
      _.extend(globalOptions, options);

      cacheSystem.setDriver(globalOptions.driver, globalOptions.driverOpts);
      if (options.debug) {
        log.level('debug');
      }

      return this;
    } else {
      return globalOptions;
    }
  };

  this.resetIndex = function() {
    index = {
      all:    [],
      groups: {}
    };
  };

  // initialize index
  this.resetIndex();

  return this;
}

module.exports = new ApiCache();
