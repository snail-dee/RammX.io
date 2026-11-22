const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.static(path.join(__dirname, 'public')));

const TARGET_PLAYERS = 8;
const INITIAL_RADIUS = 720;
const MIN_RADIUS = 150;
const SHRINK_RATE = 14;
const MAX_ITEMS = 4;
const ITEM_TYPES = ['heavy', 'shield', 'shockwave', 'turbo'];
const ITEM_COLORS = {
    heavy: '#ffcc00',
    shield: '#00ffff',
    shockwave: '#ff007f',
    turbo: '#39ff14'
};
const BOT_COLORS = ['#00ffff', '#ff007f', '#39ff14', '#ffcc00', '#ff5500', '#b026ff'];
const BOT_NAMES = ['NOVA', 'FLUX', 'APEX', 'VORTEX', 'PULSE', 'ZERO', 'KINETIC', 'ORBIT', 'SPARK', 'CYBER'];
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function randomSpawn(radiusLimit) {
    const angle = Math.random() * Math.PI * 2;
    const dist = Math.sqrt(Math.random()) * Math.max(80, radiusLimit * 0.65);
    return { x: Math.cos(angle) * dist, y: Math.sin(angle) * dist };
}

class Room {
    constructor(code, isPublic = false) {
        this.code = code;
        this.isPublic = isPublic;
        this.arenaRadius = INITIAL_RADIUS;
        this.roundState = isPublic ? 'PLAYING' : 'WAITING';
        this.roundTimer = 0;
        this.winnerInfo = null;
        this.players = {};
        this.items = [];
        this.itemSpawnTimer = 2.5;
        this.botCounter = 1;
        this.itemCounter = 1;
        if (this.isPublic) {
            this.syncBotPopulation();
        }
    }

    createEntity(id, name, color, isBot) {
        const pos = randomSpawn(this.arenaRadius);
        return {
            id,
            name: (name || 'PLAYER').slice(0, 12),
            color: color || BOT_COLORS[Math.floor(Math.random() * BOT_COLORS.length)],
            isBot,
            x: pos.x,
            y: pos.y,
            vx: 0,
            vy: 0,
            radius: 26,
            mass: 1,
            kills: 0,
            alive: true,
            falling: false,
            fallScale: 1,
            charging: false,
            charge: 0,
            dashCooldown: 0,
            angle: Math.random() * Math.PI * 2,
            targetX: 0,
            targetY: 0,
            lastHitBy: null,
            lastHitTime: 0,
            buffHeavy: 0,
            buffShield: 0,
            buffTurbo: 0
        };
    }

    getEffectiveRadius(p) {
        return p.radius + (p.buffHeavy > 0 ? 8 : 0);
    }

    getEffectiveMass(p) {
        return p.mass + (p.buffHeavy > 0 ? 1.8 : 0);
    }

    getHumanCount() {
        return Object.values(this.players).filter(p => !p.isBot).length;
    }

    syncBotPopulation() {
        if (!this.isPublic) return;
        const ids = Object.keys(this.players);
        const humanCount = this.getHumanCount();
        const botIds = ids.filter(id => this.players[id].isBot);

        if (ids.length < TARGET_PLAYERS) {
            const needed = TARGET_PLAYERS - ids.length;
            for (let i = 0; i < needed; i++) {
                const id = 'bot_' + (this.botCounter++);
                const name = BOT_NAMES[Math.floor(Math.random() * BOT_NAMES.length)] + '-' + (Math.floor(Math.random() * 90) + 10);
                const color = BOT_COLORS[Math.floor(Math.random() * BOT_COLORS.length)];
                this.players[id] = this.createEntity(id, name, color, true);
            }
        } else if (ids.length > TARGET_PLAYERS && botIds.length > 0 && humanCount > 0) {
            const excess = Math.min(ids.length - TARGET_PLAYERS, botIds.length);
            for (let i = 0; i < excess; i++) {
                delete this.players[botIds[i]];
            }
        }
    }

    enterWaitingState() {
        this.roundState = 'WAITING';
        this.arenaRadius = INITIAL_RADIUS;
        this.winnerInfo = null;
        this.items = [];
        for (const p of Object.values(this.players)) {
            p.x = 0;
            p.y = 0;
            p.vx = 0;
            p.vy = 0;
            p.radius = 26;
            p.mass = 1;
            p.alive = true;
            p.falling = false;
            p.fallScale = 1;
            p.charging = false;
            p.charge = 0;
            p.dashCooldown = 0;
            p.buffHeavy = 0;
            p.buffShield = 0;
            p.buffTurbo = 0;
        }
    }

    addHuman(socketId, name, color) {
        this.players[socketId] = this.createEntity(socketId, name, color, false);
        if (this.isPublic) {
            if (this.roundState === 'PLAYING' && this.arenaRadius < INITIAL_RADIUS * 0.6) {
                this.players[socketId].alive = false;
            }
            this.syncBotPopulation();
        } else {
            if (this.roundState === 'WAITING' && this.getHumanCount() >= 2) {
                this.resetRound();
            } else if (this.roundState === 'PLAYING' && this.arenaRadius < INITIAL_RADIUS * 0.6) {
                this.players[socketId].alive = false;
            }
        }
    }

    removeHuman(socketId) {
        delete this.players[socketId];
        if (this.isPublic) {
            this.syncBotPopulation();
        } else if (this.getHumanCount() < 2) {
            this.enterWaitingState();
        }
    }

    resetRound() {
        if (!this.isPublic && this.getHumanCount() < 2) {
            this.enterWaitingState();
            return;
        }
        this.arenaRadius = INITIAL_RADIUS;
        this.roundState = 'PLAYING';
        this.winnerInfo = null;
        this.items = [];
        this.itemSpawnTimer = 2.0;
        if (this.isPublic) {
            this.syncBotPopulation();
        }
        for (const id of Object.keys(this.players)) {
            const p = this.players[id];
            const pos = randomSpawn(this.arenaRadius);
            p.x = pos.x;
            p.y = pos.y;
            p.vx = 0;
            p.vy = 0;
            p.radius = 26;
            p.mass = 1;
            p.alive = true;
            p.falling = false;
            p.fallScale = 1;
            p.charging = false;
            p.charge = 0;
            p.dashCooldown = 0;
            p.lastHitBy = null;
            p.buffHeavy = 0;
            p.buffShield = 0;
            p.buffTurbo = 0;
        }
    }

    spawnItem() {
        if (this.items.length >= MAX_ITEMS || this.arenaRadius < 220) return;
        const pos = randomSpawn(this.arenaRadius * 0.85);
        const type = ITEM_TYPES[Math.floor(Math.random() * ITEM_TYPES.length)];
        this.items.push({
            id: 'item_' + (this.itemCounter++),
            type,
            x: pos.x,
            y: pos.y
        });
    }

    emitFx(fx) {
        io.to(this.code).emit('fx', fx);
    }

    applyItem(p, item, aliveList, now) {
        if (item.type === 'heavy') {
            p.buffHeavy = 6.0;
            this.emitFx({ type: 'pickup', x: item.x, y: item.y, color: ITEM_COLORS.heavy, itemType: 'heavy', label: 'TITAN!' });
        } else if (item.type === 'shield') {
            p.buffShield = 7.0;
            this.emitFx({ type: 'pickup', x: item.x, y: item.y, color: ITEM_COLORS.shield, itemType: 'shield', label: 'SHIELD!' });
        } else if (item.type === 'turbo') {
            p.buffTurbo = 6.0;
            this.emitFx({ type: 'pickup', x: item.x, y: item.y, color: ITEM_COLORS.turbo, itemType: 'turbo', label: 'TURBO!' });
        } else if (item.type === 'shockwave') {
            const blastRadius = 310;
            for (const other of aliveList) {
                if (other.id === p.id || other.falling) continue;
                const dx = other.x - p.x;
                const dy = other.y - p.y;
                const dist = Math.hypot(dx, dy);
                if (dist > 0 && dist < blastRadius) {
                    const force = (1 - dist / blastRadius) * 1150 + 380;
                    const m = this.getEffectiveMass(other);
                    other.vx += (dx / dist) * (force / Math.sqrt(m));
                    other.vy += (dy / dist) * (force / Math.sqrt(m));
                    other.lastHitBy = p.id;
                    other.lastHitTime = now;
                }
            }
            this.emitFx({ type: 'shockwave', x: p.x, y: p.y, color: ITEM_COLORS.shockwave, radius: blastRadius, label: 'PULSE!' });
        }
    }

    triggerDash(p) {
        if (!p.alive || p.falling || p.dashCooldown > 0) return;
        const turboMul = p.buffTurbo > 0 ? 1.18 : 1;
        const power = (480 + p.charge * 760) * turboMul;
        p.vx += Math.cos(p.angle) * power;
        p.vy += Math.sin(p.angle) * power;
        p.charging = false;
        p.charge = 0;
        p.dashCooldown = p.buffTurbo > 0 ? 0.34 : 0.65;
        this.emitFx({ type: 'dash', x: p.x, y: p.y, color: p.color, angle: p.angle });
    }

    updateBotAI(p, allAlive) {
        const distFromCenter = Math.hypot(p.x, p.y);
        const dangerRatio = distFromCenter / this.arenaRadius;

        if (dangerRatio > 0.72) {
            const toCenter = Math.atan2(-p.y, -p.x);
            p.targetX = p.x + Math.cos(toCenter) * 200;
            p.targetY = p.y + Math.sin(toCenter) * 200;
            p.angle = toCenter;
            if (dangerRatio > 0.85 && p.dashCooldown <= 0) {
                p.charge = 0.6;
                this.triggerDash(p);
            } else {
                p.charging = false;
                p.charge = 0;
            }
            return;
        }

        let nearestItem = null;
        let bestItemDist = 260;
        for (const item of this.items) {
            const d = Math.hypot(item.x - p.x, item.y - p.y);
            if (d < bestItemDist && Math.hypot(item.x, item.y) < this.arenaRadius * 0.8) {
                bestItemDist = d;
                nearestItem = item;
            }
        }

        if (nearestItem) {
            p.targetX = nearestItem.x;
            p.targetY = nearestItem.y;
            p.angle = Math.atan2(nearestItem.y - p.y, nearestItem.x - p.x);
            p.charging = false;
            return;
        }

        let nearest = null;
        let bestScore = Infinity;
        for (const other of allAlive) {
            if (other.id === p.id) continue;
            const d = Math.hypot(other.x - p.x, other.y - p.y);
            const edgeBonus = Math.hypot(other.x, other.y) / this.arenaRadius;
            const score = d - edgeBonus * 140;
            if (score < bestScore) {
                bestScore = score;
                nearest = other;
            }
        }

        if (nearest) {
            const d = Math.hypot(nearest.x - p.x, nearest.y - p.y);
            p.targetX = nearest.x;
            p.targetY = nearest.y;
            p.angle = Math.atan2(nearest.y - p.y, nearest.x - p.x);

            if (d < 260 && p.dashCooldown <= 0) {
                p.charging = true;
                if (p.charge >= 0.45 + Math.random() * 0.45) {
                    this.triggerDash(p);
                }
            } else {
                p.charging = false;
            }
        }
    }

    step(dt, now) {
        const list = Object.values(this.players);
        const aliveList = list.filter(p => p.alive && !p.falling);

        if (this.roundState === 'WAITING') {
            for (const p of list) {
                if (!p.alive) continue;
                if (p.dashCooldown > 0) p.dashCooldown = Math.max(0, p.dashCooldown - dt);
                if (p.charging) p.charge = Math.min(1, p.charge + dt * 1.15);
                else p.charge = Math.max(0, p.charge - dt * 3);

                const dx = p.targetX - p.x;
                const dy = p.targetY - p.y;
                const dist = Math.hypot(dx, dy);
                const moveAccel = p.charging ? 420 : 1080;
                if (dist > 6) {
                    p.vx += (dx / dist) * moveAccel * dt;
                    p.vy += (dy / dist) * moveAccel * dt;
                }
                const friction = Math.pow(0.06, dt);
                p.vx *= friction;
                p.vy *= friction;
                p.x += p.vx * dt;
                p.y += p.vy * dt;

                if (Math.hypot(p.x, p.y) > this.arenaRadius) {
                    p.x = 0;
                    p.y = 0;
                    p.vx = 0;
                    p.vy = 0;
                }
            }
            return;
        }

        if (this.roundState === 'PLAYING') {
            this.arenaRadius = Math.max(MIN_RADIUS, this.arenaRadius - SHRINK_RATE * dt);

            this.itemSpawnTimer -= dt;
            if (this.itemSpawnTimer <= 0) {
                this.spawnItem();
                this.itemSpawnTimer = 3.8 + Math.random() * 1.4;
            }

            for (let i = this.items.length - 1; i >= 0; i--) {
                if (Math.hypot(this.items[i].x, this.items[i].y) > this.arenaRadius - 26) {
                    this.items.splice(i, 1);
                }
            }

            for (const p of list) {
                if (!p.alive) continue;

                if (p.falling) {
                    p.x += p.vx * dt * 0.4;
                    p.y += p.vy * dt * 0.4;
                    p.fallScale -= dt * 2.2;
                    if (p.fallScale <= 0) {
                        p.alive = false;
                        p.falling = false;
                    }
                    continue;
                }

                if (p.buffHeavy > 0) p.buffHeavy = Math.max(0, p.buffHeavy - dt);
                if (p.buffShield > 0) p.buffShield = Math.max(0, p.buffShield - dt);
                if (p.buffTurbo > 0) p.buffTurbo = Math.max(0, p.buffTurbo - dt);

                if (p.isBot) {
                    this.updateBotAI(p, aliveList);
                }

                if (p.dashCooldown > 0) p.dashCooldown = Math.max(0, p.dashCooldown - dt);

                const chargeRate = p.buffTurbo > 0 ? 2.15 : 1.15;
                if (p.charging) {
                    p.charge = Math.min(1, p.charge + dt * chargeRate);
                } else {
                    p.charge = Math.max(0, p.charge - dt * 3);
                }

                const dx = p.targetX - p.x;
                const dy = p.targetY - p.y;
                const dist = Math.hypot(dx, dy);
                const turboSpeed = p.buffTurbo > 0 ? 1.32 : 1;
                const moveAccel = (p.charging ? 420 : 1080) * turboSpeed;

                if (dist > 6) {
                    p.vx += (dx / dist) * moveAccel * dt;
                    p.vy += (dy / dist) * moveAccel * dt;
                }

                const friction = Math.pow(0.06, dt);
                p.vx *= friction;
                p.vy *= friction;

                p.x += p.vx * dt;
                p.y += p.vy * dt;

                const effR = this.getEffectiveRadius(p);

                for (let i = this.items.length - 1; i >= 0; i--) {
                    const item = this.items[i];
                    if (Math.hypot(p.x - item.x, p.y - item.y) < effR + 20) {
                        this.applyItem(p, item, aliveList, now);
                        this.items.splice(i, 1);
                    }
                }

                if (Math.hypot(p.x, p.y) > this.arenaRadius + effR * 0.25) {
                    p.falling = true;
                    p.charging = false;
                    if (p.lastHitBy && now - p.lastHitTime < 4500 && this.players[p.lastHitBy]) {
                        const killer = this.players[p.lastHitBy];
                        killer.kills += 1;
                        killer.mass = Math.min(2.6, killer.mass + 0.18);
                        killer.radius = Math.min(46, killer.radius + 3.2);
                        this.emitFx({ type: 'ko', x: p.x, y: p.y, color: p.color, killerId: killer.id, killerName: killer.name, victimName: p.name });
                    } else {
                        this.emitFx({ type: 'ko', x: p.x, y: p.y, color: p.color, killerId: null, killerName: null, victimName: p.name });
                    }
                }
            }

            for (let i = 0; i < aliveList.length; i++) {
                for (let j = i + 1; j < aliveList.length; j++) {
                    const a = aliveList[i];
                    const b = aliveList[j];
                    if (a.falling || b.falling) continue;
                    const dx = b.x - a.x;
                    const dy = b.y - a.y;
                    const dist = Math.hypot(dx, dy);
                    const minDist = this.getEffectiveRadius(a) + this.getEffectiveRadius(b);

                    if (dist > 0 && dist < minDist) {
                        const nx = dx / dist;
                        const ny = dy / dist;
                        const overlap = minDist - dist;
                        const ma = this.getEffectiveMass(a);
                        const mb = this.getEffectiveMass(b);
                        const totalMass = ma + mb;

                        a.x -= nx * overlap * (mb / totalMass);
                        a.y -= ny * overlap * (mb / totalMass);
                        b.x += nx * overlap * (ma / totalMass);
                        b.y += ny * overlap * (ma / totalMass);

                        const rvx = b.vx - a.vx;
                        const rvy = b.vy - a.vy;
                        const velAlongNormal = rvx * nx + rvy * ny;

                        if (velAlongNormal < 0) {
                            const impactSpeed = Math.abs(velAlongNormal);
                            const aShield = a.buffShield > 0 && impactSpeed > 180;
                            const bShield = b.buffShield > 0 && impactSpeed > 180;

                            if (aShield && !bShield) {
                                a.buffShield = 0;
                                b.vx += nx * Math.max(760, impactSpeed * 1.75);
                                b.vy += ny * Math.max(760, impactSpeed * 1.75);
                                b.lastHitBy = a.id;
                                b.lastHitTime = now;
                                this.emitFx({ type: 'shieldBreak', x: a.x, y: a.y, color: ITEM_COLORS.shield });
                            } else if (bShield && !aShield) {
                                b.buffShield = 0;
                                a.vx -= nx * Math.max(760, impactSpeed * 1.75);
                                a.vy -= ny * Math.max(760, impactSpeed * 1.75);
                                a.lastHitBy = b.id;
                                a.lastHitTime = now;
                                this.emitFx({ type: 'shieldBreak', x: b.x, y: b.y, color: ITEM_COLORS.shield });
                            } else {
                                const restitution = 1.38;
                                const impulse = -(1 + restitution) * velAlongNormal / (1 / ma + 1 / mb);
                                const ix = impulse * nx;
                                const iy = impulse * ny;

                                a.vx -= ix / ma;
                                a.vy -= iy / ma;
                                b.vx += ix / mb;
                                b.vy += iy / mb;

                                a.lastHitBy = b.id;
                                a.lastHitTime = now;
                                b.lastHitBy = a.id;
                                b.lastHitTime = now;

                                if (impactSpeed > 220) {
                                    this.emitFx({
                                        type: 'hit',
                                        x: (a.x + b.x) * 0.5,
                                        y: (a.y + b.y) * 0.5,
                                        power: Math.min(1, impactSpeed / 900),
                                        colorA: a.color,
                                        colorB: b.color
                                    });
                                }
                            }
                        }
                    }
                }
            }

            const survivors = Object.values(this.players).filter(p => p.alive);
            if (survivors.length <= 1) {
                this.roundState = 'ROUND_OVER';
                this.roundTimer = 3.5;
                this.winnerInfo = survivors.length === 1 ? { id: survivors[0].id, name: survivors[0].name, color: survivors[0].color } : { id: null, name: 'DRAW', color: '#00ffff' };
            }
        } else if (this.roundState === 'ROUND_OVER') {
            this.roundTimer -= dt;
            if (this.roundTimer <= 0) {
                this.resetRound();
            }
        }
    }

    getSnapshot() {
        const list = Object.values(this.players);
        return {
            roomCode: this.code,
            isPublic: this.isPublic,
            arenaRadius: this.arenaRadius,
            roundState: this.roundState,
            winnerInfo: this.winnerInfo,
            humanCount: list.filter(p => !p.isBot).length,
            botCount: list.filter(p => p.isBot).length,
            items: this.items.map(it => ({
                id: it.id,
                type: it.type,
                x: Math.round(it.x),
                y: Math.round(it.y)
            })),
            players: list.map(p => ({
                id: p.id,
                name: p.name,
                color: p.color,
                isBot: p.isBot,
                x: Math.round(p.x * 10) / 10,
                y: Math.round(p.y * 10) / 10,
                vx: Math.round(p.vx),
                vy: Math.round(p.vy),
                r: Math.round(this.getEffectiveRadius(p) * 10) / 10,
                kills: p.kills,
                alive: p.alive,
                falling: p.falling,
                fallScale: Math.round(p.fallScale * 100) / 100,
                charge: Math.round(p.charge * 100) / 100,
                angle: Math.round(p.angle * 100) / 100,
                heavy: Math.round(p.buffHeavy * 10) / 10,
                shield: Math.round(p.buffShield * 10) / 10,
                turbo: Math.round(p.buffTurbo * 10) / 10
            }))
        };
    }
}

const rooms = {
    PUBLIC: new Room('PUBLIC', true)
};

function generateRoomCode() {
    let code = '';
    do {
        code = '';
        for (let i = 0; i < 4; i++) {
            code += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
        }
    } while (rooms[code]);
    return code;
}

function detachFromCurrentRoom(socket) {
    const oldCode = socket.data.roomCode;
    if (!oldCode) return;
    const oldRoom = rooms[oldCode];
    if (oldRoom) {
        oldRoom.removeHuman(socket.id);
        if (!oldRoom.isPublic && oldRoom.getHumanCount() === 0) {
            delete rooms[oldCode];
        }
    }
    socket.leave(oldCode);
    socket.data.roomCode = null;
}

function enterRoom(socket, code, name, color) {
    detachFromCurrentRoom(socket);
    const room = rooms[code];
    socket.leave('PUBLIC');
    socket.join(code);
    socket.data.roomCode = code;
    room.addHuman(socket.id, name, color);
    socket.emit('joined', { id: socket.id, roomCode: code, isPublic: room.isPublic });
}

io.on('connection', (socket) => {
    socket.join('PUBLIC');

    socket.on('join', (data) => {
        const name = (data && data.name) ? String(data.name).trim() : 'PLAYER';
        const color = (data && data.color) ? String(data.color) : '#00ffff';
        enterRoom(socket, 'PUBLIC', name, color);
    });

    socket.on('createRoom', (data) => {
        const name = (data && data.name) ? String(data.name).trim() : 'PLAYER';
        const color = (data && data.color) ? String(data.color) : '#00ffff';
        const code = generateRoomCode();
        rooms[code] = new Room(code, false);
        enterRoom(socket, code, name, color);
    });

    socket.on('joinRoom', (data) => {
        const name = (data && data.name) ? String(data.name).trim() : 'PLAYER';
        const color = (data && data.color) ? String(data.color) : '#00ffff';
        const code = (data && data.roomCode) ? String(data.roomCode).trim().toUpperCase() : '';
        if (!code || !rooms[code]) {
            socket.emit('roomError', { message: 'ROOM NOT FOUND' });
            return;
        }
        enterRoom(socket, code, name, color);
    });

    socket.on('leaveRoom', () => {
        detachFromCurrentRoom(socket);
        socket.join('PUBLIC');
    });

    socket.on('input', (data) => {
        const code = socket.data.roomCode;
        if (!code || !rooms[code]) return;
        const room = rooms[code];
        const p = room.players[socket.id];
        if (!p || !p.alive || p.falling) return;
        p.targetX = data.tx;
        p.targetY = data.ty;
        p.angle = Math.atan2(p.targetY - p.y, p.targetX - p.x);
        if (data.charging && p.dashCooldown <= 0) {
            p.charging = true;
        } else if (!data.charging && p.charging) {
            room.triggerDash(p);
        }
    });

    socket.on('disconnect', () => {
        detachFromCurrentRoom(socket);
    });
});

const TICK_RATE = 60;
const DT = 1 / TICK_RATE;
let tickCount = 0;

setInterval(() => {
    const now = Date.now();
    tickCount++;
    const shouldBroadcast = tickCount % 2 === 0;

    for (const room of Object.values(rooms)) {
        room.step(DT, now);
        if (shouldBroadcast) {
            io.to(room.code).emit('state', room.getSnapshot());
        }
    }
}, 1000 / TICK_RATE);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`BUMPER.IO running on http://localhost:${PORT}`);
});