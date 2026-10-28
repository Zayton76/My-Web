
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
  zeroSeven: false,
  drawUntilPlayable: false,
  sixReaction: false,
  startingCards: 7
};

function shuffle(array) {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
  return array;
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

function drawCard(game) {
  if (game.deck.length === 0) {
    if (game.discard.length <= 1) return null;

    const top = game.discard.pop();
    game.deck = shuffle(game.discard.splice(0));
    game.discard = [top];
  }

  return game.deck.pop() || null;
}

function playable(game, card) {
  if (!card) return false;

  // +4 is allowed even if the player holds the current color.
  // During a pending penalty, it can only be stacked when
  // stacking is enabled and the pending penalty is also a +4.
  if (card.value === "Wild4") {
    if (game.pendingDraw > 0) {
      return game.settings.stacking &&
        game.pendingType === "Wild4";
    }

    return true;
  }

  if (game.pendingDraw > 0) {
    if (!game.settings.stacking) return false;

    if (game.pendingType === "Draw2") {
      return card.value === "Draw2";
    }

    if (game.pendingType === "Wild4") {
      return card.value === "Wild4";
    }

    return false;
  }

  const top = game.discard[game.discard.length - 1];

  return card.color === "wild" ||
    card.color === game.color ||
    card.value === top.value;
}

function publicState(room) {
  const game = room.game;

  return {
    code: room.code,
    hostId: room.hostId,
    settings: { ...room.settings },
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
      pendingDraw: game.pendingDraw,
      pendingType: game.pendingType,
      penaltyResponse: game.penaltyResponse,
      lastAction: game.lastAction,
      stacking: game.settings.stacking,
      zeroRotation: game.settings.zeroSeven,
      sevenSwap: game.settings.zeroSeven,
      drawing: game.drawing,
      drawnPlayable: !!game.drawnPlayableCard,
      sixReaction: game.sixReaction
        ? {
            active: game.sixReaction.active,
            pressed: [...game.sixReaction.pressed],
            endsAt: game.sixReaction.endsAt
          }
        : null
    } : null
  };
}

function sendState(room) {
  const state = publicState(room);

  for (const player of room.players) {
    const playerIndex = room.players.indexOf(player);

    io.to(player.id).emit("state", {
      ...state,
      hand: room.game ? room.game.hands[playerIndex] : []
    });
  }
}

function message(socket, text) {
  socket.emit("notice", text);
}

function findRoom(socketId) {
  return [...rooms.values()].find(room =>
    room.players.some(player => player.id === socketId)
  );
}

function nextTurn(game, amount = 1) {
  const count = game.hands.length;
  game.turn = (game.turn + amount * game.direction + count) % count;
}

function startGame(room) {
  const deck = makeDeck();
  const amount = room.settings.startingCards;

  const hands = room.players.map(() =>
    Array.from({ length: amount }, () => deck.pop())
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
    settings: { ...room.settings },
    sixReaction: null,
    sixTimer: null,
    penaltyResponse: null,

    // Automatic draw sequence controls.
    drawing: false,
    drawSequenceId: 0,
    drawnPlayableCard: null
  };

  if (first.value === "Skip" || first.value === "Reverse") {
    room.game.turn = 1 % room.players.length;
  }

  sendState(room);
}


function stopDrawing(game) {
  game.drawSequenceId++;
  game.drawing = false;
}

function hasPenaltyCounter(game, playerIndex) {
  if (!game.settings.stacking) return false;

  const hand = game.hands[playerIndex] || [];

  return hand.some(card =>
    (card.value === "Draw2" && game.pendingType === "Draw2") ||
    (card.value === "Wild4" && game.pendingType === "Wild4")
  );
}

function handlePendingPenalty(room) {
  const game = room.game;

  if (!game || game.winner || game.pendingDraw <= 0) return;

  const targetIndex = game.turn;

  if (hasPenaltyCounter(game, targetIndex)) {
    game.penaltyResponse = {
      playerIndex: targetIndex,
      amount: game.pendingDraw,
      type: game.pendingType
    };

    sendState(room);
  } else {
    game.penaltyResponse = null;
    drawPenalty(room, targetIndex, game.pendingDraw);
  }
}

async function drawPenalty(room, playerIndex, amount) {
  const game = room.game;
  if (!game || game.winner || game.drawing) return;

  game.drawing = true;
  const sequenceId = ++game.drawSequenceId;

  game.pendingDraw = 0;
  game.pendingType = null;

  sendState(room);

  for (let i = 0; i < amount; i++) {
    if (
      room.game !== game ||
      game.drawSequenceId !== sequenceId ||
      game.winner
    ) return;

    const card = drawCard(game);
    if (card) game.hands[playerIndex].push(card);

    sendState(room);

    if (i < amount - 1) {
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }

  if (
    room.game !== game ||
    game.drawSequenceId !== sequenceId
  ) return;

  game.drawing = false;
  nextTurn(game);
  sendState(room);
}

function finishSixReaction(room, penalizeIds = []) {
  const game = room.game;
  if (!game || !game.sixReaction) return;

  if (game.sixTimer) clearTimeout(game.sixTimer);
  game.sixTimer = null;

  for (const id of penalizeIds) {
    const playerIndex = room.players.findIndex(p => p.id === id);
    if (playerIndex < 0) continue;

    for (let i = 0; i < 2; i++) {
      const card = drawCard(game);
      if (card) game.hands[playerIndex].push(card);
    }
  }

  game.sixReaction = null;
  sendState(room);
}

function startSixReaction(room) {
  const game = room.game;
  if (!game || !game.settings.sixReaction) return;

  const playerIds = room.players.map(player => player.id);

  game.sixReaction = {
    active: true,
    pressed: [],
    playerIds,
    endsAt: Date.now() + 4000
  };

  game.sixTimer = setTimeout(() => {
    if (!room.game || !room.game.sixReaction) return;

    const reaction = room.game.sixReaction;
    const missed = reaction.playerIds.filter(id =>
      !reaction.pressed.includes(id)
    );

    finishSixReaction(room, missed);
  }, 4000);

  sendState(room);
}

function playCard(room, socket, index, chosenColor) {
  const game = room.game;
  if (!game || game.winner) return;

  if (game.sixReaction?.active) {
    return message(socket, "Wait until the 6 reaction finishes.");
  }

  if (game.drawing) {
    return message(socket, "Wait until automatic drawing finishes.");
  }

  const playerIndex = room.players.findIndex(p => p.id === socket.id);
  if (playerIndex < 0) return;

  const hand = game.hands[playerIndex];
  const card = hand[index];
  if (!card) return;

  // If automatic drawing found a playable card, that exact
  // card must be played before another action is allowed.
  if (
    game.drawnPlayableCard &&
    (playerIndex !== game.turn || card !== game.drawnPlayableCard)
  ) {
    return message(socket, "Play the playable card you just drew.");
  }

  const isTurn = playerIndex === game.turn;
  const top = game.discard[game.discard.length - 1];

  const isJumpIn = game.settings.jumpIn &&
    !isTurn &&
    !game.drawnPlayableCard &&
    card.color !== "wild" &&
    card.color === top.color &&
    card.value === top.value &&
    game.pendingDraw === 0;

  if (!isTurn && !isJumpIn) {
    return message(socket, "It isn't your turn.");
  }

  if (isJumpIn) game.turn = playerIndex;

  
if (
  game.pendingDraw > 0 &&
  (!game.penaltyResponse ||
    game.penaltyResponse.playerIndex !== playerIndex)
) {
  return message(socket, "You aren't allowed to respond to this penalty.");
}

if (!playable(game, card)) {
  return message(socket, "You can't play that card.");
}

if (card.color === "wild" && !COLORS.includes(chosenColor)) {
  return message(socket, "Choose a valid color.");
}

  hand.splice(index, 1);

  if (game.drawnPlayableCard === card) {
    game.drawnPlayableCard = null;
  }

  stopDrawing(game);

  game.discard.push(card);

  if (card.color === "wild") game.color = chosenColor;
  else game.color = card.color;

  game.lastAction = card.value;
  game.swapTarget = null;

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
  handlePendingPenalty(room);
  break;

case "Wild4":
  game.pendingDraw += 4;
  game.pendingType = "Wild4";
  nextTurn(game);
  handlePendingPenalty(room);
  break;


    case "7":
      if (game.settings.zeroSeven) {
        game.swapTarget = playerIndex;
      }
      nextTurn(game);
      break;

    case "0":
      if (game.settings.zeroSeven) {
        game.hands.push(game.hands.shift());
        room.players.push(room.players.shift());
        game.turn = room.players.findIndex(p => p.id === socket.id);
      }
      nextTurn(game);
      break;

    default:
      nextTurn(game);
      break;
  }

  if (card.value === "6" && game.settings.sixReaction) {
    startSixReaction(room);
  } else {
    sendState(room);
  }
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
      game: null,
      settings: { ...DEFAULT_SETTINGS }
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
    if (!room) return;

    if (room.hostId !== socket.id) {
      return message(socket, "Only the host can change modifiers.");
    }

    if (room.game) {
      return message(socket, "Modifiers can't be changed after the game starts.");
    }

    const input = incoming || {};

    for (const key of [
      "stacking",
      "jumpIn",
      "zeroSeven",
      "drawUntilPlayable",
      "sixReaction"
    ]) {
      if (typeof input[key] === "boolean") {
        room.settings[key] = input[key];
      }
    }

    if (Number.isInteger(Number(input.startingCards))) {
      room.settings.startingCards = Math.max(
        5,
        Math.min(25, Number(input.startingCards))
      );
    }

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

    if (room.game) return;

    startGame(room);
  });

  socket.on("playCard", ({ index, color } = {}) => {
    const room = findRoom(socket.id);
    if (room) playCard(room, socket, Number(index), color);
  });

  socket.on("drawCard", async () => {
    const room = findRoom(socket.id);
    if (!room || !room.game) return;

    const game = room.game;
    const playerIndex = room.players.findIndex(
      player => player.id === socket.id
    );

    if (playerIndex !== game.turn || game.winner) return;

    if (game.sixReaction?.active) {
      return message(socket, "Wait until the 6 reaction finishes.");
    }

    // Stops repeated clicks and overlapping draw sequences.
    if (game.drawing || game.drawnPlayableCard) return;

    // Accepting a pending penalty draws the entire accumulated
    // penalty. It is deliberately separate from normal drawing.
    if (game.pendingDraw > 0) {
  if (
    !game.penaltyResponse ||
    game.penaltyResponse.playerIndex !== playerIndex
  ) {
    return message(socket, "You can't accept this penalty right now.");
  }

  const amount = game.pendingDraw;
  game.penaltyResponse = null;

  await drawPenalty(room, playerIndex, amount);
  return;
}

    if (game.settings.drawUntilPlayable) {
      game.drawing = true;
      const sequenceId = ++game.drawSequenceId;

      sendState(room);

      while (
        room.game === game &&
        game.drawing &&
        game.drawSequenceId === sequenceId &&
        game.turn === playerIndex &&
        !game.winner
      ) {
        const card = drawCard(game);

        if (!card) break;

        game.hands[playerIndex].push(card);

        if (playable(game, card)) {
          game.drawnPlayableCard = card;
          game.drawing = false;
          sendState(room);
          return;
        }

        // Publish every card separately, then wait one second.
        sendState(room);
        await new Promise(resolve => setTimeout(resolve, 1000));
      }

      if (
        room.game === game &&
        game.drawSequenceId === sequenceId
      ) {
        game.drawing = false;
        game.drawnPlayableCard = null;
        nextTurn(game);
        sendState(room);
      }

      return;
    }

    // Normal draw: exactly one card, then advance the turn.
    const card = drawCard(game);
    if (card) game.hands[playerIndex].push(card);

    nextTurn(game);
    sendState(room);
  });

  socket.on("pressSix", () => {
    const room = findRoom(socket.id);
    if (!room || !room.game) return;

    const game = room.game;
    const reaction = game.sixReaction;

    if (!reaction?.active) return;
    if (!reaction.playerIds.includes(socket.id)) return;
    if (reaction.pressed.includes(socket.id)) return;

    reaction.pressed.push(socket.id);

    const remaining = reaction.playerIds.filter(id =>
      !reaction.pressed.includes(id)
    );

    if (remaining.length === 0) {
      finishSixReaction(room, []);
    } else if (remaining.length === 1) {
      finishSixReaction(room, remaining);
    } else {
      sendState(room);
    }
  });

  socket.on("swapHands", targetId => {
    const room = findRoom(socket.id);
    if (!room || !room.game) return;

    const game = room.game;
    const me = room.players.findIndex(p => p.id === socket.id);
    const target = room.players.findIndex(p => p.id === targetId);

    if (me !== game.turn || game.lastAction !== "7") return;
    if (!game.settings.zeroSeven) return;
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
      } else if (room.game.sixReaction?.active) {
        const reaction = room.game.sixReaction;
        reaction.pressed.push(socket.id);

        const remaining = reaction.playerIds.filter(id =>
          !reaction.pressed.includes(id)
        );

        if (remaining.length <= 1) {
          finishSixReaction(room, remaining);
        } else {
          sendState(room);
        }
      }
    }
  });
});

const PORT = process.env.PORT || 3000;

server.listen(PORT, "0.0.0.0", () => {
  console.log(`UNO server running on port ${PORT}`);
});
