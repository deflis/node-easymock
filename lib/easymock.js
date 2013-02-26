/*global require:true, exports:true, __dirname:true, process:true */
var express = require('express');
var fs = require('fs');
var url = require('url');
var ejs = require('ejs');
var httpProxy = require('http-proxy');
var _ = require('underscore');
require('broware');

exports.version = '0.1.6';

function MockServer(options) {
  this.options = options;
  this.ensureOptions();
}

MockServer.prototype.start = function() {
  this.startMock();
  this.startProxy();
  if (this.options.log_enabled) {
    var serverUrl = 'http://localhost:' + this.options.port;
    console.log('Server running on ' + serverUrl);
    console.log('Server running on ' + serverUrl + '/_documentation/');
  }
};

MockServer.prototype.stop = function() {
  this.mock_server.close();
  this.proxy_server.close();
};

MockServer.prototype.ensureOptions = function() {
  if (!this.options) {
    this.options = {};
  }
  if (this.options.log_enabled === undefined) {
    this.options.log_enabled = true;
  }
  this.options.port = this.options.port || 3000;
  this.options.path = this.options.path || process.cwd();
  this.options.config = this.options.config || this.options.path + '/config.json';

  // Use default config if none is provided
  if (!fs.existsSync(this.options.config)) {
    this.options.config = __dirname + '/config.json';
  }
};


MockServer.prototype.readConfig = function() {
  var now = new Date().getTime();
  var PARAM_MATCHER = {
      segment: '([^/]+)',
      alnum: '([0-9a-zA-Z]+)',
      any: '(.+)',
      alpha: '([a-zA-Z]+)',
      num: '([0-9]+)'
  };
  if (!this.config_last_read || this.config_last_read < now - 2000) {
    this.config_last_read = now;
    try {
      var config = JSON.parse(fs.readFileSync(this.options.config, 'utf8'));
      if (config.routes) {
        var regexp = /:([a-zA-Z_]*)(:[a-z]+)?/g;
        config.routes = _.map(config.routes, function(route) {
          var match;
          var params = [];
          var _route = route;
          while (match = regexp.exec(route)) {
            var matchList = match[0].split(':');
            params.push(matchList[1]);
            var matcher = matchList[2] || 'segment';
            _route = _route.replace(new RegExp(match[0], 'g'), PARAM_MATCHER[matcher]);
          }
          return {
            route: route.replace(regexp, '*'),
            matcher: new RegExp('^' + _route.replace(/\//g, '\\/') + '$'),
            path: route.replace(regexp, '$1'),
            params: params
          };
        });
      }
      this.config = config;
    }
    catch (e) {
      console.log(e);
      console.log("config file: " + this.options.config + "\n");
      this.config = {};
    }
  }
  return this.config;
};

//////////////
// MOCK SERVER
//////////////
MockServer.prototype.startMock = function() {
  var app = express();
  app.set('mock', this);
  app.set('views', __dirname + '/views');
  app.set('view engine', 'jade');
  if (this.readConfig().cors) {
    app.use(this.allowCrossDomain);
  }
  app.use('/_documentation', express.static(__dirname + '/static'));
  app.get('/_documentation/', this.getApiDocumentation);
  app.get('*', this.handleAnyRequest);
  app.post('*', this.handleAnyRequest);
  app.delete('*', this.handleAnyRequest);
  app.put('*', this.handleAnyRequest);
  this.mock_server = app.listen(this.options.port + 1);
};

MockServer.prototype.startProxy = function() {
  var self = this;
  this.proxy_server = httpProxy.createServer(function (req, res, proxy) {
    var reqUrl = url.parse(req.url);
    if (self.options.log_enabled) {
      console.log('Request: ' + req.method + ' ' + reqUrl.pathname);
    }

    var simulatedLag = self.readConfig()['simulated-lag'] || 0;
    var buffer = httpProxy.buffer(req);
    if (self.options.log_enabled) {
      if (self.shouldProxy(req)) {
        console.log('==> Proxy');
      } else {
        console.log('==> ' + self.getRequestInfo(req).file);
      }
    }

    setTimeout(function () {
      if (self.shouldProxy(req)) {
        var parsedUrl = url.parse(self.readConfig().proxy.server);
        req.headers.host = parsedUrl.hostname;
        proxy.proxyRequest(req, res, {
          host: parsedUrl.hostname,
          port: 80,
          buffer: buffer
        });
      } else {
        proxy.proxyRequest(req, res, {
          host: 'localhost',
          port: self.options.port + 1,
          buffer: buffer
        });
      }
    }, simulatedLag);
  }).listen(this.options.port);
};

MockServer.prototype.shouldProxy = function(req) {
  var config = this.readConfig();
  if (config.proxy) {
    var defaultProxy = config.proxy['default'] || false;
    if (config.proxy.calls && config.proxy.calls[url.parse(req.url).pathname] !== undefined) {
      var entry = config.proxy.calls[url.parse(req.url).pathname];
      if (typeof(entry) === 'object') {
        if (typeof(entry[req.method.toLowerCase()]) === 'boolean') {
          return entry[req.method.toLowerCase()];
        }
        return defaultProxy;
      } else if (typeof(entry) === 'boolean') {
        return entry;
      }
    } else {
      return defaultProxy;
    }
  } else {
    return false;
  }
};

MockServer.prototype.allowCrossDomain = function(req, res, next) {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET,PUT,POST,DELETE');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  // intercept OPTIONS method
  if ('OPTIONS' === req.method) {
    res.send(200);
  }
  else {
    next();
  }
};

MockServer.prototype.handleAnyRequest = function(req, res){
  var mock = res.app.set('mock');
  var info = mock.getRequestInfo(req);
  if (!fs.existsSync(info.file)) {
    var staticFile = mock.options.path + url.parse(req.url).pathname;
    if (fs.existsSync(staticFile)) {
      return res.sendfile(staticFile);
    } else {
      return res.send(404);
    }
  }
  var data = mock.readFile(info.file, {params: info.params, headers: info.headers, query: info.query});
  var body = data.response.body;
  if (mock.readConfig().jsonp && (req.param('callback') || req.param('jsonp'))) {
    var functionName = req.param('callback') || req.param('jsonp');
    res.setHeader('Content-Type', 'application/javascript');
    body = functionName + '(' + JSON.stringify(JSON.parse(body)) + ');';
  }

  data.response.headers['Cache-Control'] = data.response.headers['Cache-Control'] || 'no-cache';
  res.set(data.response.headers);
  if (data.response.static) {
    staticFile = mock.options.path + '/_static/' + data.response.static;
    if (fs.existsSync(staticFile)) {
      res.status(data.response.status);
      res.sendfile(staticFile);
    }
    else {
      res.send(404);
    }
  }
  else {
    res.status(data.response.status);
    res.send(body);
  }
};

// getRequestInfo(req)
// getRequestInfo(method, path)
MockServer.prototype.getRequestInfo = function(arg1, arg2) {
  var method, pathname, query, headers;
  if (typeof(arg1) === 'object') {
    var reqUrl = url.parse(arg1.url);
    pathname = reqUrl.pathname;
    if (pathname.substr(-5) === '.json') {
      pathname = pathname.substr(0, pathname.length - 5);
    }
    method = arg1.method.toLowerCase();
    query = arg1.query;
    headers = arg1.headers;
  } else {
    method = arg1.toLowerCase();
    pathname = arg2;
  }

  var info = {};
  info.file = this.options.path + pathname;
  var config = this.readConfig();
  if (config && config.routes) {
    for (var i = 0; i < config.routes.length; i++) {
      var route = config.routes[i];
      var match = route.matcher.exec(pathname);
      if (match) {
        info.file = this.options.path + route.path;
        info.params = info.params || {};
        info.route = route;
        for (var j = 1; j < match.length; j++) {
          var paramName = route.params[j-1];
          info.params[paramName] = match[j];
        }
        break;
      }
    }
  }
  info.file = info.file + '_' + method + '.json';
  info.query = query;
  info.headers = headers;
  return info;
};

MockServer.prototype.readFile = function(file, options) {
  var data = fs.readFileSync(file, 'utf8');
  var self = this;
  var config = self.readConfig();
  var isDocumentation = options.documentation || false;

  options.vars = config.variables;
  options.load = function (templateName, params) {
    var templateFile = self.options.path + '/_templates/' + templateName + '.json';
    var newOptions = options;
    newOptions.params = _.extend(options.params || {}, params);
    return self.readFile(templateFile, newOptions).response.body;
  };

  try {
      data = ejs.render(data, options).trimRight();
  } catch(e) {
      if (! isDocumentation) {
          console.log(e);
      }
  }

  var input = [];
  var output = [];
  var description = [];
  var status = 200;
  var headers = {};
  var staticFile = "";
  data = data.replace(/^(<|>|#) .*[\r\n]*/gm, function(item) {
    item = item.trimRight();
    if (item.indexOf('#') === 0) {
      description.push(item.substr(2));
    } else if (item.indexOf('>') === 0) {
      input.push(item.substr(2));
    } else {
      output.push(item.substr(2));
      switch(item.substr(2,7)) {
        case '@status':
          status = item.substr(10);
          break;
        case '@header':
          var pos = item.indexOf(':');
          var name = item.substr(10, pos-10);
          var value = item.substr(pos + 2);
          headers[name] = value;
          break;
        case '@static':
          staticFile = item.substr(10);
          break;
      }
    }
    return '';
  });

  if (self.options.log_enabled) {
    console.log("OUTPUT: " + (file.length>40 ? "..." : "") + file.substr(-40) + "\n" + data + "\nEND\n");
  }

  return {
    description: description.join('\n'),
    input: input,
    output: output,
    response: {
      status: status,
      headers: headers,
      body: data,
      static: staticFile
    }
  };
};

// TODO refactor this (maybe own class for documentation generation based on a MockServer)
MockServer.prototype.getApiDocumentationJson = function(callback) {
  var that = this;

  var walk = function(dir, done) {
    var results = [];
    fs.readdir(dir, function(err, list) {
      if (err) { return done(err); }
      var i = 0;
      (function next() {
        var file = list[i++];
        if (!file) { return done(null, results); }
        file = dir + '/' + file;
        fs.stat(file, function(err, stat) {
          if (stat && stat.isDirectory()) {
            walk(file, function(err, res) {
              results = results.concat(res);
              next();
            });
          } else {
            results.push(file);
            next();
          }
        });
      })();
    });
  };

  var getCallMethod = function(file) {
    if (~file.indexOf('_get.json')) {
        return 'GET';
      }
      if (~file.indexOf('_post.json')) {
        return 'POST';
      }
      if (~file.indexOf('_put.json')) {
        return 'PUT';
      }
      if (~file.indexOf('_delete.json')) {
        return 'DELETE';
      }
      return undefined;
  };

  var folder = this.options.path;
  walk(folder, function(err, results) {
    results = _.filter(results, function(file) {
      if (getCallMethod(file)) {
        return true;
      }
      return false;
    });
    results = _.map(results, function(file) {
      var method = getCallMethod(file);
      var path = file.substr(folder.length, file.lastIndexOf('_') - folder.length);
      var requestInfo = that.getRequestInfo(method, path);
      if (requestInfo && requestInfo.route) {
        path = requestInfo.route.route;
        for (var i = 0; i < requestInfo.route.params.length; i++) {
          var key = requestInfo.route.params[i];
          path = path.replace('*', ':' + requestInfo.route.params[i]);
          requestInfo.params[key] = 1;
        }
      }
      var callInfo = that.readFile(requestInfo.file, {
          params: requestInfo.params,
          headers: requestInfo.headers,
          query: requestInfo.query,
          documentation: true
      });
      return {
        method: method,
        path: path,
        description: callInfo.description,
        input: callInfo.input,
        output: callInfo.output,
        response: callInfo.response.body
      };
    });
    var getWeightForMethod = function(method) {
      var m = method.toLowerCase();
      if (m === 'get') {
        return 0;
      } else if (m === 'post') {
        return 1;
      } else if (m === 'put') {
        return 2;
      } else if (m === 'delete') {
        return 3;
      } else {
        return 999;
      }
    };
    results = _.sortBy(results, function(item) { return item.path + '/' + getWeightForMethod(item.method); } );

    callback(null, results);
  });
};

MockServer.prototype.getApiDocumentation = function(req, res) {
  function getDocumentation() {
    res.app.set('mock').getApiDocumentationJson(function(err, apiDocumentation) {
      if (err) { return res.send(400, err); }
      apiDocumentation = _.map(apiDocumentation, function(item) {
        item.classes = item.method.toLowerCase();
        return item;
      });
      getDocumentationHtml(apiDocumentation);
    });
  }
  function getDocumentationHtml(documentation) {
    res.render('documentation', {calls: documentation});
  }
  getDocumentation();
};

exports.MockServer = MockServer;
