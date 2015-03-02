/// <reference path="../typings/tsd.d.ts" />
'use strict';

var pkg = require('../package.json');

import util = require('util');
import path = require('path');
import http = require('http');
import fs = require('fs');
import events = require('events');

import uuid = require('node-uuid');
import redis = require('redis');
import socketio = require('socket.io');
import mkdirp = require('mkdirp');

import png = require('png-async');

import httpUtil = require('./http-util');
import ioUtil = require('./io-util');

export enum EDataMode {
    None = 0,
    FS = 1,
    Redis = 2
}

enum ECollectProvideTarget {
    Clients
}

export interface IServerConfig {
    title?: string;
    canvasWidth?: number;
    canvasHeight?: number;
    layerCount?: number;
    maxPaintLogCount?: number;
    maxChatLogCount?: number;
    dataDir?: string;
    dataFilePrefix?: string;
    redisHost?: string;
    redisPort?: number;
    redisPassword?: string;
    redisKeyPrefix?: string;
    clientDir?: string;
    forwardedHeaderType?: string;
    clientVersion?: string;
}

export interface IDistServerConfig {
    title: string;
    canvasWidth: number;
    canvasHeight: number;
    layerCount: number;
    version: IDistVersion
}

export interface IDistVersion {
    server: string;
    client: string;
}

export interface IDistServer {
    id: string;
}

export interface IDistClient {
    uuid: string;
    name: string;
    server: IDistServer;
}

interface IResources {
    layers: Layer[];
    clients: IClient[];
}

interface IResourceMap {
    client: { [uuid: string]: IClient };
    socket: { [uuid: string]: SocketIO.Socket };
}

interface IServer {
    id: string;
}

interface IClient {
    uuid: string;
    name?: string;
    pin: string;
    remoteAddr?: string;
    isOnline?: boolean;
    server: IServer;
}

interface IRedisMessage {
    server?: IServer;
    client?: IClient;
    target?: ECollectProvideTarget;
    body?: any;
}

interface IIOMessage {
    client: IDistClient
}

interface IChatMessage {
    message: string;
    time: number
}

interface IPaintMessage {
    layerNumber: number;
    mode: string;
    x: number;
    y: number;
    data: Buffer;
}

interface IStrokeMessage {
    points: any[]
}

interface IPointerMessage {
    x: number;
    y: number;
}

interface IIOSystemMessage extends IChatMessage { }
interface IIOChatMessage extends IIOMessage, IChatMessage { }
interface IIOPaintMessage extends IIOMessage, IPaintMessage { }
interface IIOStrokeMessage extends IIOMessage, IStrokeMessage { }
interface IIOPointerMessage extends IIOMessage, IPointerMessage { }

export function createServer(config?: IServerConfig): Server {
    return new Server(config);
}

export class Server extends events.EventEmitter {

    id: string;
    dataMode: EDataMode;

    private io: SocketIO.Server;
    private httpServer: http.Server;
    private redisClient: redis.RedisClient;
    private redisSubscriber: redis.RedisClient;

    private resource: IResources = {
        layers: [],
        clients: []
    };

    private map: IResourceMap = {
        client: {},
        socket: {}
    };

    private interval: any = {};

    constructor(public config: IServerConfig = {}) {
        super();

        // server id
        Object.defineProperty(this, 'id', {
            configurable: false,
            writable: false,
            value: uuid.v4()
        });

        // configuration
        if (!config.title) {
            config.title = 'PaintChat';
        }
        if (!config.canvasWidth) {
            config.canvasWidth = 1920;
        }
        if (!config.canvasHeight) {
            config.canvasHeight = 1080;
        }
        if (!config.layerCount) {
            config.layerCount = 3;
        }
        if (!config.maxPaintLogCount) {
            config.maxPaintLogCount = 2000;
        }
        if (!config.maxChatLogCount) {
            config.maxChatLogCount = 100;
        }
        if (!config.dataFilePrefix) {
            config.dataFilePrefix = 'reichat_';
        }
        if (!config.redisPort) {
            config.redisPort = 6379;
        }
        if (!config.redisKeyPrefix) {
            config.redisKeyPrefix = '';
        }
        if (!config.clientDir) {
            config.clientDir = '';
        }
        if (!config.forwardedHeaderType) {
            config.forwardedHeaderType = '';
        }
        if (!config.clientVersion) {
            config.clientVersion = '0.0.0';
        }

        Object.freeze(this.config);

        // decide the data mode
        var dataMode = EDataMode.None;

        if (config.redisHost) {
            dataMode = EDataMode.Redis;
        } else if (config.dataDir && config.dataDir !== '/dev/null' && config.dataDir !== 'null') {
            dataMode = EDataMode.FS;

            if (fs.existsSync(config.dataDir) === false) {
                mkdirp(config.dataDir, (err) => {
                    if (err) {
                        console.error(err);
                        throw err;
                    }
                });
            }
        }

        Object.defineProperty(this, 'dataMode', {
            configurable: false,
            writable: false,
            value: dataMode
        });

        util.log(util.format('decided data mode: %s', EDataMode[this.dataMode]));

        // prepare the Layers
        this.initLayers();

        // create a HTTP Server
        this.httpServer = http.createServer(this.httpServerRequestListener.bind(this));

        // create a Socket.IO Server
        this.io = socketio(this.httpServer);
        this.io.on('connection', this.ioConnectionListener.bind(this));

        // Redis
        if (this.dataMode === EDataMode.Redis) {
            this.initRedisClients();
        }

        // FS
        if (this.dataMode === EDataMode.FS) {
            this.initFileSystem();
        }

        // finally, get sync.
        this.syncLayers(() => this.emit('ready'));
    }

    listen(port: any, hostname?: string, backlog?: number, callback?: Function): Server {

        this.httpServer.listen(port, hostname, backlog, () => {
            callback.call(this, arguments);
        });

        return this;
    }

    get distributalbeConfig(): IDistServerConfig {
        return {
            title: this.config.title,
            canvasWidth: this.config.canvasWidth,
            canvasHeight: this.config.canvasHeight,
            layerCount: this.config.layerCount,
            version: {
                server: pkg.version,
                client: this.config.clientVersion
            }
        };
    }

    get distributableClients(): IDistClient[] {

        var clients: IDistClient[] = [];

        this.resource.clients.forEach((client) => {

            if (client.isOnline === false) {
                return;
            }

            clients.push({
                server: {
                    id: client.server.id
                },
                uuid: client.uuid,
                name: client.name
            });
        });

        return clients;
    }

    private clientToDistributable(client: IClient): IDistClient {
        return {
            uuid: client.uuid,
            name: client.name,
            server: client.server
        }
    }

    private initLayers(): void {

        var i: number, layer: Layer;

        for (i = 0; i < this.config.layerCount; i++) {
            layer = new Layer(this.config.canvasWidth, this.config.canvasHeight, i);

            switch (this.dataMode) {
                case EDataMode.FS:
                    layer.path = path.join(this.config.dataDir, [this.config.dataFilePrefix, 'layer', i, '.png'].join(''));
                    break;
                case EDataMode.Redis:
                    layer.path = this.config.redisKeyPrefix + 'layer:' + i;
                    break;
            }

            this.resource.layers.push(layer);
        }
    }

    private syncLayers(done: () => void): void {

        var count = this.resource.layers.length;

        this.resource.layers.forEach((layer) => {

            this.loadLayer(layer, () => {

                --count;

                if (count === 0) {
                    done();
                }
            });
        });
    }

    private loadLayer(layer: Layer, done: () => void): void {

        if (this.dataMode === EDataMode.None) {
            setImmediate(done);
            return;
        }

        var img = new png.Image().on('parsed', (data) => {

            if (img.width !== this.config.canvasWidth || img.height !== this.config.canvasHeight) {
                console.error(util.format('layer#%s data not loaded because canvas size different.', layer.n));
                return;
            }

            data.copy(layer.data);
            layer.emit('update');

            Object.keys(this.io.sockets.connected).forEach((socketId) => {
                this.io.sockets.connected[socketId].disconnect(true);
            });

            util.log(util.format('layer#%s data loaded. %s=%s', layer.n, EDataMode[this.dataMode], layer.path));

            done();
        });

        switch (this.dataMode) {
            case EDataMode.FS:
                if (fs.existsSync(layer.path) === true) {
                    util.log(util.format('layer#%s data found. FS=%s', layer.n, layer.path));

                    fs.createReadStream(layer.path).pipe(img);
                } else {
                    try {
                        img.end();
                    } catch (e) {
                        setImmediate(done);
                    }
                }
                break;
            case EDataMode.Redis:
                this.redisClient.get(new Buffer(layer.path), (err, buffer) => {

                    if (err) {
                        img.end();
                        console.error(err);
                        return;
                    }

                    if (buffer) {
                        util.log(util.format('layer#%s data found. Redis=%s', layer.n, layer.path));

                        img.end(buffer);
                    } else {
                        try {
                            img.end();
                        } catch (e) {
                            setImmediate(done);
                        }
                    }
                });
                break;
        }
    }

    private initFileSystem(): void {

        // observe the change of the Layers, and save.
        this.resource.layers.forEach((layer) => {
            layer.on('change', () => {
                process.nextTick(() => {
                    layer.toPngStream(fs.createWriteStream(layer.path));
                });
            })
        });
    }

    private initRedisClients(): void {

        this.redisClient = redis.createClient(this.config.redisPort, this.config.redisHost, {
            detect_buffers: true,
            auth_pass: this.config.redisPassword || null
        });

        this.redisSubscriber = redis.createClient(this.config.redisPort, this.config.redisHost, {
            auth_pass: this.config.redisPassword || null
        });

        this.redisSubscriber.on('message', this.redisMessageListener.bind(this));

        this.subscribeRedis();

        // observe the change of the Layers, and save.
        this.resource.layers.forEach((layer) => {
            layer.on('change', () => {
                process.nextTick(() => {
                    layer.toPngBuffer((buffer) => {
                        this.redisClient.set(new Buffer(layer.path), buffer);
                    });
                });
            })
        });
    }

    private subscribeRedis(): void {

        var prefix = this.config.redisKeyPrefix;

        this.redisSubscriber.subscribe(prefix + 'collect');
        this.redisSubscriber.subscribe(prefix + 'provide');
        this.redisSubscriber.subscribe(prefix + 'ping');
        this.redisSubscriber.subscribe(prefix + 'pong');
        this.redisSubscriber.subscribe(prefix + 'system');
        this.redisSubscriber.subscribe(prefix + 'chat');
        this.redisSubscriber.subscribe(prefix + 'paint');
        this.redisSubscriber.subscribe(prefix + 'stroke');
        this.redisSubscriber.subscribe(prefix + 'pointer');

        // pinging
        this.interval.redisPinging = setInterval(() => {

            var otherServers = [];
            this.resource.clients.forEach((client) => {

                if (client.server.id !== this.id && otherServers.indexOf(client.server.id) === -1) {
                    otherServers.push(client.server.id);
                }
            });

            if (otherServers.length === 0) {
                return;
            }

            var pongMessageListener = (type: string, json: string) => {

                if (type === this.config.redisKeyPrefix + 'pong') {
                    var data: IRedisMessage = JSON.parse(json);

                    var serverIndex = otherServers.indexOf(data.server.id);
                    if (serverIndex !== -1) {
                        otherServers.splice(serverIndex, 1);
                    }
                }
            };

            this.redisSubscriber.on('message', pongMessageListener);

            setTimeout(() => {

                this.redisSubscriber.removeListener('message', pongMessageListener);

                if (otherServers.length === 0) {
                    return;
                }

                this.resource.clients = this.resource.clients.filter((client) => {
                    return otherServers.indexOf(client.server.id) === -1;
                });

                this.io.emit('clients', this.distributableClients);

                util.log(util.format('server %s has timed-out.', otherServers.join(' and ')));
            }, 6000);
            
            // ping
            setTimeout(() => this.publishRedis('ping'), 1000);
        }, 10000);

        // collect
        setTimeout(() => this.publishRedis('collect', { target: ECollectProvideTarget.Clients }), 3000);
    }

    /* private unsubscribeRedis(): void {

        var prefix = this.config.redisKeyPrefix;

        this.redisSubscriber.unsubscribe(prefix + 'collect');
        this.redisSubscriber.unsubscribe(prefix + 'provide');
        this.redisSubscriber.unsubscribe(prefix + 'ping');
        this.redisSubscriber.unsubscribe(prefix + 'pong');
        this.redisSubscriber.unsubscribe(prefix + 'system');
        this.redisSubscriber.unsubscribe(prefix + 'chat');
        this.redisSubscriber.unsubscribe(prefix + 'paint');
        this.redisSubscriber.unsubscribe(prefix + 'stroke');
        this.redisSubscriber.unsubscribe(prefix + 'pointer');
    } */

    private publishRedis(name: string, data: IRedisMessage = {}): void {

        data.server = {
            id: this.id
        };

        this.redisClient.publish(this.config.redisKeyPrefix + name, JSON.stringify(data));
    }

    private redisMessageListener(type: string, json: string): void {

        var data: IRedisMessage = JSON.parse(json);

        if (data.server.id === this.id) {
            return;
        }

        if (this.config.redisKeyPrefix !== '') {
            type = type.replace(new RegExp('^' + this.config.redisKeyPrefix), '');
        }

        switch (type) {
            case 'ping':
                this.publishRedis('pong');
                break;
            case 'collect':
                if (data.target === ECollectProvideTarget.Clients) {
                    this.publishRedis('provide', {
                        target: ECollectProvideTarget.Clients,
                        body: this.resource.clients.filter((client) => client.server.id === this.id)
                    });
                }
                break;
            case 'provide':
                if (data.target === ECollectProvideTarget.Clients) {
                    this.updateClientsByServer(data.server, <IClient[]>data.body);
                    this.io.emit('clients', this.distributableClients);
                }
                break;
            case 'system':
                this.sendSystemMessage(data.body, data.server);
                break;
            case 'chat':
                this.sendChat(data.client, data.body);
                break;
            case 'paint':
                data.body.data = new Buffer(data.body.data);
                this.sendPaint(data.client, data.body);
                break;
            case 'stroke':
                this.sendStroke(data.client, data.body);
                break;
            case 'pointer':
                this.sendPointer(data.client, data.body);
                break;
        }
    }

    private updateClientsByServer(server: IServer, clients: IClient[]): void {

        var i;

        for (i = 0; i < this.resource.clients.length; i++) {
            if (this.resource.clients[i].server.id === server.id) {
                this.resource.clients.splice(i, 1);
                i--;
            }
        }

        clients.filter((client) => client.server.id === server.id).forEach((client) => {
            this.resource.clients.push(client);
        });
    }

    private httpServerRequestListener(req: http.ServerRequest, res: http.ServerResponse): void {

        var location = httpUtil.stripQueryString(req.url);
        
        res.setHeader('Accept-Ranges', 'none');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Server', 'reichat-server/' + pkg.version);
        res.setHeader('X-Content-Type-Options', 'nosniff');

        if (req.method !== 'GET' && req.method !== 'HEAD') {
            if (req.method === 'OPTIONS') {
                res.writeHead(200, {
                    'Allow': 'HEAD, GET, OPTIONS',
                    'Content-Length': '0'
                });
                res.end();
            } else {
                res.setHeader('Allow', 'HEAD, GET, OPTIONS');
                httpUtil.responseError(res, 405);
            }
        } else if (location === '/config') {
            res.writeHead(200, {
                'Content-Type': 'application/json; charset=utf-8'
            });

            if (req.method === 'HEAD') {
                res.end();
            } else {
                httpUtil.responseJSON(res, this.distributalbeConfig);
            }
        } else if (location === '/canvas') {
            res.writeHead(200, {
                'Content-Type': 'image/png'
            });

            if (req.method === 'HEAD') {
                res.end();
            } else {
                this.canvasToPng().pipe(res);
            }
        } else if (/^\/layers\/[0-9]+$/.test(location) === true) {
            var layerNumber = parseInt(location.match(/^\/layers\/([0-9]+)$/)[1], 10);

            if (layerNumber >= this.config.layerCount) {
                httpUtil.responseError(res, 404);
            } else {
                res.writeHead(200, {
                    'Content-Type': 'image/png'
                });

                if (req.method === 'HEAD') {
                    res.end();
                } else {
                    this.resource.layers[layerNumber].toPngStream(res);
                }
            }
        } else if (req.method === 'HEAD' || req.method === 'GET' || req.method === 'OPTIONS') {
            var filepath = httpUtil.resolveFilepath(this.config.clientDir, location);

            if (this.config.clientDir === '' || fs.existsSync(filepath) === false) {
                httpUtil.responseError(res, 404);
            } else {
                httpUtil.setContentTypeHeaderByFilepath(res, filepath);

                var fstat = fs.statSync(filepath);

                res.writeHead(200, {
                    'Content-Length': fstat.size,
                    'Last-Modified': fstat.mtime.toUTCString(),
                    'X-UA-Compatible': 'IE=edge'
                });

                if (req.method === 'HEAD') {
                    res.end();
                } else {
                    fs.createReadStream(filepath).pipe(res);
                }
            }
        }
    }

    private ioConnectionListener(socket: SocketIO.Socket): void {

        var remoteAddr = ioUtil.getRemoteAddr(socket, ioUtil.EForwardedHeaderType[this.config.forwardedHeaderType]);

        util.log(util.format('%s %s connected.', remoteAddr, socket.id));

        socket.emit('server', {
            id: this.id
        });

        socket.emit('config', this.distributalbeConfig);

        var client: IClient = null;

        socket.once('disconnect', () => {

            if (client !== null) {
                if (client.uuid && this.map.socket[client.uuid]) {
                    delete this.map.socket[client.uuid];
                    client.isOnline = false;
                }

                if (this.dataMode === EDataMode.Redis) {
                    this.publishRedis('provide', {
                        target: ECollectProvideTarget.Clients,
                        body: this.resource.clients.filter((client) => client.server.id === this.id)
                    });
                }

                this.io.emit('clients', this.distributableClients);

                this.sendSystemMessage(util.format('! %s has left.', client.name));

                util.log(util.format('%s %s disconnected. client=%s<%s>', remoteAddr, socket.id, client.name, client.uuid));
            } else {
                util.log(util.format('%s %s disconnected.', remoteAddr, socket.id));
            }
        });

        socket.on('client', (newClient: IClient) => {

            if (client !== null) {
                if (client.uuid && this.map.socket[client.uuid]) {
                    delete this.map.socket[client.uuid];
                    client.isOnline = false;
                }
            }

            if (newClient.uuid && newClient.uuid.length !== 36) {
                return;
            }

            if (!newClient.name || newClient.name.length > 16) {
                return;
            }

            if (newClient.uuid && this.map.client[newClient.uuid] && this.map.client[newClient.uuid].pin === newClient.pin) {
                client = this.map.client[newClient.uuid];

                if (this.map.socket[client.uuid]) {
                    this.map.socket[client.uuid].disconnect(true);
                    delete this.map.socket[client.uuid];
                }
            } else {
                client = {
                    uuid: uuid.v1(),
                    pin: uuid.v4(),
                    server: {
                        id: this.id
                    }
                };
                this.map.client[client.uuid] = client;
                this.resource.clients.push(client);
            }

            client.name = newClient.name;
            client.remoteAddr = remoteAddr;
            client.isOnline = true;

            this.map.socket[client.uuid] = socket;

            socket.emit('client', {
                uuid: client.uuid,
                name: client.name,
                pin: client.pin
            });

            if (this.dataMode === EDataMode.Redis) {
                this.publishRedis('provide', {
                    target: ECollectProvideTarget.Clients,
                    body: this.resource.clients.filter((client) => client.server.id === this.id)
                });
            }

            this.io.emit('clients', this.distributableClients);

            this.sendSystemMessage(util.format('! %s has join.', client.name));

            util.log(util.format('%s %s joined. client=%s<%s>', remoteAddr, socket.id, client.name, client.uuid));
        });

        socket.on('stroke', (stroke) => this.sendStroke(client, stroke));
        socket.on('pointer', (pointer) => this.sendPointer(client, pointer));
        socket.on('paint', (paint) => this.sendPaint(client, paint));
        socket.on('chat', (chat) => this.sendChat(client, chat));
    }

    private canvasToPng(): NodeJS.ReadableStream {

        var i, j, l, x, y, a,
            w = this.config.canvasWidth,
            h = this.config.canvasHeight,
            layers = this.resource.layers;

        var img = new png.Image({
            width: w,
            height: h,
            deflateLevel: 1,// Fastest
            filterType: png.EFilterType.None,
            checkCRC: false
        });
        img.data.fill(255);

        for (i = 0, l = layers.length; i < l; i++) {
            for (y = 0; y < h; y++) {
                for (x = 0; x < w; x++) {
                    j = (w * y + x) << 2;
                    a = layers[i].data[j + 3];

                    img.data[j] = Math.round(((255 - a) / 255 * img.data[j]) + (a / 255 * layers[i].data[j]));
                    img.data[j + 1] = Math.round(((255 - a) / 255 * img.data[j + 1]) + (a / 255 * layers[i].data[j + 1]));
                    img.data[j + 2] = Math.round(((255 - a) / 255 * img.data[j + 2]) + (a / 255 * layers[i].data[j + 2]));
                }
            }
        }

        return img.pack();
    }

    private sendPaint(client: IClient, paint: IPaintMessage): void {

        if (isNaN(paint.layerNumber) || paint.layerNumber < 0 || paint.layerNumber >= this.config.layerCount) {
            return;
        }
        if (isNaN(paint.x) || isNaN(paint.y)) {
            return;
        }
        if (paint.mode !== 'normal' && paint.mode !== 'erase') {
            return;
        }
        if (Buffer.isBuffer(paint.data) === false) {
            return;
        }

        paint.x = paint.x >> 0;
        paint.y = paint.y >> 0;

        if (paint.x < 0 || paint.y < 0) {
            return;
        }

        new png.Image().parse(paint.data, (err, img) => {

            if (err) {
                return;
            }

            var i, j, x, y, aA, bA, xA,
                w = this.config.canvasWidth,
                h = this.config.canvasHeight,
                px = paint.x,
                py = paint.y,
                pw = Math.min(paint.x + img.width, w),
                ph = Math.min(paint.y + img.height, h),
                iw = img.width,
                ih = img.height,
                layer = this.resource.layers[paint.layerNumber];

            for (y = py; y < ph; y++) {
                for (x = px; x < pw; x++) {
                    i = (w * y + x) << 2;
                    j = (iw * (y - py) + (x - px)) << 2;

                    layer.data[i] = img.data[j];
                    layer.data[i + 1] = img.data[j + 1];
                    layer.data[i + 2] = img.data[j + 2];
                    layer.data[i + 3] = img.data[j + 3];
                }
            }

            var ioMessage: IIOPaintMessage = {
                client: this.clientToDistributable(client),
                layerNumber: paint.layerNumber,
                mode: paint.mode,
                x: paint.x,
                y: paint.y,
                data: paint.data
            };

            if (this.map.socket[client.uuid]) {
                this.map.socket[client.uuid].broadcast.emit('paint', ioMessage);
                setImmediate(() => this.map.socket[client.uuid].emit('painted'));
            } else {
                this.io.emit('paint', ioMessage);
            }

            if (client.server.id === this.id) {
                if (this.dataMode === EDataMode.Redis) {
                    this.publishRedis('paint', {
                        client: client,
                        body: paint
                    });
                }

                layer.emit('change');
            } else {
                layer.emit('update');
            }
        });
    }

    private sendStroke(client: IClient, stroke: IStrokeMessage) {

        if (util.isArray(stroke.points) === false) {
            return;
        }

        var i, l, point;
        for (i = 0, l = stroke.points.length; i < l; i++) {
            point = stroke.points[i];

            if (!point || isNaN(point[0]) || isNaN(point[1]) || isNaN(point[2])) {
                return;
            }
            if (point[0] < 0 || point[1] < 0 || point[2] <= 0) {
                return;
            }
            if (point[0] > this.config.canvasWidth || point[1] > this.config.canvasHeight) {
                return;
            }
            if (point[3]) {
                point.splice(3, 1);
            }
            point[0] = Math.round(point[0]);
            point[1] = Math.round(point[1]);
            point[2] = point[2] << 0;
        }

        if (client.server.id === this.id) {
            if (this.dataMode === EDataMode.Redis) {
                this.publishRedis('stroke', {
                    client: client,
                    body: stroke
                });
            }
        }

        var ioMessage: IIOStrokeMessage = {
            client: this.clientToDistributable(client),
            points: stroke.points
        };

        if (this.map.socket[client.uuid]) {
            this.map.socket[client.uuid].volatile.broadcast.emit('stroke', ioMessage);
        } else {
            Object.keys(this.io.sockets.connected).forEach((socketId) => {
                this.io.sockets.connected[socketId].volatile.emit('stroke', ioMessage);
            });
        }
    }

    private sendPointer(client: IClient, pointer: IPointerMessage) {

        if (isNaN(pointer.x) || isNaN(pointer.y)) {
            return;
        }

        pointer.x = pointer.x >> 0;
        pointer.y = pointer.y >> 0;

        if (pointer.x < -1 || pointer.y < -1 || pointer.x > this.config.canvasWidth || pointer.y > this.config.canvasHeight) {
            return;
        }

        if (client.server.id === this.id) {
            if (this.dataMode === EDataMode.Redis) {
                this.publishRedis('pointer', {
                    client: client,
                    body: pointer
                });
            }
        }

        var ioMessage: IIOPointerMessage = {
            client: this.clientToDistributable(client),
            x: pointer.x,
            y: pointer.y
        };

        if (this.map.socket[client.uuid]) {
            this.map.socket[client.uuid].volatile.broadcast.emit('pointer', ioMessage);
        } else {
            Object.keys(this.io.sockets.connected).forEach((socketId) => {
                this.io.sockets.connected[socketId].volatile.emit('pointer', ioMessage);
            });
        }
    }

    private sendChat(client: IClient, chat: IChatMessage) {

        if (typeof chat.message !== 'string' || chat.message.trim() === '') {
            return;
        }

        if (chat.message.length > 256) {
            return;
        }

        if (this.dataMode === EDataMode.Redis && client.server.id === this.id) {
            this.publishRedis('chat', {
                client: client,
                body: {
                    message: chat.message,
                    time: Date.now()
                }
            });
        }

        var ioMessage: IIOChatMessage = {
            client: this.clientToDistributable(client),
            message: chat.message,
            time: chat.time || Date.now()
        };

        this.io.emit('chat', ioMessage);

        util.log(util.format('%s %s said: "%s". client=%s server=%s', client.remoteAddr, client.name, chat.message, client.uuid, client.server.id));
    }

    private sendSystemMessage(message: string, server?: IServer) {

        if (!server && this.dataMode === EDataMode.Redis) {
            this.publishRedis('system', {
                body: message
            });
        }

        var ioMessage: IIOSystemMessage = {
            message: message,
            time: Date.now()
        };

        this.io.emit('chat', ioMessage);
    }
}

class Layer extends events.EventEmitter {

    data: Buffer;

    private pngCache: Buffer = null;

    constructor(public width: number, public height: number, public n: number, public path: string = '') {
        super();

        this.data = new Buffer(width * height * 4);
        this.data.fill(0);

        // Event: "update" when layer has updated.
        this.on('update', () => {
            this.pngCache = null;
        });

        // Event: "change" by this server user.
        this.on('change', () => {
            this.pngCache = null;
        });
    }

    toPngStream(stream: NodeJS.WritableStream): void {

        if (this.pngCache === null) {
            var img = new png.Image({
                width: this.width,
                height: this.height,
                deflateLevel: 1,// Fastest
                filterType: png.EFilterType.None,
                checkCRC: false
            });

            this.data.copy(img.data);

            var buffers = [];

            img.on('data', (buffer) => {
                stream.write(buffer);
                buffers.push(buffer);
            }).on('end', () => {
                stream.end();
                this.pngCache = Buffer.concat(buffers);
            });

            process.nextTick(() => img.pack());
        } else {
            stream.end(this.pngCache);
        }
    }

    toPngBuffer(callback: (buffer: Buffer) => void): void {

        if (this.pngCache === null) {
            var img = new png.Image({
                width: this.width,
                height: this.height,
                deflateLevel: 1,// Fastest
                filterType: png.EFilterType.None,
                checkCRC: false
            });

            this.data.copy(img.data);

            var buffers = [];

            img.on('data', (buffer) => {
                buffers.push(buffer);
            }).on('end', () => {
                this.pngCache = Buffer.concat(buffers);
                callback(this.pngCache);
            });

            process.nextTick(() => img.pack());
        } else {
            callback(this.pngCache);
        }
    }
}
