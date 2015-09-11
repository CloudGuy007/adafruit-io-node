const mosca = require('mosca'),
      stream = require('stream');

class MQTT extends stream.Duplex {

  constructor() {

    // init stream.Duplex
    super();

    // defaults
    this.mqtt_port = 1883;
    this.http_port = false;
    this.cache = [];
    this.log = false;
    this.broker = false;
    this.auth = false;
    this.ready = false;

    // apply passed config
    Object.assign(this, config || {});

    this.start();

  }

  start() {

    // already started, so return
    if(this.broker)
      return;

    // build broker options
    const broker_options = {
      port: this.mqtt_port
    };

    // serve mqtt over websockets
    if(this.http_port) {
      broker_options.http = {
        port: this.http_port,
        bundle: true
      };
    }

    // init new MQTT broker
    this.broker = new mosca.Server(broker_options, this.onReady.bind(this));

    this.broker.on('published', this.onMessage.bind(this));
    this.broker.on('clientConnected', this.onConnection.bind(this));

  }

  stop(callback) {

    if(this.broker)
      this.broker.close(callback);

  }

  onReady() {

    this.broker.authenticate = this.authenticate.bind(this);
    this.broker.authorizePublish = this.authorizePublish.bind(this);
    this.broker.authorizeSubscribe = this.authorizeSubscribe.bind(this);
    this.ready = true;
    this.emit('ready');

    if(this.log)
      this.log.debug('mqtt broker ready');

  }

  onConnection(client) {

    if(this.log)
      this.log.debug('mqtt connection', client.id);

  }

  onMessage(packet, client) {

    // this mqtt packet came from the server
    if(! client)
      return;

    // ignore $SYS messages
    if(/^\$SYS/.test(packet.topic))
      return;

    this.cache.push(packet);
    this.emit('packet', packet);

    if(this.log)
      this.log.debug('mqtt message', packet);

  }

  authenticate(client, username, key, callback) {

    // don't require auth if it hasn't been configured
    if(! this.auth)
      return callback(null, true);

    if(! username && ! key)
      return callback(null, true);

    this.auth.authenticate(username, key, (authorized) => {

      if(authorized)
        client.username = username;

      callback(null, authorized);

    });

  }

  authorizePublish(client, topic, payload, callback) {

    const success = (client.username == topic.split('/')[0]);

    if(this.log)
      this.log.debug(topic, client.username, success);

    callback(null, success);

  }

  authorizeSubscribe(client, topic, callback) {

    topic = topic.split('/');

    const success = (client.username == topic[0]);

    if(this.log)
      this.log.debug(topic, client.username, success);

    // username matches currently logged in user
    if(success)
      return callback(null, true);

    // there should be at least 3 sections of the topic here
    if(topic.length < 3)
      return callback(null, false);

    if(topic[1] === 'dashboard' && topic[4] === 'public')
      return callback(null, true);

    if(! this.auth)
      return false;

    this.auth.isPublic(topic[0], this.topicToType(topic[1]), topic[2])
      .then(pub => {
        callback(null, pub);
      })
      .catch(callback);

  }

  throttled(username, seconds, rate, period) {

    const message = `${seconds} seconds until reset. current limit is
                     ${rate} requests every ${period} seconds.`;

    const packet = {
      topic: `${username}/throttle`,
      payload: message,
      qos: 0,
      retain: true
    };

    this.broker.publish(packet, () => {

      if(this.log)
        this.log.debug('throttle published', username);

    });

  };

  publish(packet) {

    return new Promise((resolve, reject) => {

      this.broker.publish(packet, () => {

        if(this.log)
          this.log.debug('published', packet);

        resolve();

      });

    });

  }

  _read() {

    // wait until we have a new packet
    if(! this.cache.length)
      return this.once('packet', this._read);

    const packet = this.cache.shift(),
          message = this.toMessage(packet);

    if(! message)
      return this.once('packet', this._read);

    if(this.log)
      this.log.debug('read', message);

    this.push(message);

  };

  _write(message, enc, next) {

    if(! this.ready)
      return this.once('ready', this._write.bind(this, message, enc, next));

    if(message.type === 'group')
      let publish = this.publishGroup(message);
    else if(message.type === 'feed')
      let publish = this.publishFeed(message);

    if(! publish)
      return next();

    publish.then(() => {

      if(this.log)
        this.log.debug('write', message);

      next();

    }).catch((e) => {

      if(this.log)
        this.log.error('write error', e.stack || e);

      next();

    });

  }

}

exports = module.exports = MQTT;
