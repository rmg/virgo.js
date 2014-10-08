var util = require('util');
var stream = require('stream');
var tls = require('tls');
var async = require('async');
var log = require('logmagic').local('virgojs.endpoint');

var _ = require('underscore');

var Connection = require('./connection');
var FanOut = require('./fan_out');
var certs = require('./certs');
var utils = require('./utils');

exports = module.exports = function endpoint(features, options) {
  var ep = new Endpoint(features, options);

  return ep;
};

// longterm TODO: worry about binding without TLS

// TODO: factor Endpoint and Agent to base on same super class?

function Endpoint(features, options) {
  var self = this;
  this.features = features;
  this.options = options || {};
  this.manifest = {};
  this._msg_id = 0;
  this.has_consumer = false;
  this.port = this.options.port || 443;
  this.source = this.options.source || 'endpoint';

  _.each(features, function(f) {
    var meta = f.meta();
    self.manifest[meta.name] = meta;
  });

  this.connections = {};
  this.tls_options = {
    pfx: certs.server_pfx// TODO: pick name?
  };

  // incoming is a FanOut object. It's to merge input from all connections,
  // then fan out to all features.
  this.incoming = null;
}

Endpoint.prototype.run = function(callback) {
  var self = this;

  // JSON parsing is done in connection so it's all objects here
  self.incoming = new FanOut({objectMode: true});

  this.server = tls.createServer(this.tls_options, function(c) {
    // pass accecpted TLS connection into Connection to trigger server mode
    var conn = new Connection(self.manifest, {connection: c, source: self.source});
    conn.connect(function(err) {
      // track connections through agent ID
      self.connections[conn.agent_id] = conn;
      // merge c into self.incoming
      utils.merge_into(conn, self.incoming);
    });
  });

  async.auto({
    bind: function bind(callback) {
      self.server.listen(self.port, function() {
        log.debugf('listening on ${port}', { port: self.port });
        callback();
      });
    },
    init: function init(callback) {
      async.forEach(self.features, function(f, callback) {
        f.init(self, callback); 
      }, callback);
    }
  }, callback);
};

// returns a readable stream. Each feature holds one of these for reading
// incoming objects.
Endpoint.prototype.readable = function() {
  return this.incoming.new_consumer();
};

// returns a writable stream. Each feature holds one of these for writing
// objects out. Objects written into this stream will be sent on a single
// connection, chosen by _choose_connection method.
Endpoint.prototype.writable = function() {
  var writable = stream.Writable({objectMode: true});
  var self = this;
  writable.prototype._write = function(data, encoding, callback) {
    log.debug('_write', { data: data });
    var conn = self._choose_connection(data);
    if (conn) {
      conn.write(data, encoding, callback);
    }
  };
  return writable;
};

Endpoint.prototype._choose_connection = function(data) {
  // choose the correct connection based on agent ID
  return self.connections[data.destination.id];
};

Endpoint.prototype.shutdown = function(callback) {
  var self = this;

  async.series([
    function shutdownFeatures(callback) {
      async.forEach(self.features, function(f, callback) {
        f.shutdown(callback);
      }, callback);
    },

    function closeConnections(callback) {
      self.server._handle.close(callback);
    }
  ], callback);
};

Endpoint.prototype.msg_id = function() {
  return this._msg_id++;
};
