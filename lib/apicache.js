var util = require('util');
var memCache    = require('memory-cache');
var inflection  = require('inflection');
var _           = require('lodash');
var redis       = require('redis');
var async = require('async');

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
  var log;
  var prefix = 'apicache';

  function prefixKey(realKey) {
    return util.format('%s:%s', prefix, realKey);
  }

  this.setPrefix = function(p) {
    prefix = p;
  };

  this.setDriver = function(cacheType, driverOpts) {
    driver = cacheType;

    if (driver === 'redis' && _.isEmpty(client)) {
      client = redis.createClient(driverOpts);
    }
  };

  /**
   * Override the default console logger.
   * @param logger a winston compatible logger
   */
  this.setLogger = function(logger) {
    log = logger;
  };

  this.group = function(group, key, callback) {
    group = prefixKey('group:' + group);
    client.sadd(group, key, callback);
  };

  this.delGroup = function(group, callback) {
    log.verbose('deleting group %s', group);
    group = prefixKey('group:' + group);
    var _this = this;
    client.smembers(group, function(err, results) {
      if (err) {
        return callback(err);
      }
      async.each(results, _this.del, function(err) {
        if (err) {
          log.error(err);
          callback(err);
          return;
        }
        client.del(group, callback);
      })
    });
  };

  this.get = function(key, callback) {
    key = prefixKey(key);
    if (driver === 'memcache') {
      var reply = memCache.get(key);
      return callback(null, reply);
    }

    client.get(key, function(err, reply) {
      if (err) {
        return callback(err);
      }
      callback(undefined, JSON.parse(reply));
    });
  };

  this.set = function(key, response, duration) {
    key = prefixKey(key);
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

  this.del = function(key, callback) {
    log.verbose('deleting key %s', key);
    key = prefixKey(key);
    if (driver === 'memcache') {
      memCache.del(key);
      return true;
    }

    client.del(key, callback);
    return true;
  };

  this.clearAll = function() {
    if (driver === 'memcache') {
      memCache.clear();
      return true;
    }

    var deleteScript =
      'return redis.call("del", unpack(redis.call("keys", ARGV[1])))';
    client.eval([ deleteScript, 0, prefix + ':*' ], function(err) {
      log.error(err);
      return false;
    });
    return true;
  };

  return this;
}

function formatMessage(level, arguments) {
  return [level + ': ' + _(arguments).map(function(argument) {
    return argument.toString();
  }).join('')];
}

function ApiCache() {
  var globalOptions = {
    defaultDuration:  3600000,
    enabled:          true,
    driver:           'memcache',
    // default logger
    log: {
      error: function() {
        console.log.apply(undefined, formatMessage('error', arguments));
      },
      verbose: function() {
        console.log.apply(undefined, formatMessage('verbose', arguments));
      }
    }
  };

  var index = null;
  var cacheSystem = cacheDriver();
  cacheSystem.setDriver(globalOptions.driver);
  cacheSystem.setLogger(globalOptions.log);

  this.clearGroup = function(target) {
    cacheSystem.delGroup(target, function(err) {
      if (err) {
        globalOptions.log.error(err);
      }
    });
  };

  this.clear = function(target) {
    if (target) {
      globalOptions.log.verbose('clearing key: ', target);
      cacheSystem.del(target, function(err) {
        if (err) {
          globalOptions.log.error(err);
        }
      });
    } else {
      log.verbose('clearing entire index');
      cacheSystem.clearAll();
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

      var bypass = !globalOptions.enabled ||
        req.headers['x-apicache-bypass'] ||
        (_.isFunction(middlewareToggle) && !middlewareToggle(req, res));

      if (bypass) {
        if (req.headers['x-apicache-bypass']) {
          globalOptions.log.verbose('bypass detected, skipping cache.');
        }
        return next();
      }

      cacheSystem.get(req.url, function(err, cached) {
        if (err) {
          globalOptions.log.error(err);
          return next();
        }
        if (cached) {
          globalOptions.log.verbose('returning cached version of "' + req.url + '"');

          res.statusCode = cached.status;
          cached.headers['x-apicache'] = 'HIT';
          if (globalOptions.cacheHit) {
            globalOptions.cacheHit(req.url);
          }
          res.set(cached.headers);

          return res.send(cached.body);
        } else {
          globalOptions.log.verbose('path "' + req.url + '" not found in cache');
          if (globalOptions.cacheMiss) {
            globalOptions.cacheMiss(req.url);
          }

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
              !req.headers['x-apicache-bypass'] &&
              responseObj.status < 400;

            if (bypass2) {
              globalOptions.log.verbose('adding cache entry for "' + req.url +
                '" @ ' + duration + ' milliseconds');

              // copy headers
              _.each([ 'Cache-Control', 'Expires' ], function(h) {
                var header = res.get(h);
                if (!_.isUndefined(header)) {
                  responseObj.headers[h] = header;
                }
              });

              if (req.apicacheGroup) {
                globalOptions.log.verbose('group detected: ' + req.apicacheGroup);
                // coerce array and create group for each
                if (! (req.apicacheGroup instanceof Array)) {
                  req.apicacheGroup = [ req.apicacheGroup ];
                }
                async.each(req.apicacheGroup, function(group, cb) {
                  cacheSystem.group(group, req.url, cb);
                }, function(err) {
                  if (err) { globalOptions.log.error(err); return;}
                  cacheSystem.set(req.url, responseObj, duration);
                });
              } else {
                cacheSystem.set(req.url, responseObj, duration);
              }
            }

            res.setHeader('x-apicache', 'MISS');
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
      cacheSystem.setLogger(globalOptions.log);
      if (options.prefix) {
        cacheSystem.setPrefix(options.prefix);
      }

      return this;
    } else {
      return globalOptions;
    }
  };


  return this;
}

module.exports = new ApiCache();
