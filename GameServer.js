import { v4 as uuidv4 } from 'uuid';

const TICK_RATE = 20;
const TICK_INTERVAL = 1000 / TICK_RATE;
const MAX_PLAYERS = 10;

const TEAMS = { A: 'teamA', B: 'teamB' };

const SPAWN_A = { x: 0, y: 1, z: -48 };
const SPAWN_B = { x: 0, y: 1, z: 48 };

const WEAPONS = {
  AR: { name: 'Assault Rifle', slot: 0, damage: 22, range: 80 },
  PISTOL: { name: 'Pistol', slot: 1, damage: 35, range: 50 },
  KNIFE: { name: 'Knife', slot: 2, damage: 110, range: 2.5 },
  GRENADE: { name: 'Frag Grenade', slot: 3, damage: 100, range: 15 },
  SNIPER: { name: 'Sniper Rifle', slot: 4, damage: 90, range: 150 },
};

function calculateDamage(baseDamage, distance, maxRange, isSniper = false) {
  if (isSniper) return baseDamage; // no falloff
  return baseDamage * Math.max(0, 1 - distance / maxRange);
}

export class GameServer {
  constructor(io) {
    this.io = io;
    this.lobbies = new Map(); // lobbyId -> lobby state
    this.playerLobbyMap = new Map(); // socketId -> lobbyId

    this.io.on('connection', (socket) => this.onConnection(socket));

    // Game loop
    setInterval(() => this.tick(), TICK_INTERVAL);

    console.log('[GameServer] Initialized');
  }

  onConnection(socket) {
    console.log(`[Connect] ${socket.id}`);

    socket.on('create_lobby', (data, callback) => {
      const lobbyId = uuidv4().slice(0, 6).toUpperCase();
      this.lobbies.set(lobbyId, {
        id: lobbyId,
        players: new Map(),
        state: 'waiting', // waiting | playing | ended
        scores: { [TEAMS.A]: 0, [TEAMS.B]: 0 },
        scoreLimit: 30,
        timeLimit: 5 * 60 * 1000,
        startTime: null,
      });
      console.log(`[Lobby] Created: ${lobbyId}`);
      callback({ lobbyId });
    });

    socket.on('join_lobby', (data, callback) => {
      const { lobbyId, playerName } = data;
      const lobby = this.lobbies.get(lobbyId);

      if (!lobby) {
        callback({ error: 'Lobby not found' });
        return;
      }
      if (lobby.players.size >= MAX_PLAYERS) {
        callback({ error: 'Lobby is full' });
        return;
      }

      // Auto-balance teams
      let teamACount = 0;
      let teamBCount = 0;
      for (const p of lobby.players.values()) {
        if (p.team === TEAMS.A) teamACount++;
        else teamBCount++;
      }
      const team = teamACount <= teamBCount ? TEAMS.A : TEAMS.B;
      const spawn = team === TEAMS.A ? SPAWN_A : SPAWN_B;

      const player = {
        id: socket.id,
        name: playerName || `Player${lobby.players.size + 1}`,
        team,
        position: { ...spawn },
        rotation: { x: 0, y: 0 },
        health: 100,
        alive: true,
        weapon: 0, // current weapon slot
        kills: 0,
        deaths: 0,
        lastInput: null,
      };

      lobby.players.set(socket.id, player);
      this.playerLobbyMap.set(socket.id, lobbyId);
      socket.join(lobbyId);

      // Tell everyone about new player
      socket.to(lobbyId).emit('player_joined', {
        id: player.id,
        name: player.name,
        team: player.team,
        position: player.position,
      });

      // Send full state to joining player
      const existingPlayers = [];
      for (const [id, p] of lobby.players) {
        if (id !== socket.id) {
          existingPlayers.push({
            id: p.id,
            name: p.name,
            team: p.team,
            position: p.position,
          });
        }
      }

      callback({
        success: true,
        player,
        existingPlayers,
        scores: lobby.scores,
        state: lobby.state,
      });

      console.log(`[Lobby ${lobbyId}] ${player.name} joined ${team} (${lobby.players.size} players)`);
    });

    socket.on('player_input', (data) => {
      const lobbyId = this.playerLobbyMap.get(socket.id);
      if (!lobbyId) return;
      const lobby = this.lobbies.get(lobbyId);
      if (!lobby) return;
      const player = lobby.players.get(socket.id);
      if (!player) return;

      // Authoritative position updates from client (trust for now, add server auth later)
      if (data.position) {
        player.position = data.position;
      }
      if (data.rotation) {
        player.rotation = data.rotation;
      }
    });

    socket.on('shoot', (data) => {
      const lobbyId = this.playerLobbyMap.get(socket.id);
      if (!lobbyId) return;
      const lobby = this.lobbies.get(lobbyId);
      if (!lobby) return;
      const shooter = lobby.players.get(socket.id);
      if (!shooter || !shooter.alive) return;

      const weaponKeys = ['AR', 'PISTOL', 'KNIFE', 'GRENADE', 'SNIPER'];
      const weaponKey = weaponKeys[data.weapon] || 'AR';
      const weapon = WEAPONS[weaponKey];

      // Grenade AoE — multiple hit players with distances
      if (data.grenadeAoE && Array.isArray(data.hitPlayers)) {
        for (const hp of data.hitPlayers) {
          const target = lobby.players.get(hp.id);
          if (!target || !target.alive || target.team === shooter.team) continue;
          const damage = calculateDamage(weapon.damage, hp.distance, weapon.range, weaponKey === 'SNIPER');
          if (damage <= 0) continue;

          target.health -= damage;

          if (target.health <= 0) {
            target.health = 0;
            target.alive = false;
            target.deaths++;
            shooter.kills++;
            lobby.scores[shooter.team]++;

            this.io.to(lobbyId).emit('player_killed', {
              killerId: shooter.id,
              killerName: shooter.name,
              victimId: target.id,
              victimName: target.name,
              weapon: weapon.name,
            });

            setTimeout(() => {
              if (lobby.players.has(target.id)) {
                const spawn = target.team === TEAMS.A ? SPAWN_A : SPAWN_B;
                target.position = { ...spawn };
                target.health = 100;
                target.alive = true;
                this.io.to(lobbyId).emit('player_respawn', {
                  id: target.id,
                  position: target.position,
                });
              }
            }, 3000);
          } else {
            this.io.to(target.id).emit('damage', {
              health: target.health,
              attackerId: shooter.id,
            });
          }
        }
      }

      // Raycast hit check — client sends hit player ID and distance
      else if (data.hitPlayerId && data.distance !== undefined) {
        const target = lobby.players.get(data.hitPlayerId);
        if (target && target.alive && target.team !== shooter.team) {
          let damage = calculateDamage(weapon.damage, data.distance, weapon.range, weaponKey === 'SNIPER');
          let isBackstab = false;
          let isHeadshot = false;

          // Backstab: knife from behind within melee range = instant kill
          if (weaponKey === 'KNIFE' && data.distance <= weapon.range && data.direction && target.rotation) {
            const atkX = data.direction.x || 0;
            const atkZ = data.direction.z || 0;
            const targetYaw = target.rotation.y || 0;
            const tgtFwdX = Math.sin(targetYaw);
            const tgtFwdZ = Math.cos(targetYaw);
            const dot = atkX * tgtFwdX + atkZ * tgtFwdZ;
            if (dot > 0.3) {
              damage = 9999;
              isBackstab = true;
            }
          }

          // Headshot: AR/Pistol get 1.5x, Sniper gets instant kill
          if (!isBackstab && data.headshot && (weaponKey === 'AR' || weaponKey === 'PISTOL' || weaponKey === 'SNIPER')) {
            if (weaponKey === 'SNIPER') {
              damage = 9999; // sniper headshot = instant kill
            } else {
              damage *= 1.5;
            }
            isHeadshot = true;
          }

          target.health -= damage;

          if (target.health <= 0) {
            target.health = 0;
            target.alive = false;
            target.deaths++;
            shooter.kills++;
            lobby.scores[shooter.team]++;

            const killWeapon = isBackstab ? 'BACKSTAB' : (isHeadshot ? weapon.name + ' HEADSHOT' : weapon.name);
            this.io.to(lobbyId).emit('player_killed', {
              killerId: shooter.id,
              killerName: shooter.name,
              victimId: target.id,
              victimName: target.name,
              weapon: killWeapon,
            });

            // Respawn after 3 seconds
            setTimeout(() => {
              if (lobby.players.has(target.id)) {
                const spawn = target.team === TEAMS.A ? SPAWN_A : SPAWN_B;
                target.position = { ...spawn };
                target.health = 100;
                target.alive = true;
                this.io.to(lobbyId).emit('player_respawn', {
                  id: target.id,
                  position: target.position,
                });
              }
            }, 3000);
          } else {
            this.io.to(target.id).emit('damage', {
              health: target.health,
              attackerId: shooter.id,
            });
          }
        }
      }

      // Broadcast shot visual to others
      socket.to(lobbyId).emit('player_shot', {
        id: socket.id,
        weapon: data.weapon,
        origin: data.origin,
        direction: data.direction,
      });
    });

    socket.on('throw_grenade', (data) => {
      const lobbyId = this.playerLobbyMap.get(socket.id);
      if (!lobbyId) return;
      // Broadcast grenade to all in lobby
      this.io.to(lobbyId).emit('grenade_thrown', {
        id: socket.id,
        position: data.position,
        velocity: data.velocity,
      });
    });

    socket.on('start_game', () => {
      const lobbyId = this.playerLobbyMap.get(socket.id);
      if (!lobbyId) return;
      const lobby = this.lobbies.get(lobbyId);
      if (!lobby || lobby.state !== 'waiting') return;

      lobby.state = 'playing';
      lobby.startTime = Date.now();
      this.io.to(lobbyId).emit('game_started', { startTime: lobby.startTime });
      console.log(`[Lobby ${lobbyId}] Game started!`);
    });

    socket.on('disconnect', () => {
      const lobbyId = this.playerLobbyMap.get(socket.id);
      if (lobbyId) {
        const lobby = this.lobbies.get(lobbyId);
        if (lobby) {
          const player = lobby.players.get(socket.id);
          lobby.players.delete(socket.id);
          this.io.to(lobbyId).emit('player_left', { id: socket.id });
          console.log(`[Lobby ${lobbyId}] ${player?.name || socket.id} left (${lobby.players.size} players)`);

          if (lobby.players.size === 0) {
            this.lobbies.delete(lobbyId);
            console.log(`[Lobby ${lobbyId}] Deleted (empty)`);
          }
        }
        this.playerLobbyMap.delete(socket.id);
      }
      console.log(`[Disconnect] ${socket.id}`);
    });
  }

  tick() {
    for (const [lobbyId, lobby] of this.lobbies) {
      if (lobby.players.size === 0) continue;

      // Build state snapshot
      const players = [];
      for (const p of lobby.players.values()) {
        players.push({
          id: p.id,
          position: p.position,
          rotation: p.rotation,
          health: p.health,
          alive: p.alive,
          weapon: p.weapon,
          team: p.team,
        });
      }

      this.io.to(lobbyId).emit('state', {
        players,
        scores: lobby.scores,
        serverTime: Date.now(),
      });

      // Check win conditions
      if (lobby.state === 'playing') {
        const elapsed = Date.now() - lobby.startTime;
        if (
          lobby.scores[TEAMS.A] >= lobby.scoreLimit ||
          lobby.scores[TEAMS.B] >= lobby.scoreLimit ||
          elapsed >= lobby.timeLimit
        ) {
          const winner =
            lobby.scores[TEAMS.A] > lobby.scores[TEAMS.B]
              ? TEAMS.A
              : lobby.scores[TEAMS.B] > lobby.scores[TEAMS.A]
                ? TEAMS.B
                : 'draw';
          lobby.state = 'ended';
          this.io.to(lobbyId).emit('game_over', { winner, scores: lobby.scores });
          console.log(`[Lobby ${lobbyId}] Game over! Winner: ${winner}`);
        }
      }
    }
  }
}
