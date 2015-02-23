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

var PNG = require('node-png').PNG;

import httpUtil = require('http-util');
import ioUtil = require('io-util');

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
    dataSaveInterval?: number;
    redisHost?: string;
    redisPort?: number;
    redisPassword?: string;
    redisKeyPrefix?: string;
    clientDir?: string;
    forwardedHeaderType?: string;
}

export interface IDistServerConfig {
    title: string;
    canvasWidth: number;
    canvasHeight: number;
    layerCount: number;
    version: string;
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
    layers: ILayer[];
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
    name: string;
    pin: string;
    remoteAddr: string;
    isOnline: boolean;
    server: IServer;
}

interface ILayer {
    isUpdated: boolean;
    pngCache: Buffer;
    data: Buffer;
}

interface IRedisMessage {
    server?: IServer;
    client?: IClient;
    target?: ECollectProvideTarget;
    body?: any;
}

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

    constructor(public config: IServerConfig = {}) {

        super();

        // server id

        this.id = uuid.v4();
        Object.freeze(this.id);

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
        if (!config.dataSaveInterval) {
            config.dataSaveInterval = 3000;// deprecated?
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

        Object.freeze(this.config);

        // decide the data mode

        if (config.redisHost) {
            this.dataMode = EDataMode.Redis;
        } else if (config.dataDir) {
            this.dataMode = EDataMode.FS;
        } else {
            this.dataMode = EDataMode.None;
        }

        Object.freeze(this.dataMode);

        // Redis

        if (this.dataMode === EDataMode.Redis) {
            this.initRedisClients();
        }

        // FS

        if (this.dataMode === EDataMode.FS) {

        }

        // events

        // create a HTTP Server

        this.httpServer = http.createServer(this.httpServerRequestListener.bind(this));

        // create a Socket.IO Server

        this.io = socketio(this.httpServer);
        this.io.on('connection', this.ioConnectionListener.bind(this));
    }

    listen(port: any, hostname?: string, backlog?: number, callback?: Function): Server {

        this.httpServer.listen(port, hostname, backlog, function () {

            util.log(util.format('listening on %s:%s', hostname, port));

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
            version: pkg.version
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

    private initRedisClients(): void {

        this.redisClient = redis.createClient(this.config.redisPort, this.config.redisHost, {
            detect_buffers: true,
            auth_pass: this.config.redisPassword || null
        });

        this.redisSubscriber = redis.createClient(this.config.redisPort, this.config.redisHost, {
            auth_pass: this.config.redisPassword || null
        });

        this.redisSubscriber.on('message', this.redisMessageListener.bind(this));
    }

    private subscribeRedis(): void {

        this.redisSubscriber.subscribe('collect');
        this.redisSubscriber.subscribe('provide');
        this.redisSubscriber.subscribe('ping');
        this.redisSubscriber.subscribe('pong');
        this.redisSubscriber.subscribe('paint');
        this.redisSubscriber.subscribe('chat');
        this.redisSubscriber.subscribe('stroke');
        this.redisSubscriber.subscribe('pointer');
    }

    private unsubscribeRedis(): void {

        this.redisSubscriber.unsubscribe('collect');
        this.redisSubscriber.unsubscribe('provide');
        this.redisSubscriber.unsubscribe('ping');
        this.redisSubscriber.unsubscribe('pong');
        this.redisSubscriber.unsubscribe('paint');
        this.redisSubscriber.unsubscribe('chat');
        this.redisSubscriber.unsubscribe('stroke');
        this.redisSubscriber.unsubscribe('pointer');
    }

    private publishRedis(name: string, data: IRedisMessage = {}): void {

        data.server = {
            id: this.id
        };

        this.redisClient.publish(name, JSON.stringify(data));
    }

    private redisMessageListener(type: string, json: string): void {

        var data: IRedisMessage = JSON.parse(json);

        if (data.server.id === this.id) {
            return;
        }

        switch (type) {
            case 'ping':
                this.publishRedis('pong');
                break;
            case 'collect':
                if (data.target === ECollectProvideTarget.Clients) {
                    this.publishRedis('provide', {
                        target: ECollectProvideTarget.Clients,
                        body: this.resource.clients
                    });
                }
                break;
            case 'provide':
                if (data.target === ECollectProvideTarget.Clients) {
                    this.updateClientsByServer(data.server, <IClient[]>data.body);
                    this.io.emit('clients', this.distributableClients);
                }
                break;
            case 'paint':
                data.body.data = new Buffer(data.body.data);
                break;
            case 'chat':
                break;
            case 'stroke':
                break;
            case 'pointer':
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

        for (i = 0; i < clients.length; i++) {
            this.resource.clients.push(clients[i]);
        }
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
                this.canvasToPngStream(res);
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
                    this.layerToPngStream(this.resource.layers[layerNumber], res);
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


    }

    private layerToPngStream(layer: ILayer, stream: NodeJS.WritableStream): void {

        if (layer.pngCache === null) {
            stream.end(layer.pngCache);
        } else {
            var png = new PNG({
                width: this.config.canvasWidth,
                height: this.config.canvasHeight
            });

            layer.data.copy(png.data);

            var buffers = [];

            png.pack().on('data', function (buffer) {

                stream.write(buffer);
                buffers.push(buffer);
            }).on('end', function () {

                stream.end();
                layer.pngCache = Buffer.concat(buffers);
            });
        }
    }

    private canvasToPngStream(stream: NodeJS.WritableStream): void {

        var i, j, l, x, y, a,
            w = this.config.canvasWidth,
            h = this.config.canvasHeight,
            layers = this.resource.layers;

        var png = new PNG({
            width: w,
            height: h
        });
        png.data.fill(255);

        for (i = 0, l = layers.length; i < l; i++) {
            for (y = 0; y < h; y++) {
                for (x = 0; x < w; x++) {
                    j = (w * y + x) << 2;
                    a = layers[i].data[j + 3];

                    png.data[j] = Math.round(((255 - a) / 255 * png.data[j]) + (a / 255 * layers[i].data[j]));
                    png.data[j + 1] = Math.round(((255 - a) / 255 * png.data[j + 1]) + (a / 255 * layers[i].data[j + 1]));
                    png.data[j + 2] = Math.round(((255 - a) / 255 * png.data[j + 2]) + (a / 255 * layers[i].data[j + 2]));
                }
            }
        }

        png.pack().pipe(stream);
    }
}
