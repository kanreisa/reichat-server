/// <reference path="../typings/tsd.d.ts" />
'use strict';

export enum EForwardedHeaderType {
    XFF
}

export function getRemoteAddr(socket: SocketIO.Socket, forwardedHeaderType?: EForwardedHeaderType): string {

    if (forwardedHeaderType === EForwardedHeaderType.XFF) {
        return socket.client.request.headers['x-forwarded-for'] || socket.client.conn.remoteAddress;
    } else {
        return socket.client.conn.remoteAddress;
    }
}
