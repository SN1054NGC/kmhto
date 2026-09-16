/*
 * KMHTO — учёт и планирование ТО/КМХ метрологического оборудования
 * SPDX-License-Identifier: AGPL-3.0-or-later
 * Copyright (C) 2026 Логвиненко А. А. (SN1054NGC) <logvinenko-aa@mail.ru>
 * Исходный код: https://github.com/SN1054NGC/kmhto
 */
'use strict';
/**
 * Минимальный сервер WebSocket (RFC 6455) без внешних зависимостей.
 * Поддержано: handshake, текстовые/бинарные кадры, маскирование клиента,
 * фрагментация, ping/pong, close, лимит размера сообщения.
 */
const crypto = require('crypto');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_MESSAGE = parseInt(process.env.KMHTO_MAX_MESSAGE || '1048576', 10);

const OP_CONT = 0x0, OP_TEXT = 0x1, OP_BIN = 0x2, OP_CLOSE = 0x8, OP_PING = 0x9, OP_PONG = 0xa;

function acceptKey(key) {
  return crypto.createHash('sha1').update(key + GUID).digest('base64');
}

function encodeFrame(opcode, payload) {
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  header[0] = 0x80 | opcode;
  return Buffer.concat([header, payload]);
}

function createConnection(socket, handlers) {
  const conn = {
    socket,
    readyState: 1,
    alive: true,
    buffer: Buffer.alloc(0),
    fragments: [],
    fragOpcode: 0,
    data: {},
    send(text) {
      if (conn.readyState !== 1) return false;
      const payload = Buffer.isBuffer(text) ? text : Buffer.from(String(text), 'utf8');
      try { socket.write(encodeFrame(OP_TEXT, payload)); return true; }
      catch (e) { return false; }
    },
    sendJson(obj) { return conn.send(JSON.stringify(obj)); },
    ping() {
      if (conn.readyState !== 1) return;
      try { socket.write(encodeFrame(OP_PING, Buffer.alloc(0))); } catch (e) {}
    },
    close(code, reason) {
      if (conn.readyState !== 1) return;
      conn.readyState = 2;
      try {
        const payload = Buffer.alloc(2 + Buffer.byteLength(reason || ''));
        payload.writeUInt16BE(code || 1000, 0);
        if (reason) payload.write(reason, 2, 'utf8');
        socket.write(encodeFrame(OP_CLOSE, payload));
      } catch (e) {}
      try { socket.end(); } catch (e) {}
      conn.readyState = 3;
    }
  };

  function fail() { try { socket.destroy(); } catch (e) {} conn.readyState = 3; }

  function onData(chunk) {
    conn.buffer = Buffer.concat([conn.buffer, chunk]);
    for (;;) {
      const b = conn.buffer;
      if (b.length < 2) return;
      const fin = (b[0] & 0x80) !== 0;
      const opcode = b[0] & 0x0f;
      const masked = (b[1] & 0x80) !== 0;
      let len = b[1] & 0x7f;
      let off = 2;
      if (len === 126) {
        if (b.length < 4) return;
        len = b.readUInt16BE(2); off = 4;
      } else if (len === 127) {
        if (b.length < 10) return;
        const big = b.readBigUInt64BE(2);
        if (big > BigInt(MAX_MESSAGE)) { conn.close(1009, 'too big'); return; }
        len = Number(big); off = 10;
      }
      if (len > MAX_MESSAGE) { conn.close(1009, 'too big'); return; }
      let mask = null;
      if (masked) {
        if (b.length < off + 4) return;
        mask = b.slice(off, off + 4); off += 4;
      }
      if (b.length < off + len) return;
      let payload = b.slice(off, off + len);
      if (masked) {
        payload = Buffer.from(payload);
        for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
      }
      conn.buffer = b.slice(off + len);

      if (opcode === OP_CLOSE) { conn.readyState = 3; try { socket.end(); } catch (e) {} handlers.onClose && handlers.onClose(conn); return; }
      if (opcode === OP_PING) { try { socket.write(encodeFrame(OP_PONG, payload)); } catch (e) {} continue; }
      if (opcode === OP_PONG) { conn.alive = true; handlers.onPong && handlers.onPong(conn); continue; }

      if (opcode === OP_CONT) {
        conn.fragments.push(payload);
      } else {
        conn.fragments = [payload];
        conn.fragOpcode = opcode;
      }
      if (!fin) continue;

      const full = conn.fragments.length === 1 ? conn.fragments[0] : Buffer.concat(conn.fragments);
      const wasText = conn.fragOpcode === OP_TEXT;
      conn.fragments = [];
      if (wasText) {
        let text;
        try { text = full.toString('utf8'); } catch (e) { continue; }
        handlers.onMessage && handlers.onMessage(conn, text);
      } else if (handlers.onBinary) {
        handlers.onBinary(conn, full);
      }
    }
  }

  socket.on('data', onData);
  socket.on('error', fail);
  socket.on('close', () => {
    if (conn.readyState !== 3) { conn.readyState = 3; handlers.onClose && handlers.onClose(conn); }
  });
  socket.setNoDelay(true);
  return conn;
}

/** Навесить обработку upgrade на обычный http.Server. */
function attach(httpServer, handlers) {
  httpServer.on('upgrade', (req, socket, head) => {
    const key = req.headers['sec-websocket-key'];
    const version = req.headers['sec-websocket-version'];
    const upgrade = String(req.headers.upgrade || '').toLowerCase();
    if (upgrade !== 'websocket' || !key || (version && version !== '13')) {
      try { socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'); } catch (e) {}
      try { socket.destroy(); } catch (e) {}
      return;
    }
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      'Sec-WebSocket-Accept: ' + acceptKey(key) + '\r\n\r\n'
    );
    const conn = createConnection(socket, handlers);
    handlers.onConnection && handlers.onConnection(conn, req);
    if (head && head.length) socket.emit('data', head);
  });
}

module.exports = { attach, encodeFrame, acceptKey, MAX_MESSAGE };
