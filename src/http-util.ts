/// <reference path="../typings/tsd.d.ts" />
'use strict';

import http = require('http');
import path = require('path');

export function stripQueryString(uri: string): string {
    return uri.split('?')[0];
}

export function resolveFilepath(dir: string, location: string): string {

    if (location.slice(-1) === '/') {
        location += 'index.html';
    }

    return path.join(dir, location);
}

export function responseError(res: http.ServerResponse, code: number): void {

    res.writeHead(code, {
        'Content-Type': 'text/plain'
    });

    res.end();
}

export function responseJSON(res: http.ServerResponse, body: any): void {
    res.end(JSON.stringify(body));
}

export function setContentTypeHeaderByFilepath(res: http.ServerResponse, filepath: string): void {

    switch (path.extname(filepath)) {
        case '.html':
            res.setHeader('Content-Type', 'text/html; charset=utf-8');
            break;
        case '.js':
            res.setHeader('Content-Type', 'text/javascript; charset=utf-8');
            break;
        case '.css':
            res.setHeader('Content-Type', 'text/css; charset=utf-8');
            break;
        case '.ico':
            res.setHeader('Content-Type', 'image/vnd.microsoft.icon');
            break;
        case '.cur':
            res.setHeader('Content-Type', 'image/vnd.microsoft.icon');
            break;
        case '.svg':
            res.setHeader('Content-Type', 'image/svg+xml');
            break;
        case '.png':
            res.setHeader('Content-Type', 'image/png');
            break;
        case '.txt':
            res.setHeader('Content-Type', 'text/plain');
            break;
    }
}
