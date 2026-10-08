'use strict';

// Transport-independent room logic, shared by the Node server (server/) and the
// Cloudflare Worker (worker/). It holds the authoritative playback state of one
// room and decides what to broadcast; callers only supply connections that
// look like `{ send(string), close(code, reason) }`.
//
// Clients never talk to each other. They send "what the user just did"; the
// room answers every member with the full state, ordered by `rev`, so all
// devices converge on one timeline (last writer wins).

const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O/1/I/L
const ROOM_RE = /^[A-HJKMNP-Z2-9]{6}$/;
const CLIENT_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

function cleanName(raw) {
  const name = String(raw ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .slice(0, 24);
  return name || 'Misafir';
}

function parseHttpUrl(raw) {
  if (typeof raw !== 'string' || raw.length > 2048) return null;
  try {
    const u = new URL(raw);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u : null;
  } catch {
    return null;
  }
}

function num(v, min, max, fallback) {
  return typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback;
}

class RoomCore {
  /**
   * @param {{ id: string, url: string, maxMembers?: number, holdTimeoutMs?: number,
   *           onUrlChange?: (url: string) => void, log?: (...a: any[]) => void }} opts
   */
  constructor(opts) {
    this.id = opts.id;
    this.url = opts.url;
    this.homeOrigin = new URL(opts.url).origin;
    this.maxMembers = opts.maxMembers ?? 8;
    this.holdTimeoutMs = opts.holdTimeoutMs ?? 20_000;
    this.onUrlChange = opts.onUrlChange ?? (() => {});
    this.log = opts.log ?? (() => {});
    this.members = new Map(); // clientId -> { id, name, conn }
    this.waiting = new Set(); // clientIds whose video is buffering
    this.holdTimer = null;
    this.everJoined = false;
    this.emptySince = Date.now();
    this.state = { rev: 0, set: false, playing: false, position: 0, rate: 1, at: Date.now(), by: null, hold: false };
  }

  info() {
    return { room: this.id, url: this.url, members: this.members.size };
  }

  destroy() {
    clearTimeout(this.holdTimer);
    this.holdTimer = null;
  }

  // ---------------------------------------------------------------- output

  _nameOf(id) {
    return this.members.get(id)?.name ?? '';
  }

  _memberList() {
    return [...this.members.values()].map((m) => ({ id: m.id, name: m.name }));
  }

  _publicState() {
    const s = this.state;
    return {
      rev: s.rev,
      set: s.set,
      playing: s.playing,
      position: s.position,
      rate: s.rate,
      at: s.at,
      by: s.by,
      byName: this._nameOf(s.by),
      hold: s.hold ? { names: [...this.waiting].map((id) => this._nameOf(id)).filter(Boolean) } : null,
    };
  }

  _send(conn, msg) {
    try {
      conn.send(typeof msg === 'string' ? msg : JSON.stringify(msg));
    } catch {
      // socket already gone; its close handler cleans up
    }
  }

  _broadcast(msg, exceptId) {
    const payload = JSON.stringify(msg);
    for (const m of this.members.values()) if (m.id !== exceptId) this._send(m.conn, payload);
  }

  _broadcastState(reason) {
    this._broadcast({ t: 'state', reason, ...this._publicState() });
  }

  // ----------------------------------------------------------------- state

  _clearHold() {
    clearTimeout(this.holdTimer);
    this.holdTimer = null;
    this.state.hold = false;
  }

  _setState(patch, reason) {
    const s = this.state;
    this.state = { ...s, ...patch, rev: s.rev + 1, set: true };
    this._broadcastState(reason);
  }

  // A member's video ran out of buffer while the room was playing: freeze the
  // shared timeline at their position until everybody is ready again.
  _startHold(byId, position) {
    clearTimeout(this.holdTimer);
    this.state.hold = true;
    this._setState({ playing: false, position, at: Date.now(), by: byId, hold: true }, 'hold');
    this.holdTimer = setTimeout(() => {
      if (!this.state.hold) return;
      this.waiting.clear();
      this._resume(this.state.position, null, 'hold-timeout');
    }, this.holdTimeoutMs);
  }

  _resume(position, byId, reason) {
    this._clearHold();
    this._setState({ playing: true, position, at: Date.now(), by: byId, hold: false }, reason);
  }

  _releaseWaiter(id, position) {
    if (!this.waiting.delete(id) || !this.state.hold) return;
    if (this.waiting.size === 0) this._resume(position ?? this.state.position, id, 'resume');
    else this._setState({}, 'hold');
  }

  // ------------------------------------------------------------ membership

  /**
   * Handle a client's first message. Returns the member on success, or null
   * after having sent an error and closed the connection.
   */
  join(conn, msg) {
    if (msg.room !== this.id) {
      this._send(conn, { t: 'error', code: 'room-not-found' });
      conn.close(4004, 'room-not-found');
      return null;
    }
    if (typeof msg.id !== 'string' || !CLIENT_ID_RE.test(msg.id)) {
      conn.close(4003, 'bad-id');
      return null;
    }
    const existing = this.members.get(msg.id);
    if (!existing && this.members.size >= this.maxMembers) {
      this._send(conn, { t: 'error', code: 'room-full' });
      conn.close(4005, 'room-full');
      return null;
    }
    if (existing) existing.conn.close(4001, 'replaced');
    const member = { id: msg.id, name: cleanName(msg.name), conn };
    this.members.set(member.id, member);
    this.everJoined = true;
    this._send(conn, {
      t: 'welcome',
      room: { id: this.id, url: this.url },
      you: member.id,
      members: this._memberList(),
      state: this._publicState(),
      serverNow: Date.now(),
    });
    this._broadcast(
      { t: 'members', list: this._memberList(), joined: existing ? undefined : { id: member.id, name: member.name } },
      member.id,
    );
    this.log(`room ${this.id}: ${member.name} joined (${this.members.size})`);
    return member;
  }

  leave(member) {
    if (this.members.get(member.id) !== member) return; // replaced by a newer socket
    this.members.delete(member.id);
    if (this.members.size === 0) this.emptySince = Date.now();
    this._releaseWaiter(member.id, null);
    this.waiting.delete(member.id);
    this._broadcast({ t: 'members', list: this._memberList(), left: { id: member.id, name: member.name } });
    this.log(`room ${this.id}: ${member.name} left (${this.members.size} left)`);
  }

  // -------------------------------------------------------------- messages

  handle(member, msg) {
    switch (msg.t) {
      case 'ping':
        this._send(member.conn, { t: 'pong', c: msg.c, s: Date.now() });
        return;

      case 'state': {
        const now = Date.now();
        let at = typeof msg.at === 'number' && Number.isFinite(msg.at) ? msg.at : now;
        if (at > now || now - at > 5000) at = now;
        this.waiting.clear();
        this._clearHold();
        this._setState(
          {
            playing: msg.playing === true,
            position: num(msg.position, 0, 1e6, this.state.position),
            rate: num(msg.rate, 0.25, 4, 1),
            at,
            by: member.id,
            hold: false,
          },
          'user',
        );
        return;
      }

      case 'wait':
        if (!this.state.set || (!this.state.playing && !this.state.hold)) return;
        this.waiting.add(member.id);
        if (this.state.hold) this._setState({}, 'hold');
        else this._startHold(member.id, num(msg.position, 0, 1e6, this.state.position));
        return;

      case 'ready':
        this._releaseWaiter(member.id, num(msg.position, 0, 1e6, this.state.position));
        return;

      case 'nav': {
        const u = parseHttpUrl(msg.url);
        if (!u || u.origin !== this.homeOrigin || u.href === this.url) return;
        this.url = u.href;
        this.onUrlChange(this.url);
        this._broadcast({ t: 'nav', url: this.url, by: member.id, byName: member.name }, member.id);
        return;
      }

      case 'name':
        member.name = cleanName(msg.name);
        this._broadcast({ t: 'members', list: this._memberList() });
        return;
    }
  }
}

module.exports = { RoomCore, ALPHABET, ROOM_RE, CLIENT_ID_RE, cleanName, parseHttpUrl, num };
