
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

const DEFAULT_SETTINGS = {
  stacking: false,
  jumpIn: false,
  sevenZero: false,
  drawUntilPlayable: false,
  startingHand: 7,
  sixReaction: false
};

function cleanSettings(input = {}) {
  return {
    stacking: !!input.stacking,
    jumpIn: !!input.jumpIn,
    sevenZero: !!input.sevenZero,
    drawUntilPlayable: !!input.drawUntilPlayable,
    startingHand: Math.max(
      5,
      Math.min(25, Math.floor(Number(input.startingHand) || 7))
    ),
    sixReaction: !!input.sixReaction
  };
}

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

function findRoom(socketId) {
  return [...rooms.values()].find(room =>
    room.players.some(player => player.id === socketId)
  );
}

function publicState(room) {
  const game = room.game;

  return {
    code: room.code,
    hostId: room.hostId,
    started: !!game,
    settings: { ...room.settings },
    players: room.players.map((player, index) => ({
      id: player.id,
      name: player.name,
      count: game ? game.hands[index].length : 0,
      isTurn: !!game && game.turn === index,
      isHost: player.id === room.hostId
    })),
    game: game ? {
      turn: game.turn,
      direction: game.direction,
      top: game.discard[game.discard.length - 1],
      color: game.color,
      drawCount: game.deck.length,
      winner: game.winner,
      pendingDraw: game.pendingDraw,
      pendingType: game.pendingType,
      reaction: game.reaction ? {
        active: true,
        cardValue: "6",
        waitingFor: [...game.reaction.waitingFor],
        pressed: [...game.reaction.pressed],
        deadline: game.reaction.deadline
      } : null,
      swapTarget: game.swapTarget,
      lastAction: game.lastAction
    } : null
  };
}

function sendState(room) {
  const state = publicState(room);

  for (const player of room.players) {
    const playerIndex = room.players.findIndex(p => p.id === player.id);

    io.to(player.id).emit("state", {
      ...state,
      hand: room.game ? room.game.hands[playerIndex] : []
    });
  }
}

function message(socket, text) {
  socket.emit("notice", text);
}

function nextTurn(game, amount = 1) {
  const count = game.hands.length;
  game.turn = (
    game.turn + amount * game.direction + count * 10
  ) % count;
}

function playable(game, card) {
  const top = game.discard[game.discard.length - 1];

  if (game.pendingDraw > 0) {
    if (game.pendingType === "Draw2") {
      return card.value === "Draw2";
    }

    if (game.pendingType === "Wild4") {
      return card.value === "Wild4";
    }
  }

  return card.color === "wild" ||
    card.color === game.color ||
    card.value === top.value;
}

function hasPlayableCard(game, hand) {
  return hand.some(card => playable(game, card));
}

function cancelReaction(game) {
  if (game.reaction?.timer) {
    clearTimeout(game.reaction.timer);
  }

  game.reaction = null;
}

function finishReaction(room) {
  const game = room.game;
  if (!game?.reaction) return;

  const reaction = game.reaction;
  const remaining = reaction.waitingFor.filter(
    id => !reaction.pressed.includes(id)
  );

  cancelReaction(game);

  if (remaining.length) {
    const loserId = remaining[0];
    const loserIndex = room.players.findIndex(p => p.id === loserId);

    if (loserIndex >= 0) {
      for (let i = 0; i < 2; i++) {
        const card = drawCard(game);
        if (card) game.hands[loserIndex].push(card);
      }

      io.to(loserId).emit(
        "notice",
        "You were last to react to the 6! Draw 2 cards."
      );
    }
  }

  sendState(room);
}

function beginReaction(room) {
  const game = room.game;

  if (!room.settings.sixReaction || room.players.length < 2) {
    return false;
  }

  cancelReaction(game);

  game.reaction = {
    waitingFor: room.players.map(player => player.id),
    pressed: [],
    deadline: Date.now() + 5000,
    timer: null
  };

  game.reaction.timer = setTimeout(() => {
    finishReaction(room);
  }, 5000);

  return true;
}

function startGame(room) {
  const deck = makeDeck();
  const handSize = room.settings.startingHand;

  if (deck.length < room.players.length * handSize + 1) {
    return;
  }

  const hands = room.players.map(() =>
    Array.from({ length: handSize }, () => deck.pop())
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
    pendingType: null,
    lastAction: null,
    swapTarget: null,
    reaction: null
  };

  if (first.value === "Skip" || first.value === "Reverse") {
    room.game.turn = 1 % room.players.length;
  }

  sendState(room);
}

function playCard(room, socket, index, chosenColor) {
  const game = room.game;
  if (!game || game.winner) return;
  if (game.reaction) {
    return message(socket, "Wait until the 6 reaction finishes.");
  }

  const playerIndex = room.players.findIndex(p => p.id === socket.id);
  if (playerIndex < 0) return;

  const hand = game.hands[playerIndex];
  const card = hand[index];

  if (!card) return;

  const isJumpIn = room.settings.jumpIn &&
    playerIndex !== game.turn &&
    card.color === game.discard[game.discard.length - 1].color &&
    card.value === game.discard[game.discard.length - 1].value;

  if (playerIndex !== game.turn && !isJumpIn) {
    return message(socket, "It isn't your turn.");
  }

  if (playerIndex === game.turn && !playable(game, card)) {
    return message(socket, "You can't play that card.");
  }

  if (playerIndex !== game.turn && game.pendingDraw > 0) {
    return message(socket, "You can't Jump-In while a draw penalty is pending.");
  }

  if (card.value === "Wild4") {
    const otherCards = hand.some(c =>
      c.color === game.color && c.color !== "wild"
    );

    if (otherCards) {
      return message(
        socket,
        "You can't play Wild Draw Four while holding a card of the current color."
      );
    }
  }

  if (card.color === "wild" && !COLORS.includes(chosenColor)) {
    return message(socket, "Choose a valid color.");
  }

  if (isJumpIn) {
    game.turn = playerIndex;
  }

  hand.splice(index, 1);
  game.discard.push(card);

  game.color = card.color === "wild" ? chosenColor : card.color;
  game.lastAction = card.value;
  game.swapTarget = null;

  if (hand.length === 0) {
    game.winner = room.players[playerIndex].name;
    cancelReaction(game);
    sendState(room);
    return;
  }

  if (card.value === "6" && beginReaction(room)) {
    nextTurn(game);
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
      if (room.settings.stacking) {
        game.pendingDraw += 2;
        game.pendingType = "Draw2";
      } else {
        const target = (game.turn + game.direction + room.players.length) %
          room.players.length;

        for (let i = 0; i < 2; i++) {
          const drawn = drawCard(game);
          if (drawn) game.hands[target].push(drawn);
        }

        nextTurn(game, 2);
        sendState(room);
        return;
      }
      nextTurn(game);
      break;

    case "Wild4":
      if (room.settings.stacking) {
        game.pendingDraw += 4;
        game.pendingType = "Wild4";
      } else {
        const target = (game.turn + game.direction + room.players.length) %
          room.players.length;

        for (let i = 0; i < 4; i++) {
          const drawn = drawCard(game);
          if (drawn) game.hands[target].push(drawn);
        }

        nextTurn(game, 2);
        sendState(room);
        return;
      }
      nextTurn(game);
      break;

    case "7":
      if (room.settings.sevenZero) {
        game.swapTarget = playerIndex;
      }
      nextTurn(game);
      break;

    case "0":
      if (room.settings.sevenZero) {
        game.hands.push(game.hands.shift());
        room.players.push(room.players.shift());
        game.turn = room.players.findIndex(p => p.id === socket.id);
      }
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
      settings: { ...DEFAULT_SETTINGS },
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

  socket.on("updateSettings", incoming => {
    const room = findRoom(socket.id);

    if (!room || room.game) return;
    if (room.hostId !== socket.id) {
      return message(socket, "Only the host can change room settings.");
    }

    room.settings = cleanSettings(incoming);
    sendState(room);
  });

  socket.on("startGame", () => {
    const room = findRoom(socket.id);

    if (!room) return;
    if (room.hostId !== socket.id) {
      return message(socket, "Only the host can start.");
    }
    if (room.players.length < 2) {
      return message(socket, "You need at least 2 players.");
    }

    startGame(room);
  });

  socket.on("playCard", ({ index, color } = {}) => {
    const room = findRoom(socket.id);
    if (room) playCard(room, socket, Number(index), color);
  });

  socket.on("drawCard", () => {
    const room = findRoom(socket.id);
    if (!room?.game) return;

    const game = room.game;
    const playerIndex = room.players.findIndex(p => p.id === socket.id);

    if (playerIndex !== game.turn || game.winner) return;
    if (game.reaction) return message(socket, "Wait for the 6 reaction.");

    if (game.pendingDraw > 0) {
      const amount = game.pendingDraw;

      for (let i = 0; i < amount; i++) {
        const card = drawCard(game);
        if (card) game.hands[playerIndex].push(card);
      }

      game.pendingDraw = 0;
      game.pendingType = null;
      nextTurn(game);
      sendState(room);
      return;
    }

    if (room.settings.drawUntilPlayable) {
      let safety = 0;

      while (!hasPlayableCard(game, game.hands[playerIndex]) &&
             game.deck.length > 0 && safety < 500) {
        const card = drawCard(game);
        if (!card) break;

        game.hands[playerIndex].push(card);
        safety++;
      }
    } else {
      const card = drawCard(game);
      if (card) game.hands[playerIndex].push(card);
    }

    nextTurn(game);
    sendState(room);
  });

  socket.on("reactToSix", () => {
    const room = findRoom(socket.id);
    if (!room?.game?.reaction) return;

    const reaction = room.game.reaction;

    if (!reaction.waitingFor.includes(socket.id)) return;
    if (reaction.pressed.includes(socket.id)) return;

    reaction.pressed.push(socket.id);

    const everyonePressed = reaction.waitingFor.every(id =>
      reaction.pressed.includes(id)
    );

    if (everyonePressed) {
      cancelReaction(room.game);
      sendState(room);
      return;
    }

    sendState(room);
  });

  socket.on("swapHands", targetId => {
    const room = findRoom(socket.id);
    if (!room?.game) return;

    const game = room.game;
    const me = room.players.findIndex(p => p.id === socket.id);
    const target = room.players.findIndex(p => p.id === targetId);

    if (me !== game.turn || game.lastAction !== "7") return;
    if (!room.settings.sevenZero) return;
    if (target < 0 || target === me) return;

    [game.hands[me], game.hands[target]] =
      [game.hands[target], game.hands[me]];

    game.lastAction = null;
    game.swapTarget = null;
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

        if (room.hostId === socket.id) {
          room.hostId = room.players[0].id;
        }

        sendState(room);
      } else if (room.game.reaction) {
        const reaction = room.game.reaction;
        reaction.waitingFor = reaction.waitingFor.filter(id => id !== socket.id);
        reaction.pressed = reaction.pressed.filter(id => id !== socket.id);

        if (reaction.waitingFor.every(id => reaction.pressed.includes(id))) {
          cancelReaction(room.game);
        }

        sendState(room);
      }
    }
  });
});

const PORT = process.env.PORT || 3000;

server.listen(PORT, "0.0.0.0", () => {
  console.log(`UNO server running on port ${PORT}`);
});
