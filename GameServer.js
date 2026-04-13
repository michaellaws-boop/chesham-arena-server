import { v4 as uuidv4 } from 'uuid';

const TICK_RATE = 20;
const TICK_INTERVAL = 1000 / TICK_RATE;
const MAX_PLAYERS = 10;
const ROUNDS_TO_WIN = 3;

const TEAMS = { A: 'teamA', B: 'teamB' };

const SPAWN_A = { x: 0, y: 1, z: -48 };
const SPAWN_B = { x: 0, y: 1, z: 48 };

const WEAPONS = {
  AR: { name: 'Assault Rifle', slot: 0, damage: 22, range: 80 },
  PISTOL: { name: 'Pistol', slot: 1, damage: 35, range: 50 },
  KNIFE: { name: 'Knife', slot: 2, damage: 110, range: 2.5 },
  GRENADE: { name: 'Frag Grenade', slot: 3, damage: 100, range: 15 },
  SNIPER: { name: 'Sniper Rifle', slot: 4, damage: 50, range: 150 },
};

function calculateDamage(baseDamage, distance, maxRange, isSniper = false) {
  if (isSniper) return baseDamage; // no falloff
  return baseDamage * Math.max(0, 1 - distance / maxRange);
}

export class GameServer {
  constructor(io) {
    this.io = io;
    this.lobbies = new Map();
    this.playerLobbyMap = new Map();

    this.io.on('connection', (socket) => this.onConnection(socket));
    setInterval(() => this.tick(), TICK_INTERVAL);
    console.log('[GameServer] Initialized');
  }

  // Handle a kill: update scores, emit events, respawn BOTH players for new round
  handleKill(lobbyId, lobby, shooter, target, weaponLabel) {
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
      weapon: weaponLabel,
      scores: lobby.scores,
    });

    // Check for match win
    if (lobby.scores[shooter.team] >= ROUNDS_TO_WIN) {
      lobby.state = 'ended';
      this.io.to(lobbyId).emit('match_over', {
        winnerId: shooter.id,
        winnerName: shooter.name,
        winnerTeam: shooter.team,
        scores: lobby.scores,
      });
      console.log(`[Lobby ${lobbyId}] Match over! ${shooter.name} wins ${lobby.scores[TEAMS.A]}-${lobby.scores[TEAMS.B]}`);
      return;
    }

    // Respawn BOTH players after 2 seconds for next round
    setTimeout(() => {
      for (const [id, p] of lobby.players) {
        const spawn = p.team === TEAMS.A ? SPAWN_A : SPAWN_B;
        p.position = { ...spawn };
        p.health = 100;
        p.alive = true;
        this.io.to(lobbyId).emit('player_respawn', {
          id: p.id,
          position: p.position,
        });
      }
      this.io.to(lobbyId).emit('round_start', {
        round: lobby.scores[TEAMS.A] + lobby.scores[TEAMS.B] + 1,
        scores: lobby.scores,
      });
    }, 2000);
  }

  onConnection(socket) {
    console.log(`[Connect] ${socket.id}`);

    socket.on('create_lobby', (data, callback) => {
      const lobbyId = uuidv4().slice(0, 6).toUpperCase();
      this.lobbies.set(lobbyId, {
        id: lobbyId,
        players: new Map(),
        state: 'waiting',
        scores: { [TEAMS.A]: 0, [TEAMS.B]: 0 },
        startTime: null,
      });
      console.log(`[Lobby] Created: ${lobbyId}`);
      callback({ lobbyId });
    });

    socket.on('join_lobby', ({ lobbyId, playerName }, callback) => {
      const lobby = this.lobbies.get(lobbyId);

      if (!lobby) {
        callback({ error: 'Lobby not found' });
        return;
      }
      if (lobby.players.size >= MAX_PLAYERS) {
        callback({ error: 'Lobby is full' });
        return;
      }

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
        weapon: 0,
        kills: 0,
        deaths: 0,
        lastInput: null,
      };

      lobby.players.set(socket.id, player);
      this.playerLobbyMap.set(socket.id, lobbyId);
      socket.join(lobbyId);

      socket.to(lobbyId).emit('player_joined', {
        id: player.id,
        name: player.name,
        team: player.team,
        position: player.position,
      });

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
        player: { id: player.id, name: player.name, team: player.team },
        existingPlayers,
        lobbyId,
      });
    });

    socket.on('player_input', (data) => {
      const lobbyId = this.playerLobbyMap.get(socket.id);
      if (!lobbyId) return;
      const lobby = this.lobbies.get(lobbyId);
      if (!lobby) return;
      const player = lobby.players.get(socket.id);
      if (!player) return;

      // Don't accept position updates from dead players — prevents stale
      // coords overwriting spawn position during the respawn delay
      if (!player.alive) return;

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
      if (!lobby || lobby.state === 'ended') return;
      const shooter = lobby.players.get(socket.id);
      if (!shooter || !shooter.alive) return;

      const weaponKeys = ['AR', 'PISTOL', 'KNIFE', 'GRENADE', 'SNIPER'];
      const weaponKey = weaponKeys[data.weapon] || 'AR';
      const weapon = WEAPONS[weaponKey];

      // Grenade AoE
      if (data.grenadeAoE && Array.isArray(data.hitPlayers)) {
        for (const hp of data.hitPlayers) {
          const target = lobby.players.get(hp.id);
          if (!target || !target.alive || target.team === shooter.team) continue;
          const damage = calculateDamage(weapon.damage, hp.distance, weapon.range, false);
          if (damage <= 0) continue;

          target.health -= damage;

          if (target.health <= 0) {
            this.handleKill(lobbyId, lobby, shooter, target, weapon.name);
          } else {
            this.io.to(target.id).emit('damage', {
              health: target.health,
              attackerId: shooter.id,
            });
          }
        }
      }

      // Raycast hit
      else if (data.hitPlayerId && data.distance !== undefined) {
        const target = lobby.players.get(data.hitPlayerId);
        if (target && target.alive && target.team !== shooter.team) {
          let damage = calculateDamage(weapon.damage, data.distance, weapon.range, weaponKey === 'SNIPER');
          let isBackstab = false;
          let isHeadshot = false;

          // Backstab
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

          // Headshot
          if (!isBackstab && data.headshot && (weaponKey === 'AR' || weaponKey === 'PISTOL' || weaponKey === 'SNIPER')) {
            if (weaponKey === 'SNIPER') {
              damage = 9999;
            } else {
              damage *= 1.5;
            }
            isHeadshot = true;
          }

          target.health -= damage;

          if (target.health <= 0) {
            const killWeapon = isBackstab ? 'BACKSTAB' : (isHeadshot ? weapon.name + ' HEADSHOT' : weapon.name);
            this.handleKill(lobbyId, lobby, shooter, target, killWeapon);
          } else {
            this.io.to(target.id).emit('damage', {
              health: target.health,
              attackerId: shooter.id,
            });
          }
        }
      }

      // Broadcast shot visual
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
    }
  }
}
