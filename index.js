import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import net from 'net';
import http from 'http';
import express from 'express';
import { Server as SocketIO } from 'socket.io';
import mineflayer from 'mineflayer';
import mineflayerPathfinder from 'mineflayer-pathfinder';
const { pathfinder, Movements, goals } = mineflayerPathfinder;
import mcDataFactory from 'minecraft-data';
import { loader as autoeat } from 'mineflayer-auto-eat';
import armorManager from 'mineflayer-armor-manager';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { WorldView } = require('prismarine-viewer/viewer/lib/worldView');
import compression from 'compression';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─── ENV PATH ────────────────────────────────────────────────────────
const envPath = path.join(__dirname, '.env');

// ─── CONFIG ──────────────────────────────────────────────────────────
let config;
try {
    config = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
} catch (err) {
    console.error('❌ Cannot read config.json —', err.message);
    process.exit(1);
}

const ENV = {
    ip:       process.env.SERVER_IP       || 'localhost',
    port:     parseInt(process.env.SERVER_PORT || '25565'),
    username: process.env.BOT_USERNAME     || 'AFK_Bot',
    password: process.env.BOT_PASSWORD     || '',
    auth:     process.env.BOT_AUTH_TYPE    || 'offline',
};

// ─── STATE ───────────────────────────────────────────────────────────
let bot = null;
let mcData = null;
let viewerActive = false;
let viewerSockets = [];     // connected viewer clients
let viewerCleanup = null;   // function to remove bot listeners
let afkLoop = null;
let isBusy = false;
let spawnPoint = null;
let authDone = false;
let reconnectAttempt = 0;
let reconnectTimer = null;
let botStatus = 'offline';   // offline | connecting | online | reconnecting
let botHealth = 20;
let botFood = 20;
const consoleLogs = [];      // ring buffer for dashboard
const MAX_LOGS = 500;

// ─── LOGGING ─────────────────────────────────────────────────────────
const ICONS = { info: 'ℹ️', success: '✅', warn: '⚠️', error: '❌', combat: '⚔️', brain: '🧠', chat: '💬', debug: '🐛' };

function log(type, msg, detail = '') {
    const time = new Date().toLocaleTimeString();
    const icon = ICONS[type] || '•';
    const line = `[${time}] ${icon} [${type.toUpperCase()}]: ${msg}${detail ? `\n   └─ ➤ ${detail}` : ''}`;
    console.log(line);
    consoleLogs.push({ time, type, msg, detail, ts: Date.now() });
    if (consoleLogs.length > MAX_LOGS) consoleLogs.shift();
    io?.emit('log', { time, type, msg, detail });
}

function closeViewer() {
    if (viewerCleanup) {
        try { viewerCleanup(); } catch {}
        viewerCleanup = null;
    }
    // Disconnect all viewer sockets
    for (const s of viewerSockets) {
        try { s.disconnect(true); } catch {}
    }
    viewerSockets = [];
    if (viewerActive) {
        viewerActive = false;
        io.emit('viewer-status', { active: false });
    }
}

function emitStatus() {
    io?.emit('status', {
        status: botStatus,
        health: botHealth,
        food: botFood,
        version: bot?.version || '—',
        position: bot?.entity?.position ? {
            x: Math.floor(bot.entity.position.x),
            y: Math.floor(bot.entity.position.y),
            z: Math.floor(bot.entity.position.z)
        } : null,
        server: `${ENV.ip}:${ENV.port}`,
        username: ENV.username,
        uptime: bot?._connectTime ? Date.now() - bot._connectTime : 0,
    });
}

// ─── MATH CAPTCHA SOLVER (safe, no eval) ─────────────────────────────
function solveMath(expression) {
    const parts = expression.match(/(\d+)\s*([\+\-\*\/])\s*(\d+)/);
    if (!parts) return null;
    const [, aStr, op, bStr] = parts;
    const a = parseInt(aStr), b = parseInt(bStr);
    switch (op) {
        case '+': return a + b;
        case '-': return a - b;
        case '*': return a * b;
        case '/': return b !== 0 ? Math.floor(a / b) : null;
        default:  return null;
    }
}

// ─── RECONNECT WITH SMART BACKOFF ────────────────────────────────────
// Transient network errors get shorter retry delays
const TRANSIENT_ERRORS = ['ECONNRESET', 'EPIPE', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH', 'socket hang up', 'Socket closed'];
let lastErrorTransient = false;
let hadTransientError = false;

function measurePing(host, port, timeout = 5000) {
    return new Promise((resolve) => {
        const start = Date.now();
        const sock = net.createConnection({ host, port, timeout }, () => {
            resolve(Date.now() - start);
            sock.destroy();
        });
        sock.on('error', () => resolve(Infinity));
        sock.on('timeout', () => { sock.destroy(); resolve(Infinity); });
    });
}

function chooseViewDistance(pingMs) {
    // mineflayer accepts numeric viewDistance values: tiny=2, short=4, normal=8
    // Force tiny for Aternos — their network is notoriously unreliable
    if (ENV.ip.includes('aternos.me')) return 2;
    if (pingMs < 100 && !hadTransientError) return 4;  // short
    return 2;  // tiny
}

function scheduleReconnect() {
    if (!config.features.auto_reconnect) return;
    const rc = config.reconnect || {};
    const max  = rc.max_delay_ms  || 300000;
    const mult = rc.multiplier    || 2;

    // Transient network errors use a shorter base delay (5s) for faster recovery
    const base = lastErrorTransient
        ? Math.min(rc.transient_delay_ms || 5000, rc.base_delay_ms || 15000)
        : (rc.base_delay_ms || 15000);

    // Cap transient retries to a lower max (60s) so we keep trying frequently
    const effectiveMax = lastErrorTransient ? Math.min(60000, max) : max;

    const delay = Math.min(base * Math.pow(mult, reconnectAttempt), effectiveMax);
    reconnectAttempt++;
    botStatus = 'reconnecting';
    emitStatus();
    log('info', `Reconnecting in ${(delay / 1000).toFixed(0)}s...`, `Attempt #${reconnectAttempt}${lastErrorTransient ? ' (transient — fast retry)' : ''}`);
    reconnectTimer = setTimeout(createBot, delay);
}

// ─── BOT CREATION ────────────────────────────────────────────────────
async function createBot() {
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    if (afkLoop) { clearInterval(afkLoop); afkLoop = null; }
    isBusy = false;
    authDone = false;
    spawnPoint = null;
    botStatus = 'connecting';
    emitStatus();

    // Measure ping to decide viewDistance dynamically
    const pingMs = await measurePing(ENV.ip, ENV.port);
    const vd = chooseViewDistance(pingMs);
    log('info', 'Connecting to server...', `${ENV.ip}:${ENV.port} as ${ENV.username} | ping ${pingMs === Infinity ? 'N/A' : pingMs + 'ms'} → viewDistance: ${vd}${hadTransientError ? ' (degraded — previous network errors)' : ''}`);

    try {
        bot = mineflayer.createBot({
            host: ENV.ip,
            port: ENV.port,
            username: ENV.username,
            version: config.server_info.version === false || config.server_info.version === 'false' ? false : config.server_info.version,
            auth: ENV.auth,
            password: ENV.password,
            viewDistance: vd,
            checkTimeoutInterval: 120000,
            closeTimeout: 120000,
            respawn: true,
            keepAlive: true,
        });
    } catch (err) {
        log('error', 'Failed to create bot instance', err.message);
        scheduleReconnect();
        return;
    }

    bot._connectTime = Date.now();
    bot.setMaxListeners(100);
    bot._client.setMaxListeners(100);
    process.setMaxListeners(100);
    bot.loadPlugin(pathfinder);
    bot.loadPlugin(autoeat);
    bot.loadPlugin(armorManager);

    // ── Connection events ──
    bot.on('kicked', (reason) => {
        let text = reason;
        try { const p = JSON.parse(reason); text = p.text || p.extra?.map(e => e.text).join('') || reason; } catch {}
        log('warn', 'Kicked by server!', text);
    });

    bot.on('error', (err) => {
        const m = err.message || String(err);
        let hint = 'Unknown error.';
        let transient = false;
        if (m.includes('ECONNRESET'))         { hint = 'Connection reset by server — likely network instability or server restart.'; transient = true; }
        else if (m.includes('EPIPE'))         { hint = 'Broken pipe — connection dropped mid-transfer.'; transient = true; }
        else if (m.includes('ENOTFOUND'))     { hint = 'DNS lookup failed — check hostname or network.'; transient = true; }
        else if (m.includes('EAI_AGAIN'))     { hint = 'DNS temporarily unavailable — poor network.'; transient = true; }
        else if (m.includes('EHOSTUNREACH'))  { hint = 'Host unreachable — network down or server offline.'; transient = true; }
        else if (m.includes('ENETUNREACH'))   { hint = 'Network unreachable — check your internet.'; transient = true; }
        else if (m.includes('ECONNREFUSED'))  { hint = 'Server is OFF or wrong IP/Port.'; }
        else if (m.includes('ETIMEDOUT'))     { hint = 'Network timeout — server unreachable.'; transient = true; }
        else if (m.includes('socket hang up') || m.includes('Socket closed')) { hint = 'Connection dropped unexpectedly.'; transient = true; }
        else if (m.includes('decoder') || m.includes('packet')) { hint = 'Version mismatch or anti-bot.'; }
        lastErrorTransient = transient;
        if (transient) hadTransientError = true;
        log('error', 'Connection error', `${m} → ${hint}`);
    });

    bot.on('end', (reason) => {
        const r = reason || '';
        // Mark transient if disconnect reason looks network-related
        if (TRANSIENT_ERRORS.some(e => r.includes(e))) { lastErrorTransient = true; hadTransientError = true; }
        log('warn', 'Disconnected.', r);
        botStatus = 'offline';
        if (afkLoop) { clearInterval(afkLoop); afkLoop = null; }
        if (combatLoop) { clearInterval(combatLoop); combatLoop = null; combatTarget = null; }
        if (threatScanLoop) { clearInterval(threatScanLoop); threatScanLoop = null; }
        isBusy = false;
        // Close viewer
        closeViewer();
        emitStatus();
        scheduleReconnect();
    });

    // ── Spawn ──
    bot.once('spawn', () => {
        mcData = mcDataFactory(bot.version);
        botStatus = 'online';
        reconnectAttempt = 0;  // reset backoff on successful connect
        spawnPoint = bot.entity.position.clone();
        log('success', `Connected! (v${bot.version})`);

        // Start viewer (same-port, no extra server needed)
        closeViewer();
        viewerActive = true;
        log('info', '3D Viewer ready.');
        io.emit('viewer-status', { active: true });

        // After 5 minutes of stable connection, re-measure ping before clearing flag
        setTimeout(async () => {
            if (!bot || botStatus !== 'online') return;
            const currentPing = await measurePing(ENV.ip, ENV.port);
            if (currentPing < 100) {
                hadTransientError = false;
                log('info', `Connection stable for 5m, ping ${currentPing}ms — network quality flag reset.`);
            } else {
                log('info', `Connection stable for 5m but ping still high (${currentPing === Infinity ? 'N/A' : currentPing + 'ms'}) — keeping degraded viewDistance.`);
            }
        }, 5 * 60 * 1000);

        const defaultMove = new Movements(bot);
        defaultMove.allowSprinting = true;
        defaultMove.canDig = false;         // don't break blocks while roaming
        defaultMove.allow1by1towers = false; // don't pillar up
        defaultMove.allowFreeMotion = false;
        defaultMove.maxDropDown = 4;         // refuse to drop more than 4 blocks
        defaultMove.allowParkour = true;
        // Avoid lava & water
        if (mcData.blocksByName.lava)  defaultMove.blocksCantBreak.add(mcData.blocksByName.lava.id);
        if (mcData.blocksByName.water) defaultMove.blocksToAvoid.add(mcData.blocksByName.lava?.id);
        bot.pathfinder.setMovements(defaultMove);

        if (config.features.auto_eat && bot.autoEat) {
            try {
                bot.autoEat.setOpts({ priority: 'foodValue', bannedFood: [], eatingTimeout: 3 });
                bot.autoEat.enableAuto();
                log('info', 'Auto-eat enabled.');
            } catch (e) {
                log('warn', 'Auto-eat setup failed:', e.message);
            }
        }

        if (config.features.auto_equip) {
            bot.armorManager.equipAll();
            log('info', 'Auto-equip armor enabled.');
        }

        // Anti-bot entry bypass
        log('info', 'Running entry sequence...');
        bot.look(bot.entity.yaw + (Math.random() - 0.5), 0, true);
        setTimeout(() => {
            bot.setControlState('jump', true);
            setTimeout(() => bot.setControlState('jump', false), 500);
            bot.setControlState('forward', true);
            setTimeout(() => {
                bot.setControlState('forward', false);
                // Send first-time message if configured
                const ftm = config.entry_settings?.first_time_message;
                if (ftm && typeof ftm === 'string' && ftm.trim()) {
                    const delay = (config.entry_settings?.chat_delay_seconds || 2) * 1000;
                    setTimeout(() => {
                        log('info', `Sending first-time message: ${ftm.trim()}`);
                        bot.chat(ftm.trim());
                    }, delay);
                }
                log('success', 'Entry complete. Starting AFK loop.');
                startSmartAFK();
                startThreatScanner();
            }, config.entry_settings.move_forward_seconds * 1000 || 1000);
        }, 1500);

        emitStatus();
    });

    // ── Resource pack ──
    // Fix: mineflayer's acceptResourcePack() uses UUID object which serializes
    // incorrectly in 1.20.3+ configuration phase. We handle it at protocol level
    // with raw string UUID instead.
    let rpHandledByProtocol = false;
    bot._client.removeAllListeners('add_resource_pack');
    bot._client.on('add_resource_pack', (data) => {
        rpHandledByProtocol = true;
        if (!config.features.accept_resource_pack) {
            log('info', 'Resource pack declined (disabled in config).');
            bot._client.write('resource_pack_receive', { uuid: data.uuid, result: 1 });
            return;
        }
        log('info', 'Resource pack requested — accepting...');
        bot._client.write('resource_pack_receive', { uuid: data.uuid, result: 3 }); // ACCEPTED
        setTimeout(() => {
            bot._client.write('resource_pack_receive', { uuid: data.uuid, result: 0 }); // LOADED
            log('success', 'Resource pack accepted & loaded.');
        }, 500);
    });
    // Fallback for older servers (pre-1.20.3) that use resource_pack_send
    bot.on('resourcePack', () => {
        if (rpHandledByProtocol) return; // already handled above
        if (config.features.accept_resource_pack) {
            log('info', 'Accepting resource pack (legacy)...');
            bot.acceptResourcePack();
        }
    });

    // ══════════════════════════════════════════════════════════
    // ── COMBAT ENGINE ──────────────────────────────────────────
    // ══════════════════════════════════════════════════════════
    let combatTarget = null;
    let combatLoop = null;
    let lastFleeLog = 0;
    let lastStashTime = 0;
    let lastFoodSourceTime = 0;

    // Track players who have actually attacked the bot: entityId → timestamp
    const playerAttackers = new Map();
    const ATTACKER_EXPIRE_MS = 30000; // 30 seconds
    let lastDamageTime = 0; // timestamp of last time bot took damage

    function isHostile(e) {
        if (!e || !e.isValid || !e.position || !bot?.entity?.position) return false;
        // Hostile mob types in MC
        const hostiles = [
            'zombie', 'skeleton', 'spider', 'creeper', 'slime',
            'witch', 'phantom', 'drowned', 'husk', 'stray',
            'pillager', 'vindicator', 'ravager', 'enderman',
            'cave_spider', 'magma_cube', 'blaze', 'ghast',
            'wither_skeleton', 'piglin_brute', 'warden', 'breeze'
        ];
        return (e.type === 'mob' || e.type === 'hostile') &&
               hostiles.some(h => (e.name || '').toLowerCase().includes(h));
    }

    function findNearestThreat(range) {
        if (!bot?.entity) return null;
        return bot.nearestEntity(e => {
            if (!e?.position || !e.isValid) return false;
            const dist = e.position.distanceTo(bot.entity.position);
            if (dist > range) return false;
            // Hostile mob
            if (isHostile(e)) return true;
            // Player who has actually attacked us (tracked in playerAttackers map)
            if (e.type === 'player' && playerAttackers.has(e.id)) {
                const lastAttackTime = playerAttackers.get(e.id);
                if (Date.now() - lastAttackTime < ATTACKER_EXPIRE_MS) return true;
                // Entry expired — clean it up
                playerAttackers.delete(e.id);
            }
            return false;
        });
    }

    async function equipBestWeapon() {
        if (!bot?.inventory) return;
        const items = bot.inventory.items();
        // Priority: sword > axe > pickaxe > bare fist
        const weapon = items.find(i => i.name.includes('sword')) ||
                       items.find(i => i.name.includes('axe') && !i.name.includes('pickaxe'));
        if (weapon && bot.heldItem?.name !== weapon.name) {
            try { await bot.equip(weapon, 'hand'); } catch {}
        }
    }

    function startCombat(target) {
        if (combatLoop || !target?.isValid) return;
        // Don't engage if HP is too low
        const fleeHP = config.combat?.flee_health || 6;
        if (bot.health <= fleeHP) return;
        // Don't engage during explosive flee cooldown
        if (Date.now() < explosiveFleeCooldown) return;
        combatTarget = target;
        isBusy = true;

        log('combat', `Engaging ${target.name || 'mob'}!`, `HP: ${bot.health.toFixed(1)} | Dist: ${target.position.distanceTo(bot.entity.position).toFixed(1)}`);
        equipBestWeapon();

        combatLoop = setInterval(() => {
            if (!bot?.entity || !combatTarget?.isValid) {
                stopCombat('target gone');
                return;
            }

            const dist = combatTarget.position.distanceTo(bot.entity.position);

            // Flee if HP critical
            const fleeHP = config.combat?.flee_health || 6;
            if (bot.health <= fleeHP) {
                stopCombat('low HP');
                flee();
                return;
            }

            // Target too far = disengage
            if (dist > 8) {
                stopCombat('target out of range');
                return;
            }

            // Chase if not in attack range
            if (dist > 3.5) {
                bot.pathfinder.setGoal(new goals.GoalFollow(combatTarget, 2), true);
            }

            // Attack when in range (MC melee reach ~3.5 blocks)
            if (dist <= 3.5) {
                bot.lookAt(combatTarget.position.offset(0, combatTarget.height * 0.8, 0));
                bot.attack(combatTarget);
            }
        }, 250);   // 4 attacks/sec = MC fist attack speed
    }

    function stopCombat(reason) {
        if (combatLoop) {
            clearInterval(combatLoop);
            combatLoop = null;
        }
        if (combatTarget) {
            log('combat', `Disengaged.`, reason);
            combatTarget = null;
        }
        isBusy = false;
        bot?.pathfinder?.stop();
    }

    function flee() {
        const now = Date.now();
        if (now - lastFleeLog > 5000) {
            log('warn', `Low HP (${bot.health.toFixed(1)})! Fleeing to spawn...`);
            lastFleeLog = now;
        }
        const safe = spawnPoint || bot.entity.position;
        // Invert flee: run away from threat if possible
        const threat = findNearestThreat(10);
        if (threat) {
            const dx = bot.entity.position.x - threat.position.x;
            const dz = bot.entity.position.z - threat.position.z;
            const len = Math.sqrt(dx * dx + dz * dz) || 1;
            const fleeX = bot.entity.position.x + (dx / len) * 10;
            const fleeZ = bot.entity.position.z + (dz / len) * 10;
            bot.pathfinder.setGoal(new goals.GoalNear(fleeX, bot.entity.position.y, fleeZ, 2), true);
        } else {
            bot.pathfinder.setGoal(new goals.GoalNear(safe.x, safe.y, safe.z, 1), true);
        }
    }

    // Proactive threat scanner — runs every 500ms
    let threatScanLoop = null;
    function startThreatScanner() {
        if (threatScanLoop) clearInterval(threatScanLoop);
        threatScanLoop = setInterval(() => {
            if (!bot?.entity) return;

            // ━━ PRIORITY 1: Explosive avoidance (always active) ━━
            if (config.features.explosive_avoidance) {
                const fleeR = config.explosive_avoidance?.flee_radius || 8;
                const explosiveEntity = findNearestExplosiveEntity(fleeR);
                if (explosiveEntity) {
                    fleeFromExplosive(explosiveEntity.position, explosiveEntity.name);
                    return; // Skip everything else
                }
                const explosiveBlock = findNearestExplosiveBlock(fleeR);
                if (explosiveBlock) {
                    fleeFromExplosive(explosiveBlock.position, explosiveBlock.name);
                    return;
                }
            }

            if (!config.features.combat_self_defense) return;

            // ━━ PRIORITY 2: Check current combat target ━━
            if (combatLoop) {
                if (!combatTarget?.isValid) stopCombat('target despawned');
                return;
            }

            // ━━ PRIORITY 3: Flee on low HP ━━
            const fleeHP = config.combat?.flee_health || 6;
            if (bot.health <= fleeHP) {
                const threat = findNearestThreat(8);
                if (threat) flee();
                return;
            }

            // ━━ PRIORITY 4: Engage hostiles ━━
            const scanRange = config.combat?.scan_range || 6;
            const threat = findNearestThreat(scanRange);
            if (threat) {
                startCombat(threat);
            }
        }, 500);
    }

    // Smart damage detection: track which players actually attack us
    bot.on('entityHurt', (entity) => {
        if (entity !== bot.entity) return;
        lastDamageTime = Date.now();

        if (!config.features.combat_self_defense) return;

        // Find the nearest player within 5 blocks and register them as attacker
        const nearestPlayer = bot.nearestEntity(e => {
            if (!e?.position || !e.isValid || e.type !== 'player') return false;
            return e.position.distanceTo(bot.entity.position) <= 5;
        });

        if (nearestPlayer) {
            playerAttackers.set(nearestPlayer.id, Date.now());
            log('combat', `Player ${nearestPlayer.username || nearestPlayer.name || 'unknown'} attacked us! Retaliating...`,
                `Dist: ${nearestPlayer.position.distanceTo(bot.entity.position).toFixed(1)} | HP: ${bot.health.toFixed(1)}`);

            if (!combatLoop) {
                startCombat(nearestPlayer);
            }
        } else {
            // No player nearby — might be a mob; check for mob threats
            if (!combatLoop) {
                const mobThreat = findNearestThreat(5);
                if (mobThreat) startCombat(mobThreat);
            }
        }
    });

    // Detect player arm swings near the bot — correlate with recent damage
    bot.on('entitySwingArm', (entity) => {
        if (!entity || !bot?.entity || entity.type !== 'player') return;
        if (!config.features.combat_self_defense) return;
        const dist = entity.position?.distanceTo(bot.entity.position);
        if (dist == null || dist > 4) return;

        // If the bot took damage very recently (within 500ms), this player is likely the attacker
        if (Date.now() - lastDamageTime < 500) {
            playerAttackers.set(entity.id, Date.now());
            log('combat', `Detected swing from ${entity.username || entity.name || 'unknown'} right after damage — marking as attacker.`);
            if (!combatLoop) {
                startCombat(entity);
            }
        }
    });

    // ══════════════════════════════════════════════════════════
    // ── EXPLOSIVE AVOIDANCE ─────────────────────────────────────
    // ══════════════════════════════════════════════════════════
    const EXPLOSIVE_ENTITIES = ['creeper', 'tnt', 'tnt_minecart', 'end_crystal'];
    const EXPLOSIVE_BLOCKS   = ['tnt', 'respawn_anchor'];
    let lastExplosiveFleeLog = 0;

    function findNearestExplosiveEntity(range) {
        if (!bot?.entity) return null;
        return bot.nearestEntity(e => {
            if (!e?.position || !e.isValid) return false;
            const dist = e.position.distanceTo(bot.entity.position);
            if (dist > range) return false;
            const name = (e.name || '').toLowerCase();
            // Creeper: only flee if it's close (about to detonate)
            if (name === 'creeper') return dist < (config.explosive_avoidance?.flee_radius || 8);
            return EXPLOSIVE_ENTITIES.some(ex => name.includes(ex));
        });
    }

    function findNearestExplosiveBlock(range) {
        if (!bot || !mcData) return null;
        for (const bName of EXPLOSIVE_BLOCKS) {
            const blockType = mcData.blocksByName[bName];
            if (!blockType) continue;
            const found = bot.findBlock({ matching: blockType.id, maxDistance: range });
            if (found) return found;
        }
        return null;
    }

    let explosiveFleeCooldown = 0;

    function fleeFromExplosive(dangerPos, name) {
        const now = Date.now();
        if (now - lastExplosiveFleeLog > 3000) {
            log('warn', `💣 Explosive nearby: ${name}! Fleeing...`);
            lastExplosiveFleeLog = now;
        }
        explosiveFleeCooldown = now + 3000; // Don't re-engage combat for 3s
        // Run in opposite direction
        const dx = bot.entity.position.x - dangerPos.x;
        const dz = bot.entity.position.z - dangerPos.z;
        const len = Math.sqrt(dx * dx + dz * dz) || 1;
        const safe = config.explosive_avoidance?.safe_radius || 16;
        const fleeX = bot.entity.position.x + (dx / len) * safe;
        const fleeZ = bot.entity.position.z + (dz / len) * safe;
        // Interrupt combat if needed
        if (combatLoop) stopCombat('explosive nearby');
        bot.pathfinder.setGoal(new goals.GoalNear(fleeX, bot.entity.position.y, fleeZ, 2), true);
    }

    // Integrated into threat scanner below

    // ══════════════════════════════════════════════════════════
    // ── FOOD SOURCING (chests + animal hunting) ───────────────
    // ══════════════════════════════════════════════════════════
    const FOOD_ITEMS = [
        'apple', 'bread', 'cooked_beef', 'cooked_chicken', 'cooked_cod',
        'cooked_mutton', 'cooked_porkchop', 'cooked_rabbit', 'cooked_salmon',
        'golden_apple', 'enchanted_golden_apple', 'golden_carrot',
        'baked_potato', 'beetroot', 'carrot', 'melon_slice', 'sweet_berries',
        'glow_berries', 'dried_kelp', 'mushroom_stew', 'rabbit_stew',
        'beetroot_soup', 'suspicious_stew', 'cookie', 'pumpkin_pie',
        'beef', 'porkchop', 'chicken', 'mutton', 'rabbit', 'cod', 'salmon',
        'rotten_flesh', 'spider_eye', 'potato'
    ];
    const FOOD_ANIMALS = ['pig', 'cow', 'chicken', 'sheep', 'rabbit', 'mooshroom'];
    const FOOD_DROPS = {
        pig: 'porkchop', cow: 'beef', chicken: 'chicken',
        sheep: 'mutton', rabbit: 'rabbit', mooshroom: 'beef'
    };

    function isFood(item) {
        if (!item) return false;
        return FOOD_ITEMS.some(f => item.name.includes(f));
    }

    function countFoodInInventory() {
        if (!bot?.inventory) return 0;
        return bot.inventory.items().filter(isFood).reduce((sum, i) => sum + i.count, 0);
    }

    function needsFood() {
        const threshold = config.food?.hunger_threshold ?? 14;
        const minSlots = config.food?.min_food_slots ?? 4;
        return bot.food <= threshold || countFoodInInventory() < minSlots;
    }

    async function searchFoodInChests() {
        if (!bot || !mcData) return false;
        const radius = config.food?.chest_search_radius || 16;
        const chestTypes = ['chest', 'trapped_chest', 'barrel', 'ender_chest'];
        // Also search shulker boxes
        const shulkerNames = Object.keys(mcData.blocksByName).filter(n => n.includes('shulker_box'));
        const allContainerNames = [...chestTypes, ...shulkerNames];

        for (const cName of allContainerNames) {
            const blockType = mcData.blocksByName[cName];
            if (!blockType) continue;
            const chest = bot.findBlock({ matching: blockType.id, maxDistance: radius });
            if (!chest) continue;

            try {
                await bot.pathfinder.goto(new goals.GoalGetToBlock(chest.position.x, chest.position.y, chest.position.z));
                const container = await bot.openContainer(chest);
                const foodItems = container.containerItems().filter(isFood);
                if (foodItems.length > 0) {
                    for (const item of foodItems) {
                        const take = Math.min(item.count, 32);
                        try {
                            await container.withdraw(item.type, null, take);
                            log('success', `Took ${take}x ${item.name} from ${cName}`);
                        } catch {}
                    }
                    container.close();
                    return true;
                }
                container.close();
            } catch (e) {
                log('debug', `Can't access ${cName}:`, e.message);
            }
        }
        return false;
    }

    async function huntFoodAnimal() {
        if (!bot?.entity) return false;
        const radius = config.food?.hunt_radius || 16;
        const target = bot.nearestEntity(e => {
            if (!e?.position || !e.isValid) return false;
            if (e.position.distanceTo(bot.entity.position) > radius) return false;
            const name = (e.name || '').toLowerCase();
            return FOOD_ANIMALS.some(a => name === a);
        });
        if (!target) {
            log('debug', 'No food animals nearby.');
            return false;
        }

        log('info', `🍖 Hunting ${target.name} for food...`);
        await equipBestWeapon();

        // Chase and kill
        return new Promise((resolve) => {
            let huntHits = 0;
            const huntLoop = setInterval(() => {
                if (!bot?.entity || !target?.isValid || huntHits > 30) {
                    clearInterval(huntLoop);
                    bot?.pathfinder?.stop();
                    resolve(target && !target.isValid); // true if we killed it
                    return;
                }
                const dist = target.position.distanceTo(bot.entity.position);
                if (dist > 3.5) {
                    bot.pathfinder.setGoal(new goals.GoalFollow(target, 2), true);
                }
                if (dist <= 3.5) {
                    bot.lookAt(target.position.offset(0, target.height * 0.8, 0));
                    bot.attack(target);
                    huntHits++;
                }
            }, 250);
            // Timeout after 15s
            setTimeout(() => {
                clearInterval(huntLoop);
                bot?.pathfinder?.stop();
                resolve(false);
            }, 15000);
        });
    }

    async function autoSourceFood() {
        if (!config.features.auto_food_source || !needsFood() || isBusy) return;
        isBusy = true;
        log('info', `🍖 Food low (food=${bot.food}, inv=${countFoodInInventory()}). Sourcing...`);
        try {
            // First try chests
            const gotFromChest = await searchFoodInChests();
            if (gotFromChest) { isBusy = false; return; }
            // Then try hunting
            const hunted = await huntFoodAnimal();
            if (hunted) log('success', '🍖 Killed animal for food.');
        } catch (e) {
            log('debug', 'Food sourcing failed:', e.message);
        } finally {
            isBusy = false;
        }
    }

    // ══════════════════════════════════════════════════════════
    // ── AUTO-STASH LOOT (chests/ender chests/shulkers) ───────
    // ══════════════════════════════════════════════════════════
    function shouldKeep(item) {
        if (!item) return true;
        const name = item.name;
        // Always keep food
        if (config.stash?.keep_food !== false && isFood(item)) return true;
        // Always keep tools
        if (config.stash?.keep_tools !== false) {
            if (name.includes('sword') || name.includes('axe') || name.includes('pickaxe') ||
                name.includes('shovel') || name.includes('hoe') || name.includes('bow') ||
                name.includes('crossbow') || name.includes('trident') || name.includes('shield') ||
                name.includes('fishing_rod') || name.includes('shears') ||
                name.includes('flint_and_steel') || name.includes('totem')) return true;
        }
        // Always keep armor
        if (config.stash?.keep_armor !== false) {
            if (name.includes('helmet') || name.includes('chestplate') ||
                name.includes('leggings') || name.includes('boots') ||
                name.includes('elytra') || name.includes('turtle_helmet')) return true;
        }
        return false;
    }

    async function autoStashLoot() {
        if (!config.features.auto_stash || isBusy) return;
        if (!bot?.inventory || !mcData) return;

        // Only stash if inventory has significant items
        const stashable = bot.inventory.items().filter(i => !shouldKeep(i));
        if (stashable.length === 0) return;

        const radius = config.stash?.search_radius || 16;
        const containerNames = ['chest', 'trapped_chest', 'barrel', 'ender_chest'];
        const shulkerNames = Object.keys(mcData.blocksByName).filter(n => n.includes('shulker_box'));
        const allNames = [...containerNames, ...shulkerNames];

        for (const cName of allNames) {
            const blockType = mcData.blocksByName[cName];
            if (!blockType) continue;
            const chest = bot.findBlock({ matching: blockType.id, maxDistance: radius });
            if (!chest) continue;

            isBusy = true;
            try {
                await bot.pathfinder.goto(new goals.GoalGetToBlock(chest.position.x, chest.position.y, chest.position.z));
                const container = await bot.openContainer(chest);

                let deposited = 0;
                for (const item of stashable) {
                    // Re-check: item might have been used
                    const current = bot.inventory.items().find(i => i.type === item.type && i.count > 0);
                    if (!current) continue;
                    try {
                        await container.deposit(current.type, null, current.count);
                        deposited += current.count;
                    } catch {
                        // Container might be full
                        break;
                    }
                }
                container.close();
                if (deposited > 0) {
                    log('success', `📦 Stashed ${deposited} items into ${cName}`);
                }
            } catch (e) {
                log('debug', `Stash to ${cName} failed:`, e.message);
            } finally {
                isBusy = false;
            }
            return; // Only use first found container
        }
    }

    // ── Health tracking ──
    bot.on('health', () => {
        botHealth = bot.health;
        botFood = bot.food;
        emitStatus();
    });

    // ── Chat / Auth / Captcha ──
    bot.on('messagestr', (msg, type) => {
        if (type === 'game_info') return;
        log('chat', msg);

        const m = msg.toLowerCase();

        // Captcha — only respond if message looks like a captcha prompt (short, contains math)
        if (config.features.solve_math_captcha && msg.length < 80) {
            const mathMatch = m.match(/(\d+)\s*([\+\-\*\/])\s*(\d+)/);
            if (mathMatch) {
                const res = solveMath(m);
                if (res !== null) {
                    log('brain', `Captcha solved: ${msg}`, `Answer: ${res}`);
                    bot.chat(res.toString());
                    return;
                }
            }
        }

        // Auth — only trigger once per connection, with stricter patterns
        if (!authDone) {
            const isRegisterPrompt = (m.includes('/register') && (m.includes('password') || m.includes('mật khẩu') || m.includes('<')));
            const isLoginPrompt    = (m.includes('/login')    && (m.includes('password') || m.includes('mật khẩu') || m.includes('<')));

            if (isRegisterPrompt) {
                const cmd = (config.auth_settings?.register_cmd || '/register {pass} {pass}').replace(/{pass}/g, ENV.password);
                log('info', 'Register prompt detected.', 'Sending register command...');
                bot.chat(cmd);
                authDone = true;
            } else if (isLoginPrompt) {
                const cmd = (config.auth_settings?.login_cmd || '/login {pass}').replace(/{pass}/g, ENV.password);
                log('info', 'Login prompt detected.', 'Sending login command...');
                bot.chat(cmd);
                authDone = true;
            }
        }
    });

    // ── AFK Loop ──
    // ── Hazard detection helpers ──
    function isBlockDangerous(pos) {
        if (!bot || !mcData) return false;
        try {
            const block = bot.blockAt(pos);
            if (!block) return true; // unknown = dangerous
            const name = block.name;
            if (name === 'lava' || name === 'fire' || name === 'soul_fire'
                || name === 'magma_block' || name === 'cactus'
                || name === 'sweet_berry_bush' || name === 'campfire'
                || name === 'powder_snow') return true;
            // Check for deep drops: look down from the position
            let dropDepth = 0;
            for (let dy = -1; dy >= -8; dy--) {
                const below = bot.blockAt(pos.offset(0, dy, 0));
                if (!below || below.name === 'air' || below.name === 'cave_air' || below.name === 'void_air') {
                    dropDepth++;
                } else if (below.name === 'lava') {
                    return true; // lava below = always dangerous
                } else {
                    break;
                }
            }
            if (dropDepth > 5) return true;
        } catch { return false; }
        return false;
    }

    function findSafeWanderGoal(maxRadius) {
        if (!bot?.entity || !spawnPoint) return null;
        const radius = maxRadius || config.afk?.wander_radius || 32;
        // Try several random directions to find a safe spot
        for (let attempt = 0; attempt < 10; attempt++) {
            const angle = Math.random() * Math.PI * 2;
            const dist = 6 + Math.random() * (radius - 6); // at least 6 blocks away
            const tx = spawnPoint.x + Math.cos(angle) * dist;
            const tz = spawnPoint.z + Math.sin(angle) * dist;
            // Find ground level at target
            let ty = bot.entity.position.y;
            try {
                for (let dy = 5; dy >= -10; dy--) {
                    const b = bot.blockAt({ x: Math.floor(tx), y: Math.floor(ty) + dy, z: Math.floor(tz) });
                    const bAbove = bot.blockAt({ x: Math.floor(tx), y: Math.floor(ty) + dy + 1, z: Math.floor(tz) });
                    if (b && b.name !== 'air' && b.name !== 'cave_air' && b.name !== 'lava'
                        && b.name !== 'water' && bAbove && (bAbove.name === 'air' || bAbove.name === 'cave_air')) {
                        const groundPos = { x: tx, y: Math.floor(ty) + dy + 1, z: tz };
                        if (!isBlockDangerous(groundPos)) return groundPos;
                        break;
                    }
                }
            } catch { continue; }
        }
        return null;
    }

    // ── Smart AFK Loop ──
    function startSmartAFK() {
        if (afkLoop) clearInterval(afkLoop);
        const interval = config.afk?.interval_ms || 15000;
        let lastWanderTime = 0;
        let lastLookTime = 0;

        afkLoop = setInterval(async () => {
            if (!bot?.entity) return;
            emitStatus();
            const now = Date.now();

            // ━━ These run even during combat ━━

            // Re-equip armor periodically
            if (config.features.auto_equip) {
                try { bot.armorManager.equipAll(); } catch {}
            }

            // Auto food sourcing — urgent if food is very low
            if (config.features.auto_food_source && !isBusy && needsFood() && (now - lastFoodSourceTime > 30000)) {
                lastFoodSourceTime = now;
                await autoSourceFood();
                return;
            }

            // Auto stash loot (respect configured interval)
            const stashInterval = config.stash?.interval_ms || 60000;
            if (config.features.auto_stash && !isBusy && (now - lastStashTime > stashInterval)) {
                lastStashTime = now;
                await autoStashLoot();
                return;
            }

            // ━━ Below only runs when not busy ━━
            if (isBusy) return;

            // Auto sleep
            if (config.features.auto_sleep && (bot.time.timeOfDay >= 13000 || bot.isRaining)) {
                const bed = bot.findBlock({ matching: blk => blk.name.includes('bed'), maxDistance: 32 });
                if (bed && !bot.isSleeping) {
                    isBusy = true;
                    log('info', 'Found bed, going to sleep...');
                    try {
                        await bot.pathfinder.goto(new goals.GoalGetToBlock(bed.position.x, bed.position.y, bed.position.z));
                        await bot.sleep(bed);
                        log('success', 'Sleeping.');
                    } catch (err) {
                        log('warn', 'Sleep failed:', err.message);
                    } finally {
                        isBusy = false;
                    }
                    return;
                }
            }

            // ── Hazard check: if standing on/near danger, flee immediately ──
            const curPos = bot.entity.position;
            if (isBlockDangerous(curPos) || isBlockDangerous(curPos.offset(0, -1, 0))) {
                log('warn', '⚠️ Standing near hazard! Moving to safety...');
                const safe = findSafeWanderGoal(10);
                if (safe) bot.pathfinder.setGoal(new goals.GoalNear(safe.x, safe.y, safe.z, 1), true);
                return;
            }

            // ── Drift protection: return to spawn if too far ──
            const fleeHP = config.combat?.flee_health || 6;
            const wanderRadius = config.afk?.wander_radius || 32;
            if (spawnPoint && bot.health > fleeHP && curPos.distanceTo(spawnPoint) > wanderRadius + 5) {
                log('info', 'Drifted too far, returning to spawn area...');
                bot.pathfinder.setGoal(new goals.GoalNear(spawnPoint.x, spawnPoint.y, spawnPoint.z, 3));
                return;
            }

            // ── Human-like behavior: weighted random actions ──
            const r = Math.random();

            // 40% chance: Wander to a new spot (explore / hunt mobs)
            if (r < 0.40 && (now - lastWanderTime > 20000)) {
                lastWanderTime = now;
                // Look for nearby hostile mobs first — walk toward them
                const scanRange = config.afk?.wander_radius || 32;
                const nearbyMob = bot.nearestEntity(e => {
                    if (!e?.position || !e.isValid) return false;
                    if (e.position.distanceTo(curPos) > scanRange) return false;
                    return isHostile(e);
                });
                if (nearbyMob && nearbyMob.position.distanceTo(curPos) > 4) {
                    // Walk toward mob (combat scanner will engage when close enough)
                    const mp = nearbyMob.position;
                    log('debug', `Roaming toward ${nearbyMob.name} (${mp.distanceTo(curPos).toFixed(0)}m away)`);
                    bot.pathfinder.setGoal(new goals.GoalNear(mp.x, mp.y, mp.z, 3), true);
                } else {
                    // Random explore within wander radius
                    const target = findSafeWanderGoal(wanderRadius);
                    if (target) {
                        bot.pathfinder.setGoal(new goals.GoalNear(target.x, target.y, target.z, 2), true);
                    }
                }
            }
            // 15% chance: Look around (scan surroundings)
            else if (r < 0.55 && (now - lastLookTime > 5000)) {
                lastLookTime = now;
                // Look at nearest entity if any, otherwise random look
                const nearEntity = bot.nearestEntity(e => e?.position && e.isValid && e.position.distanceTo(curPos) < 16);
                if (nearEntity) {
                    bot.lookAt(nearEntity.position.offset(0, nearEntity.height * 0.8, 0));
                } else {
                    bot.look(bot.entity.yaw + (Math.random() - 0.5) * 2.5, (Math.random() - 0.5) * 0.6, true);
                }
            }
            // 10% chance: Jump
            else if (r < 0.65) {
                bot.setControlState('jump', true);
                setTimeout(() => bot.setControlState('jump', false), 400);
            }
            // 8% chance: Sneak briefly
            else if (r < 0.73) {
                bot.setControlState('sneak', true);
                setTimeout(() => bot.setControlState('sneak', false), 600 + Math.random() * 600);
            }
            // 7% chance: Swing arm
            else if (r < 0.80) {
                bot.swingArm(Math.random() > 0.5 ? 'right' : 'left');
            }
            // 5% chance: Sprint briefly in current direction
            else if (r < 0.85) {
                bot.setControlState('sprint', true);
                bot.setControlState('forward', true);
                setTimeout(() => {
                    bot.setControlState('sprint', false);
                    bot.setControlState('forward', false);
                }, 800 + Math.random() * 1200);
            }
            // 15% chance: do nothing (idle — real players pause too)
        }, interval);
    }
}

// ─── DASHBOARD SERVER ────────────────────────────────────────────────
const app = express();
const server = http.createServer(app);
const io = new SocketIO(server);

// ─── VIEWER ROUTES (same port, under /viewer/) ──────────────────────
const viewerPublicDir = path.join(__dirname, 'node_modules', 'prismarine-viewer', 'public');
app.use('/viewer', compression());
// Serve our custom viewer page at /viewer/ (before static so it takes priority over index.html)
app.get('/viewer/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'viewer.html'));
});
app.use('/viewer', express.static(viewerPublicDir));

// Viewer Socket.IO — separate instance on path /viewer/socket.io
const viewerIO = new SocketIO(server, { path: '/viewer/socket.io' });
viewerIO.on('connection', (vSocket) => {
    if (!viewerActive || !bot || botStatus !== 'online') {
        vSocket.disconnect(true);
        return;
    }
    log('debug', 'Viewer client connected.');
    viewerSockets.push(vSocket);

    // Send version so client can load textures
    vSocket.emit('version', bot.version);

    // Create WorldView for this client
    const worldView = new WorldView(bot.world, 4, bot.entity.position, vSocket);
    worldView.init(bot.entity.position);

    // First-person camera position updates
    function botPosition() {
        vSocket.emit('position', {
            pos: bot.entity.position,
            yaw: bot.entity.yaw,
            pitch: bot.entity.pitch,
        });
        worldView.updatePosition(bot.entity.position);
    }

    bot.on('move', botPosition);
    worldView.listenToBot(bot);

    vSocket.on('disconnect', () => {
        bot?.removeListener('move', botPosition);
        try { worldView.removeListenersFromBot(bot); } catch {}
        viewerSockets = viewerSockets.filter(s => s !== vSocket);
        log('debug', 'Viewer client disconnected.');
    });
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── SETTINGS API ────────────────────────────────────────────────────
function isSetupNeeded() {
    // Setup is needed if .env doesn't exist yet (first run)
    return !fs.existsSync(envPath);
}

app.get('/api/settings', (req, res) => {
    res.json({
        ip: ENV.ip,
        port: ENV.port,
        username: ENV.username,
        password: ENV.password,
        auth: ENV.auth,
        first_time_message: config.entry_settings?.first_time_message || '',
        needsSetup: isSetupNeeded(),
    });
});

app.post('/api/settings', (req, res) => {
    const { ip, port, username, password, first_time_message } = req.body;
    if (!ip || !username) return res.status(400).json({ error: 'IP and username are required' });

    // Parse IP:Port or Domain:Port
    let host = ip, prt = port || 25565;
    if (ip.includes(':')) {
        const parts = ip.split(':');
        host = parts[0];
        prt = parseInt(parts[1]) || 25565;
    }

    // Update runtime ENV
    ENV.ip = host;
    ENV.port = parseInt(prt);
    ENV.username = username;
    ENV.password = password || '';

    // Update config
    config.entry_settings.first_time_message = first_time_message || '';

    // Persist to .env
    const envContent = [
        '# Minecraft Server',
        `SERVER_IP=${ENV.ip}`,
        `SERVER_PORT=${ENV.port}`,
        '',
        '# Bot Account',
        `BOT_USERNAME=${ENV.username}`,
        `BOT_PASSWORD=${ENV.password}`,
        `BOT_AUTH_TYPE=${ENV.auth}`,
    ].join('\n');
    fs.writeFileSync(envPath, envContent);

    // Persist config.json
    fs.writeFileSync(path.join(__dirname, 'config.json'), JSON.stringify(config, null, 2));

    log('success', 'Settings updated.', `${ENV.ip}:${ENV.port} as ${ENV.username}`);
    emitStatus();
    res.json({ ok: true });
});

io.on('connection', (socket) => {
    // Send full log history
    socket.emit('init', { logs: consoleLogs });
    emitStatus();
    socket.emit('viewer-status', { active: viewerActive });

    // Chat input from dashboard
    socket.on('chat', (msg) => {
        if (bot && botStatus === 'online' && typeof msg === 'string' && msg.trim()) {
            log('info', `Dashboard → ${msg.trim()}`);
            bot.chat(msg.trim());
        }
    });

    // Manual commands
    socket.on('command', (cmd) => {
        switch (cmd) {
            case 'connect':
                if (botStatus === 'offline' || botStatus === 'reconnecting') {
                    reconnectAttempt = 0;
                    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
                    createBot();
                }
                break;
            case 'disconnect':
                config.features.auto_reconnect = false;
                if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
                if (bot) { bot.end(); bot = null; }
                botStatus = 'offline';
                emitStatus();
                log('info', 'Manually disconnected.');
                break;
            case 'reconnect-on':
                config.features.auto_reconnect = true;
                log('info', 'Auto-reconnect enabled.');
                break;
            case 'reconnect-off':
                config.features.auto_reconnect = false;
                if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
                log('info', 'Auto-reconnect disabled.');
                break;
            case 'save-reconnect':
                // Disconnect and reconnect with new settings
                if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
                if (bot) { bot.end(); bot = null; }
                botStatus = 'offline';
                emitStatus();
                log('info', 'Reconnecting with new settings...');
                setTimeout(createBot, 1000);
                break;
        }
    });
});

const DASH_PORT = config.dashboard?.port || 8999;
server.listen(DASH_PORT, () => {
    log('success', `Dashboard running on http://localhost:${DASH_PORT}`);
});

// ─── GRACEFUL SHUTDOWN ───────────────────────────────────────────────
function shutdown(signal) {
    log('info', `Received ${signal}, shutting down...`);
    if (afkLoop) clearInterval(afkLoop);
    if (reconnectTimer) clearTimeout(reconnectTimer);
    closeViewer();
    if (bot) bot.end();
    server.close();
    process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// Catch uncaught errors (e.g. AggregateError from mineflayer) so they don't crash the process
process.on('uncaughtException', (err) => {
    const m = err.message || err.code || String(err);
    log('error', 'Uncaught error', m);
});
process.on('unhandledRejection', (err) => {
    const m = err?.message || err?.code || String(err);
    log('error', 'Unhandled rejection', m);
});

// ─── AUTO-START BOT ──────────────────────────────────────────────────
// Skip auto-connect on first run — wait for user to configure via dashboard
if (isSetupNeeded()) {
    log('info', 'Waiting for setup... Open the dashboard and configure server settings.');
} else {
    createBot();
}
