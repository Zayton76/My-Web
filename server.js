
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");
const crypto = require("crypto");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, "public")));

const rooms = new Map();
const COLORS = ["red", "yellow", "green", "blue"];

function makeDeck() {
  const deck = [];

  for (const color of COLORS) {
    deck.push({ color, value: "0" });

    for (let n = 1; n <= 9; n++) {
      deck.push({ color, value: String(n) });
      deck.push({ color, value: String(n) });
    }

    for (const value of ["Skip", "Reverse", "Draw2"]) {
      deck.push({ color, value });
      deck.push({ color, value });
    }
  }

  for (let i = 0; i < 4; i++) {
    deck.push({ color: "wild", value: "Wild" });
    deck.push({ color: "wild", value: "Wild4" });
  }

  return shuffle(deck);
}

function shuffle(array) {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
  return array;
}

function drawCard(game) {
  if (game.deck.length === 0) {
    if (game.discard.length <= 1) return null;

    const top = game.discard.pop();
    game.deck = shuffle(game.discard.splice(0));
    game.discard = [top];
  }

  return game.deck.pop() || null;
}

function publicState(room) {
  const game = room.game;

  return {
    code: room.code,
    hostId: room.hostId,
    started: !!game,
    players: room.players.map((p, i) => ({
      id: p.id,
      name: p.name,
      count: game ? game.hands[i].length : 0,
      isTurn: !!game && game.turn === i
    })),
    game: game ? {
      turn: game.turn,
      direction: game.direction,
      top: game.discard[game.discard.length - 1],
      color: game.color,
      drawCount: game.deck.length,
      winner: game.winner,
      stacking: true,
      zeroRotation: true,
      sevenSwap: true
    } : null
  };
}

function sendState(room) {
  const state = publicState(room);

  for (const player of room.players) {
    io.to(player.id).emit("state", {
      ...state,
      hand: room.game
        ? room.game.hands[room.players.indexOf(player)]
        : []
    });
  }
}

function message(socket, text) {
  socket.emit("notice", text);
}

function startGame(room) {
  const deck = makeDeck();
  const hands = room.players.map(() =>
    Array.from({ length: 7 }, () => deck.pop())
  );

  let first = deck.pop();
  while (first && first.color === "wild") {
    deck.unshift(first);
    shuffle(deck);
    first = deck.pop();
  }

  room.game = {
    deck,
    hands,
    discard: [first],
    color: first.color,
    turn: 0,
    direction: 1,
    winner: null,
    pendingDraw: 0,
    lastAction: null
  };

  if (first.value === "Skip" || first.value === "Reverse") {
    room.game.turn = 1 % room.players.length;
  }

  sendState(room);
}

function nextTurn(game, amount = 1) {
  const count = game.hands.length;
  game.turn = (game.turn + amount * game.direction + count) % count;
}

function playable(game, card) {
  const top = game.discard[game.discard.length - 1];

  if (game.pendingDraw > 0) {
    if (game.pendingType === "Draw2") return card.value === "Draw2";
    if (game.pendingType === "Wild4") return card.value === "Wild4";
  }

  return card.color === "wild" ||
    card.color === game.color ||
    card.value === top.value;
}

function playCard(room, socket, index, chosenColor) {
  const game = room.game;
  if (!game || game.winner) return;

  const playerIndex = room.players.findIndex(p => p.id === socket.id);
  if (playerIndex !== game.turn) return message(socket, "It isn't your turn.");

  const hand = game.hands[playerIndex];
  const card = hand[index];

  if (!card) return;
  if (!playable(game, card)) return message(socket, "You can't play that card.");

  if (card.value === "Wild4") {
    const otherCards = hand.some(c =>
      c.color === game.color && c.color !== "wild"
    );

    if (otherCards) {
      return message(socket, "You can't play Wild Draw Four while holding a card of the current color.");
    }
  }

  if (card.color === "wild" && !COLORS.includes(chosenColor)) {
    return message(socket, "Choose a valid color.");
  }

  hand.splice(index, 1);
  game.discard.push(card);

  if (card.color === "wild") {
    game.color = chosenColor;
  } else {
    game.color = card.color;
  }

  game.lastAction = card.value;

  if (hand.length === 0) {
    game.winner = room.players[playerIndex].name;
    sendState(room);
    return;
  }

  switch (card.value) {
    case "Skip":
      nextTurn(game, 2);
      break;

    case "Reverse":
      if (room.players.length === 2) {
        nextTurn(game, 2);
      } else {
        game.direction *= -1;
        nextTurn(game);
      }
      break;

    case "Draw2":
      game.pendingDraw += 2;
      game.pendingType = "Draw2";
      nextTurn(game);
      break;

    case "Wild4":
      game.pendingDraw += 4;
      game.pendingType = "Wild4";
      nextTurn(game);
      break;

    case "7":
      game.swapTarget = playerIndex;
      nextTurn(game);
      break;

    case "0":
      game.hands.push(game.hands.shift());
      room.players.push(room.players.shift());
      game.turn = room.players.findIndex(p => p.id === socket.id);
      nextTurn(game);
      break;

    default:
      nextTurn(game);
  }

  sendState(room);
}

io.on("connection", socket => {
  socket.on("createRoom", name => {
    name = String(name || "").trim().slice(0, 16);
    if (!name) return message(socket, "Enter a nickname.");

    let code;
    do {
      code = crypto.randomBytes(3).toString("hex").toUpperCase();
    } while (rooms.has(code));

    const room = {
      code,
      hostId: socket.id,
      players: [{ id: socket.id, name }],
      game: null
    };

    rooms.set(code, room);
    socket.join(code);
    socket.emit("joined", code);
    sendState(room);
  });

  socket.on("joinRoom", ({ name, code } = {}) => {
    name = String(name || "").trim().slice(0, 16);
    code = String(code || "").trim().toUpperCase();
    const room = rooms.get(code);

    if (!name) return message(socket, "Enter a nickname.");
    if (!room) return message(socket, "Room not found.");
    if (room.game) return message(socket, "That game has already started.");
    if (room.players.length >= 4) return message(socket, "Room is full.");

    room.players.push({ id: socket.id, name });
    socket.join(code);
    socket.emit("joined", code);
    sendState(room);
  });

  socket.on("startGame", () => {
    const room = [...rooms.values()].find(r =>
      r.players.some(p => p.id === socket.id)
    );

    if (!room) return;
    if (room.hostId !== socket.id) return message(socket, "Only the host can start.");
    if (room.players.length < 2) return message(socket, "You need at least 2 players.");

    startGame(room);
  });

  socket.on("playCard", ({ index, color } = {}) => {
    const room = [...rooms.values()].find(r =>
      r.players.some(p => p.id === socket.id)
    );
    if (room) playCard(room, socket, Number(index), color);
  });

  socket.on("drawCard", () => {
    const room = [...rooms.values()].find(r =>
      r.players.some(p => p.id === socket.id)
    );

    if (!room || !room.game) return;
    const game = room.game;
    const playerIndex = room.players.findIndex(p => p.id === socket.id);

    if (playerIndex !== game.turn || game.winner) return;

    const amount = game.pendingDraw || 1;

    for (let i = 0; i < amount; i++) {
      const card = drawCard(game);
      if (card) game.hands[playerIndex].push(card);
    }

    game.pendingDraw = 0;
    game.pendingType = null;
    nextTurn(game);
    sendState(room);
  });

  socket.on("swapHands", targetId => {
    const room = [...rooms.values()].find(r =>
      r.players.some(p => p.id === socket.id)
    );
    if (!room || !room.game) return;

    const game = room.game;
    const me = room.players.findIndex(p => p.id === socket.id);
    const target = room.players.findIndex(p => p.id === targetId);

    if (me !== game.turn || game.lastAction !== "7") return;
    if (target < 0 || target === me) return;

    [game.hands[me], game.hands[target]] =
      [game.hands[target], game.hands[me]];

    game.lastAction = null;
    sendState(room);
  });

  socket.on("disconnect", () => {
    for (const [code, room] of rooms) {
      const index = room.players.findIndex(p => p.id === socket.id);
      if (index < 0) continue;

      if (!room.game) {
        room.players.splice(index, 1);

        if (room.players.length === 0) {
          rooms.delete(code);
          continue;
        }

        if (room.hostId === socket.id) room.hostId = room.players[0].id;
        sendState(room);
      } else {
        message(socket, "You disconnected from the game.");
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, "0.0.0.0", () => {
  console.log(`UNO server running on port ${PORT}`);
});
